import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { approveVersion, generateKeys } from "../../sync/src/signing";
import type { Config, Fetcher } from "../../sync/src/sync";
import { createHandler, type Deps } from "../src/server";
import { fileAudit } from "../src/audit";
import { JobRunner } from "../src/jobs";
import { hashPassword, LoginLimiter, setPassword, verifyHash, checkLogin } from "../src/auth/password";
import { SessionStore } from "../src/auth/session";
import { mtlsAuthenticator } from "../src/auth/mtls";
import { validateConfig } from "../src/config";
import { APP_JS } from "../src/ui";

const PASSWORD = "correct horse battery";
const manifest = (v: string) => JSON.stringify({ id: "demo", name: "Demo", version: v, minAppVersion: "1.5.0", description: "d", author: "a" });

/** Mock GitHub: one repo with the given release tags. `gate` lets a test hold the sync open. */
function mockFetcher(tags: string[], gate?: Promise<void>): Fetcher {
  return async (url) => {
    if (gate) await gate;
    if (url.includes("/releases"))
      return new Response(JSON.stringify(tags.map((t) => ({
        tag_name: t, draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z",
        assets: ["main.js", "manifest.json"].map((n) => ({ name: n, url: `http://gh/asset/${t}/${n}` })),
      }))));
    const m = /asset\/(.+)\/(.+)$/.exec(url)!;
    return new Response(m[2] === "manifest.json" ? manifest(m[1]) : `code-${m[1]}`);
  };
}

const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

