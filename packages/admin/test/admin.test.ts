import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { NoteStore } from "../src/notes";
import { RepoStore } from "../src/repos";
import { queueSigner } from "../../sync/src/signer";
import { processQueue, touchHeartbeat } from "../../sync/src/workqueue";
import { buildApproval } from "../../sync/src/signing";
import { signerHandler } from "../../sync/src/signer";

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

describe("withdraw, release and triage notes", () => {
  it("withdraw runs as an audited job, removes the approval and holds the version back", async () => {
    const s = await start();
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    await approveVersion(s.outDir, "demo", "1.0.0", s.keys.privatePem, "tester", "test");
    let v = (await s.call("/api/plugins", { cookie })).data.plugins[0];
    expect(v.repo).toBe("o/r");
    expect(v.versions[0].approval.ok).toBe(true);

    const r = await s.call("/api/manage", { cookie, body: { action: "withdraw", id: "demo", version: "1.0.0" } });
    expect(r.status).toBe(202);
    const job = await s.waitJob(r.data.job.id, cookie);
    expect(job.status).toBe("done");
    expect(job.output.join(" ")).toMatch(/approval removed, held back/);
    v = (await s.call("/api/plugins", { cookie })).data.plugins[0];
    expect(v.versions[0]).toMatchObject({ staged: true, approval: null });
    expect(await readFile(s.audit, "utf8")).toMatch(/"action":"manage.withdraw"/);

    const rel = await s.call("/api/manage", { cookie, body: { action: "release", id: "demo", version: "1.0.0" } });
    expect((await s.waitJob(rel.data.job.id, cookie)).status).toBe("done");
    expect((await s.call("/api/plugins", { cookie })).data.plugins[0].versions[0].staged).toBe(false);
  });

  it("manage needs a login, the custom header, and valid input", async () => {
    const s = await start();
    expect((await s.call("/api/manage", { method: "POST", body: { action: "hold", id: "demo", version: "1.0.0" } })).status).toBe(401);
    const cookie = await s.login();
    const noHeader = await fetch(s.base + "/api/manage", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
    expect((await s.call("/api/manage", { cookie, body: { action: "delete", id: "demo", version: "1.0.0" } })).status).toBe(400);
    expect((await s.call("/api/manage", { cookie, body: { action: "hold", id: "../x", version: "1.0.0" } })).status).toBe(400);
    expect(s.deps.jobs.list()).toHaveLength(0);
  });

  it("a failed manage action shows up as a failed job with the reason", async () => {
    const s = await start();
    const cookie = await s.login();
    const r = await s.call("/api/manage", { cookie, body: { action: "hold", id: "demo", version: "1.0.0" } });
    const job = await s.waitJob(r.data.job.id, cookie);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/not in the registry/);
  });

  it("notes: 404 when disabled; when enabled they are shared, audited without their text, and validated", async () => {
    const off = await start();
    expect((await off.call("/api/notes", { cookie: await off.login() })).status).toBe(404);

    const dir = await mkdtemp(join(tmpdir(), "om-notes-"));
    const s = await start({ notes: new NoteStore(join(dir, "notes.jsonl")) });
    expect((await s.call("/api/notes")).status).toBe(401);
    const cookie = await s.login();
    const created = await s.call("/api/notes", { cookie, body: { plugin: "demo", version: "1.0.0", text: "waiting on the maintainer, private detail XYZ", ref: "SEC-9" } });
    expect(created.status).toBe(201);
    const list = await s.call("/api/notes", { cookie });
    expect(list.data.notes).toHaveLength(1);
    expect(list.data.notes[0]).toMatchObject({ plugin: "demo", version: "1.0.0", by: "alice", ref: "SEC-9" });
    const audit = await readFile(s.audit, "utf8");
    expect(audit).toMatch(/"action":"note.add"/);
    expect(audit).not.toContain("XYZ");
    expect((await s.call("/api/notes", { cookie, body: { plugin: "demo", version: "1.0.0", text: "" } })).status).toBe(400);
    expect((await s.call("/api/notes", { cookie, body: { plugin: "../x", version: "1.0.0", text: "hi" } })).status).toBe(400);
    const noHeader = await fetch(s.base + "/api/notes", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
  });
});

/** Runs a signer worker loop on a temp queue with the given request handler, like the signer container does. */
async function withSigner(s: Awaited<ReturnType<typeof start>>, handle: (req: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const queue = await mkdtemp(join(tmpdir(), "om-signq-"));
  await touchHeartbeat(queue);
  s.deps.signer = queueSigner(queue, { pollMs: 20 });
  let stop = false;
  const loop = (async () => { while (!stop) { await processQueue(queue, handle); await new Promise((r) => setTimeout(r, 20)); } })();
  return async () => { stop = true; await loop; };
}
const honest = (s: Awaited<ReturnType<typeof start>>) => signerHandler(s.outDir, s.keys.privatePem, () => {});

describe("approving through the signer", () => {
  it("signs through the queue, verifies the answer, writes the approval and audits it with the reason", async () => {
    const s = await start();
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    const stop = await withSigner(s, honest(s));
    expect((await s.call("/api/plugins", { cookie })).data.canApprove).toBe(true);
    const r = await s.call("/api/approve", { cookie, body: { id: "demo", version: "1.0.0", override: "checked with the vendor" } });
    expect(r.status).toBe(202);
    const job = await s.waitJob(r.data.job.id, cookie);
    expect(job.status).toBe("done");
    expect(job.output.join(" ")).toMatch(/approved demo@1.0.0 by alice/);
    const v = (await s.call("/api/plugins", { cookie })).data.plugins[0].versions[0];
    expect(v.approval).toMatchObject({ ok: true, by: "alice", override: "checked with the vendor" });
    const audit = await readFile(s.audit, "utf8");
    expect(audit).toMatch(/"action":"approve.start"/);
    expect(audit).toMatch(/"action":"approve","[^\n]*"target":"demo@1.0.0"[^\n]*"override":"checked with the vendor"/);
    await stop();
  });

  it("refuses a signer that signs with the wrong key, and writes nothing", async () => {
    const s = await start();
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    const wrong = generateKeys();
    const stop = await withSigner(s, signerHandler(s.outDir, wrong.privatePem, () => {}));
    const job = await s.waitJob((await s.call("/api/approve", { cookie, body: { id: "demo", version: "1.0.0", override: "x" } })).data.job.id, cookie);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/did not verify/);
    expect((await s.call("/api/plugins", { cookie })).data.plugins[0].versions[0].approval).toBeNull();
    expect(await readFile(s.audit, "utf8")).toMatch(/"action":"approve.failed"/);
    await stop();
  });

  it("refuses an approval that names a different approver than the logged-in admin", async () => {
    const s = await start();
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    const stop = await withSigner(s, async (req) => {
      const b = await buildApproval(s.outDir, String(req.id), String(req.version), s.keys.privatePem, "mallory", "x");
      return { approval: b.bytes.toString("utf8"), sig: b.sig };
    });
    const job = await s.waitJob((await s.call("/api/approve", { cookie, body: { id: "demo", version: "1.0.0", override: "x" } })).data.job.id, cookie);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/different approver/);
    expect((await s.call("/api/plugins", { cookie })).data.plugins[0].versions[0].approval).toBeNull();
    await stop();
  });

  it("is off without a signer, fails fast with the signer down, and validates input", async () => {
    const s = await start();
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    expect((await s.call("/api/plugins", { cookie })).data.canApprove).toBe(false);
    expect((await s.call("/api/approve", { cookie, body: { id: "demo", version: "1.0.0" } })).status).toBe(404);
    s.deps.signer = queueSigner(await mkdtemp(join(tmpdir(), "om-signq-")), { staleMs: 1000 });
    const down = await s.call("/api/approve", { cookie, body: { id: "demo", version: "1.0.0", override: "x" } });
    expect(down.status).toBe(503);
    expect(down.data.error).toMatch(/signer container is not running/);
    expect((await s.call("/api/approve", { cookie, body: { id: "../x", version: "1.0.0" } })).status).toBe(400);
    expect((await s.call("/api/approve", { cookie, body: { id: "demo", version: "1.0.0", override: "y".repeat(301) } })).status).toBe(400);
    expect((await s.call("/api/approve", { method: "POST", body: { id: "demo", version: "1.0.0" } })).status).toBe(401);
    const noHeader = await fetch(s.base + "/api/approve", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
    expect(s.deps.jobs.list().filter((j) => j.kind === "approve")).toHaveLength(0);
  });
});

describe("rubric changes and stale reviews", () => {
  /** Saves a copy of an older rubric (one fewer check, different prompt) the way the admin would have kept it. */
  async function oldSnapshot(auditFile: string) {
    const { loadRubric } = await import("../../sync/src/rubric");
    const { toSnapshot } = await import("../../sync/src/rubricdiff");
    const cur = toSnapshot(await loadRubric("rubric"));
    const old = { ...cur, version: "default@bbbbbbbbbb", seenAt: "2026-01-01T00:00:00.000Z", rules: cur.rules.slice(1), prompt: cur.prompt + "\nAn older extra line." };
    const dir = join(auditFile, "..", "state", "rubrics");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "default_bbbbbbbbbb.json"), JSON.stringify(old));
    return { old, cur };
  }

  it("shows the current rubric, remembers it, and needs a login", async () => {
    const s = await start();
    expect((await s.call("/api/rubric")).status).toBe(401);
    const cookie = await s.login();
    const r = await s.call("/api/rubric", { cookie });
    expect(r.status).toBe(200);
    expect(r.data.current.version).toMatch(/^default@[0-9a-f]{10}$/);
    expect(r.data.current.checks.length).toBeGreaterThan(5);
    expect(r.data.history.map((h: any) => h.version)).toContain(r.data.current.version);
    expect((await s.call("/api/plugins", { cookie })).data.rubricVersion).toBe(r.data.current.version);
  });

  it("links the rubric to its repository only from the admin config, and rejects odd addresses", async () => {
    const s = await start();
    const cookie = await s.login();
    expect((await s.call("/api/rubric", { cookie })).data.links).toEqual({ source: null, propose: null });
    s.deps.cfg.rubricSourceUrl = "https://git.example.internal/o/r/tree/main/rubric";
    s.deps.cfg.rubricProposeUrl = "https://git.example.internal/o/r/issues/new";
    expect((await s.call("/api/rubric", { cookie })).data.links).toEqual({ source: "https://git.example.internal/o/r/tree/main/rubric", propose: "https://git.example.internal/o/r/issues/new" });
    const base = { registryConfig: "x", auditLog: "y", password: { usersFile: "z" }, allowInsecureHttp: true };
    expect(validateConfig({ ...base, rubricSourceUrl: "javascript:alert(1)" })[0]).toContain("rubricSourceUrl must be an http(s) address");
    expect(validateConfig({ ...base, rubricProposeUrl: "https://x.example/issues/new?title=a" })).toHaveLength(1);
    expect(validateConfig({ ...base, rubricSourceUrl: "https://x.example/o/r/tree/main/rubric" })).toEqual([]);
  });

  it("flags a review made under another rubric version as stale, compares the versions and reports static impact", async () => {
    const s = await start();
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    const { old, cur } = await oldSnapshot(s.audit);
    const vdir = join(s.outDir, "plugins", "demo", "1.0.0");
    await writeFile(join(vdir, "review.json"), JSON.stringify({ schema: 1, id: "demo", version: "1.0.0", review: { verdict: "pass", rubricVersion: old.version, model: "m" } }));

    const v = (await s.call("/api/plugins", { cookie })).data.plugins[0].versions[0];
    expect(v.review.rubricVersion).toBe(old.version); // the page compares this with the current version to show "stale"

    const diff = await s.call("/api/rubric/diff?from=" + encodeURIComponent(old.version), { cookie });
    expect(diff.status).toBe(200);
    expect(diff.data.added.map((r: any) => r.id)).toEqual([cur.rules[0].id]);
    expect(diff.data.promptChanged).toBe(true);
    expect((await s.call("/api/rubric/diff?from=" + encodeURIComponent("../../etc/passwd"), { cookie })).status).toBe(404);
    expect((await s.call("/api/rubric/diff", { cookie })).status).toBe(404);

    const impact = await s.call("/api/rubric/impact", { cookie });
    expect(impact.status).toBe(200);
    expect(impact.data.rows).toHaveLength(1);
    expect(impact.data.rows[0]).toMatchObject({ id: "demo", version: "1.0.0", reviewedUnder: old.version, status: "unchanged" }); // "code-1.0.0" trips nothing either way
    expect(impact.data.counts.unchanged).toBe(1);
  });

  it("re-review of stale versions validates its choice and reports when nothing is stale", async () => {
    const s = await start({ review: true });
    const cookie = await s.login();
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    const bad = await s.call("/api/review", { cookie, body: { stale: "everything" } });
    expect(bad.status).toBe(400);
    const none = await s.call("/api/review", { cookie, body: { stale: "all" } }); // nothing has a review yet
    expect(none.status).toBe(400);
    expect(none.data.error).toMatch(/no reviewed version is stale/);
    const { old } = await oldSnapshot(s.audit);
    await writeFile(join(s.outDir, "plugins", "demo", "1.0.0", "review.json"), JSON.stringify({ schema: 1, review: { verdict: "pass", rubricVersion: old.version, model: "m" } }));
    const ok = await s.call("/api/review", { cookie, body: { stale: "all" } });
    expect(ok.status).toBe(202);
    await s.waitJob(ok.data.job.id, cookie);
    expect(await readFile(s.audit, "utf8")).toMatch(/"targets":"stale:all \(1\)"/);
    const changed = await s.call("/api/review", { cookie, body: { stale: "changed" } }); // the static result did not move, so no free-text reason to re-review
    expect(changed.status).toBe(400);
  });
});