async function start(over: Partial<Deps> & { review?: boolean; tags?: string[]; gate?: Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "om-admin-"));
  const keys = generateKeys();
  const usersFile = join(dir, "users.json");
  await setPassword(usersFile, "alice", PASSWORD);
  const outDir = join(dir, "registry");
  const rc: Config = { githubApiBase: "http://gh/api", outDir, repos: [{ repo: "o/r" }], ...(over.review ? { review: { enabled: true } as Config["review"] } : {}) };
  const audit = join(dir, "audit.jsonl");
  const sessions = new SessionStore();
  const deps: Deps = {
    cfg: { registryConfig: "x", auditLog: audit, password: { usersFile }, allowInsecureHttp: true },
    loadRegistryConfig: async () => rc, publicKey: keys.publicSpkiB64, audit: fileAudit(audit), authenticators: [],
    password: { usersFile, sessions, limiter: new LoginLimiter() }, jobs: new JobRunner(), env: { GH_TOKEN: "ghp_SECRETSECRETSECRETSECRET" },
    fetcher: mockFetcher(over.tags ?? ["1.0.0"], over.gate), secure: false, ...over,
  };
  const server = createServer(createHandler(deps));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string>; method?: string } = {}) => {
    const post = o.body !== undefined || o.method === "POST";
    const r = await fetch(base + path, {
      method: post ? "POST" : "GET",
      headers: { ...(post ? { "Content-Type": "application/json", "X-OM-Admin": "1" } : {}), ...(o.cookie ? { Cookie: o.cookie } : {}), ...o.headers },
      body: post ? JSON.stringify(o.body ?? {}) : undefined,
    });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, data, text, headers: r.headers };
  };
  const login = async () => {
    const r = await call("/api/login", { body: { name: "alice", password: PASSWORD } });
    return (r.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const waitJob = async (id: string, cookie: string) => {
    for (let i = 0; i < 100; i++) {
      const j = await call(`/api/jobs/${id}`, { cookie });
      if (j.data.status !== "running") return j.data;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("job did not finish");
  };
  return { base, call, login, waitJob, deps, audit, keys, outDir, sessions };
}

describe("authentication and request safety", () => {
  it("refuses unauthenticated API access and records the attempt", async () => {
    const s = await start();
    expect((await s.call("/api/plugins")).status).toBe(401);
    expect((await s.call("/api/sync", { method: "POST" })).status).toBe(401);
    const me = await s.call("/api/me");
    expect(me.status).toBe(401);
    expect(me.data.passwordLogin).toBe(true);
    expect(await readFile(s.audit, "utf8")).toMatch(/"action":"denied"/);
  });

  it("password login: wrong password fails, right one sets a hardened session cookie", async () => {
    const s = await start({ secure: true });
    expect((await s.call("/api/login", { body: { name: "alice", password: "wrong wrong wrong" } })).status).toBe(401);
    expect((await s.call("/api/login", { body: { name: "nobody", password: PASSWORD } })).status).toBe(401);
    const ok = await s.call("/api/login", { body: { name: "alice", password: PASSWORD } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Secure/);
    expect((await s.call("/api/me", { cookie: cookie.split(";")[0] })).data).toMatchObject({ name: "alice", method: "password" });
    const log = await readFile(s.audit, "utf8");
    expect(log).toMatch(/login.failed/);
    expect(log).toMatch(/login.ok/);
    expect(log).not.toContain(PASSWORD);
  });

  it("locks out after repeated failures, even for the right password", async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) await s.call("/api/login", { body: { name: "alice", password: "bad bad bad bad" } });
    const r = await s.call("/api/login", { body: { name: "alice", password: PASSWORD } });
    expect(r.status).toBe(429);
  });

  it("sessions expire when idle and after logout", async () => {
    let t = 0;
    const sessions = new SessionStore(1000, 10_000, () => t);
    const id = sessions.create("alice");
    expect(sessions.get(id)?.name).toBe("alice");
    t = 2000;
    expect(sessions.get(id)).toBeNull();
    const s = await start();
    const cookie = await s.login();
    expect((await s.call("/api/logout", { cookie, method: "POST" })).status).toBe(200);
    expect((await s.call("/api/me", { cookie })).status).toBe(401);
  });

  it("rejects state-changing requests without the custom header or from another origin", async () => {
    const s = await start();
    const cookie = await s.login();
    const noHeader = await fetch(s.base + "/api/sync", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
    const cross = await s.call("/api/sync", { cookie, method: "POST", headers: { Origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    expect(s.deps.jobs.list()).toHaveLength(0);
  });

  it("serves a UI with a strict CSP and no HTML injection sinks", async () => {
    const s = await start();
    const r = await s.call("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    expect(r.text).not.toMatch(/<script>[^<]/); // no inline script
    expect(APP_JS).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});

describe("admin actions", () => {
  it("sync job mirrors a release and the listing shows review/approval state verified with the public key", async () => {
    const s = await start();
    const cookie = await s.login();
    const start1 = await s.call("/api/sync", { cookie, method: "POST" });
    expect(start1.status).toBe(202);
    const job = await s.waitJob(start1.data.job.id, cookie);
    expect(job.status).toBe("done");
    expect(job.output.join("\n")).toMatch(/added 1/);

    let list = await s.call("/api/plugins", { cookie });
    expect(list.data.plugins[0]).toMatchObject({ id: "demo" });
    expect(list.data.plugins[0].versions[0]).toMatchObject({ version: "1.0.0", staged: false, approval: null });

    await approveVersion(s.outDir, "demo", "1.0.0", s.keys.privatePem, "tester", "test");
    list = await s.call("/api/plugins", { cookie });
    expect(list.data.plugins[0].versions[0].approval).toMatchObject({ ok: true, by: "tester" });

    // an approval signed by some other key must show as invalid, not as approved
    const other = generateKeys();
    await approveVersion(s.outDir, "demo", "1.0.0", other.privatePem, "mallory", "test");
    list = await s.call("/api/plugins", { cookie });
    expect(list.data.plugins[0].versions[0].approval.ok).toBe(false);
    expect(await readFile(s.audit, "utf8")).toMatch(/"action":"sync.start"/);
  });

  it("allows one job at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = await start({ gate });
    const cookie = await s.login();
    const first = await s.call("/api/sync", { cookie, method: "POST" });
    expect(first.status).toBe(202);
    const second = await s.call("/api/sync", { cookie, method: "POST" });
    expect(second.status).toBe(409);
    release();
    expect((await s.waitJob(first.data.job.id, cookie)).status).toBe("done");
  });

  it("review needs a configured review section and valid targets", async () => {
    const s = await start();
    const cookie = await s.login();
    expect((await s.call("/api/review", { cookie, body: { all: true } })).status).toBe(400);
    const s2 = await start({ review: true });
    const c2 = await s2.login();
    expect((await s2.call("/api/review", { cookie: c2, body: { id: "../x", version: "1.0.0" } })).status).toBe(400);
    expect((await s2.call("/api/review", { cookie: c2, body: {} })).status).toBe(400);
  });

  it("never exposes tokens or key material in responses or the audit log", async () => {
    const s = await start();
    const cookie = await s.login();
    const j = await s.call("/api/sync", { cookie, method: "POST" });
    await s.waitJob(j.data.job.id, cookie);
    const bodies = [(await s.call("/api/plugins", { cookie })).text, (await s.call("/api/jobs", { cookie })).text, (await s.call(`/api/jobs/${j.data.job.id}`, { cookie })).text, await readFile(s.audit, "utf8")];
    for (const b of bodies) { expect(b).not.toContain("ghp_SECRET"); expect(b).not.toContain("PRIVATE KEY"); expect(b).not.toContain(PASSWORD); }
  });
});

describe("password storage", () => {
  it("stores a salted scrypt hash, verifies in constant shape, and enforces a minimum length", async () => {
    const h1 = await hashPassword("some long password"), h2 = await hashPassword("some long password");
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$/);
    expect(await verifyHash("some long password", h1)).toBe(true);
    expect(await verifyHash("some long passworD", h1)).toBe(false);
    expect(await verifyHash("x", "garbage")).toBe(false);
    const f = join(await mkdtemp(join(tmpdir(), "om-u-")), "users.json");
    await expect(setPassword(f, "bob", "short")).rejects.toThrow(/12 characters/);
    await expect(setPassword(f, "../bob", PASSWORD)).rejects.toThrow(/user names/);
    await setPassword(f, "bob", PASSWORD);
    expect(await readFile(f, "utf8")).not.toContain(PASSWORD);
    expect(await checkLogin(f, "bob", PASSWORD)).toBe("bob");
    expect(await checkLogin(f, "constructor", PASSWORD)).toBeNull();
    expect(await checkLogin(f, "bob", "nope nope nope nope")).toBeNull();
  });

  it("limiter locks per key and recovers after the lockout", () => {
    let t = 0;
    const l = new LoginLimiter(3, 1000, 5000, () => t);
    l.fail("k"); l.fail("k");
    expect(l.locked("k")).toBe(false);
    l.fail("k");
    expect(l.locked("k")).toBe(true);
    expect(l.locked("other")).toBe(false);
    t = 6000;
    expect(l.locked("k")).toBe(false);
  });
});

describe("mTLS authenticator", () => {
  const req = (o: { encrypted?: boolean; authorized?: boolean; cn?: string; fp?: string }) =>
    ({ socket: { encrypted: o.encrypted ?? true, authorized: o.authorized ?? true, getPeerCertificate: () => ({ subject: o.cn ? { CN: o.cn } : undefined, fingerprint256: o.fp }) } }) as never;

  it("admits only verified certificates that are on the allowlist", () => {
    const a = mtlsAuthenticator(["alice", "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"]);
    expect(a.authenticate(req({ cn: "alice" }))).toEqual({ name: "alice", method: "mtls" });
    expect(a.authenticate(req({ cn: "mallory" }))).toBeNull();
    expect(a.authenticate(req({ cn: "alice", authorized: false }))).toBeNull(); // chain not verified by TLS layer
    expect(a.authenticate(req({ cn: "alice", encrypted: false }))).toBeNull();
    expect(a.authenticate(req({ cn: "other", fp: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" }))?.method).toBe("mtls");
    expect(mtlsAuthenticator([]).authenticate(req({ cn: "alice" }))).toBeNull(); // valid cert alone is not authorisation
  });
});

describe("config validation", () => {
  const base = { registryConfig: "r.json", auditLog: "a.log" };
  it("fails closed", () => {
    expect(validateConfig({ ...base, password: { usersFile: "u" } }).join()).toMatch(/tls/);
    expect(validateConfig({ ...base, allowInsecureHttp: true, password: { usersFile: "u" } })).toEqual([]);
    expect(validateConfig({ ...base, tls: { cert: "c", key: "k" }, mtls: { allow: ["a"] } }).join()).toMatch(/clientCa/);
    expect(validateConfig({ ...base, tls: { cert: "c", key: "k", clientCa: "ca" }, mtls: { allow: [] } }).join()).toMatch(/empty/);
    expect(validateConfig({ ...base, tls: { cert: "c", key: "k" } }).join()).toMatch(/at least one/);
  });
});