describe("adding repositories from the dashboard", () => {
  const withRepos = async (over: Parameters<typeof start>[0] = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "om-repos-"));
    return start({ repos: new RepoStore(join(dir, "repos.json")), ...over });
  };

  it("is off without a store, and needs a login", async () => {
    const s = await start();
    const cookie = await s.login();
    expect((await s.call("/api/repos", { cookie })).status).toBe(404);
    const t = await withRepos();
    expect((await t.call("/api/repos")).status).toBe(401);
    expect((await t.call("/api/repos/check", { body: { repo: "o/x" } })).status).toBe(401);
  });

  it("checks without adding, then adds, audits, and syncs the new repository", async () => {
    // "o/r" is configured; the mock serves one plugin ("demo") for any repository.
    const s = await withRepos({ tags: ["1.0.0"] });
    const cookie = await s.login();
    const chk = await s.call("/api/repos/check", { cookie, body: { repo: "acme/new-plugin" } });
    expect(chk.status).toBe(200);
    expect(chk.data.ok).toBe(true);
    expect((await s.call("/api/repos", { cookie })).data.nominated).toEqual([]); // checking adds nothing

    const add = await s.call("/api/repos", { cookie, body: { repo: "acme/new-plugin", note: "asked for by the docs team" } });
    expect(add.status).toBe(201);
    const list = (await s.call("/api/repos", { cookie })).data;
    expect(list.configured).toEqual(["o/r"]);
    expect(list.nominated).toMatchObject([{ repo: "acme/new-plugin", addedBy: "alice", note: "asked for by the docs team" }]);

    const seen: string[] = [];
    s.deps.fetcher = async (url, accept) => { if (url.includes("/releases")) seen.push(url); return mockFetcher(["1.0.0"])(url, accept); };
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    expect(seen.some((u) => u.includes("/repos/acme/new-plugin/releases"))).toBe(true);
    expect(seen.some((u) => u.includes("/repos/o/r/releases"))).toBe(true);

    const audit = await readFile(s.audit, "utf8");
    expect(audit).toMatch(/"action":"repo.check"/);
    expect(audit).toMatch(/"action":"repo.add".*acme\/new-plugin/);
  });

  it("refuses bad names, duplicates, repositories sync would reject, and a plugin id that belongs to another repository", async () => {
    const s = await withRepos();
    const cookie = await s.login();
    for (const repo of ["", "nope", "a/b/c", "../x/y", "https://github.com/a/b", 5])
      expect((await s.call("/api/repos", { cookie, body: { repo } })).status).toBe(400);
    expect((await s.call("/api/repos", { cookie, body: { repo: "o/r" } })).status).toBe(409); // already in registry.config.json

    s.deps.fetcher = async () => new Response("{}", { status: 404 });
    const missing = await s.call("/api/repos", { cookie, body: { repo: "acme/missing" } });
    expect(missing.status).toBe(422);
    expect(missing.data.error).toMatch(/does not know this repository/);
    // "demo" is mirrored from o/r; another repository may not take over that id, neither when nominated nor when sync runs.
    s.deps.fetcher = mockFetcher(["1.0.0"]);
    await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    const idx = JSON.parse(await readFile(join(s.outDir, "index.json"), "utf8"));
    expect(idx[0].repo).toBe("o/r");
    const clash = await s.call("/api/repos", { cookie, body: { repo: "evil/demo-fork" } });
    expect(clash.status).toBe(422);
    expect(clash.data.error).toMatch(/demo is already provided by o\/r/);

    // A repository with a different plugin is fine, and cannot be added twice (case-insensitively).
    s.deps.fetcher = async (url, accept) => (url.endsWith("manifest.json") ? new Response(manifest("1.0.0").replace('"demo"', '"other"')) : mockFetcher(["1.0.0"])(url, accept));
    expect((await s.call("/api/repos", { cookie, body: { repo: "acme/a" } })).status).toBe(201);
    expect((await s.call("/api/repos", { cookie, body: { repo: "ACME/A" } })).status).toBe(409);
    expect((await s.call("/api/repos", { cookie })).data.nominated.map((n: any) => n.repo)).toEqual(["acme/a"]);

    // And sync itself refuses to mix versions in under another repository's plugin id.
    s.deps.fetcher = mockFetcher(["1.0.0", "1.1.0"]);
    const j = await s.waitJob((await s.call("/api/sync", { cookie, method: "POST" })).data.job.id, cookie);
    expect(j.status).toBe("failed");
    expect((j.output as string[]).join("\n")).toMatch(/plugin id "demo" is already provided by o\/r/);
  });

  it("removes only repositories added from the dashboard, and audits it", async () => {
    const s = await withRepos();
    const cookie = await s.login();
    await s.call("/api/repos", { cookie, body: { repo: "acme/a" } });
    expect((await s.call("/api/repos/remove", { cookie, body: { repo: "o/r" } })).status).toBe(404); // from the config file
    expect((await s.call("/api/repos/remove", { cookie, body: { repo: "acme/a" } })).status).toBe(200);
    expect((await s.call("/api/repos", { cookie })).data.nominated).toEqual([]);
    expect(await readFile(s.audit, "utf8")).toMatch(/"action":"repo.remove"/);
    expect((await s.call("/api/repos/remove", { cookie, body: { repo: "acme/a" } })).status).toBe(404);
  });

  it("throttles checks", async () => {
    const s = await withRepos();
    const cookie = await s.login();
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await s.call("/api/repos/check", { cookie, body: { repo: "acme/a" } })).status;
    expect(last).toBe(429);
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
