import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { appendFile, mkdtemp, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AccessProcessor, ActivityStore, publishStats } from "../src/activity";
import { classifyClient, normalizeAudit, parseAccessLine, validNetwork, zoneOf, type RegistryEvent } from "../src/events";
import { readNewLines } from "../src/tail";
import { buildBatch, makeHecPost, SplunkForwarder, validateSplunk, type SplunkConfig } from "../src/splunk";
import { clientViews, adoption } from "../src/views";
import { validateConfig } from "../src/config";

const OBSIDIAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.8.9 Chrome/132.0.6834.196 Electron/34.2.0 Safari/537.36";
const nets = [{ cidr: "10.20.0.0/16", name: "Engineering" }, { cidr: "10.0.0.0/8", name: "Corporate" }];
const ctx = (offset = 0) => ({ source: "access", offset, networks: nets });
const line = (o: Record<string, unknown>) => JSON.stringify({ t: "2026-11-13T10:00:00+00:00", ip: "10.20.1.5", m: "GET", u: "/plugins/demo/1.0.0/main.js", s: 200, b: 1234, ua: OBSIDIAN_UA, ...o });

describe("access-log parsing", () => {
  it("turns a main.js download into an install indicator with client, zone and a stable id", () => {
    const e = parseAccessLine(line({}), ctx(42))!;
    expect(e).toMatchObject({ schema: 1, id: "access:42", type: "plugin.download", plugin: "demo", version: "1.0.0", file: "main.js", status: 200, install: true, zone: "Engineering", time: "2026-11-13T10:00:00.000Z" });
    expect(e.client).toMatchObject({ kind: "obsidian", version: "1.8.9", os: "windows" });
  });

  it("only counts successful GETs of main.js as installs; other files and failures are not", () => {
    expect(parseAccessLine(line({ u: "/plugins/demo/1.0.0/manifest.json" }), ctx())!.install).toBe(false);
    expect(parseAccessLine(line({ s: 404 }), ctx())!.install).toBe(false);
    expect(parseAccessLine(line({ s: 304 }), ctx())!.install).toBe(false);
    expect(parseAccessLine(line({ m: "HEAD" }), ctx())!.install).toBe(false);
    expect(parseAccessLine(line({ s: 206 }), ctx())!.install).toBe(true);
  });

  it("recognises catalog check-ins", () => {
    expect(parseAccessLine(line({ u: "/index.json" }), ctx())).toMatchObject({ type: "catalog.check", file: "index.json", install: false });
    expect(parseAccessLine(line({ u: "/plugins/demo/versions.json" }), ctx())).toMatchObject({ type: "catalog.check", plugin: "demo", file: "versions.json" });
  });

  it("skips malformed, oversized, wrong-method and hostile lines without throwing", () => {
    for (const bad of ["", "not json", "[]", "null", JSON.stringify({ u: "/index.json" }), "x".repeat(5000), line({ m: "POST" }), line({ s: 99 }), line({ t: "garbage" }),
      line({ u: "/plugins/../../etc/passwd" }), line({ u: "/plugins/DEMO/1.0.0/main.js" }), line({ u: "/plugins/demo/..%2f..%2fx/main.js" }), line({ u: "/plugins/demo/1.0.0/other.bin" }),
      line({ u: "/admin/api/sync" }), line({ u: "/plugins//1.0.0/main.js" })])
      expect(parseAccessLine(bad, ctx())).toBeNull();
  });

  it("neutralises control characters and caps user agent length", () => {
    const e = parseAccessLine(line({ ua: "evil\u0000\u001b[31m\n" + "A".repeat(1000) }), ctx())!;
    expect(e.client.ua).not.toMatch(/[\u0000-\u001f]/);
    expect(e.client.ua.length).toBeLessThanOrEqual(200);
    expect(e.client.kind).toBe("other");
  });

  it("honours a base path and refuses lines outside it", () => {
    const c = { ...ctx(), basePath: "/registry" };
    expect(parseAccessLine(line({ u: "/registry/plugins/demo/1.0.0/main.js" }), c)).toMatchObject({ plugin: "demo" });
    expect(parseAccessLine(line({ u: "/plugins/demo/1.0.0/main.js" }), c)).toBeNull();
  });

  it("classifies clients and maps addresses to zones (first match wins, IPv4-mapped unwrapped)", () => {
    expect(classifyClient("om/0.2.0 (win)")).toMatchObject({ kind: "om", version: "0.2.0" });
    expect(classifyClient("curl/8.0")).toMatchObject({ kind: "other" });
    expect(zoneOf("10.20.1.5", nets)).toBe("Engineering");
    expect(zoneOf("10.99.0.1", nets)).toBe("Corporate");
    expect(zoneOf("::ffff:10.20.3.3", nets)).toBe("Engineering");
    expect(zoneOf("192.168.0.1", nets)).toBeUndefined();
    expect(zoneOf("not an ip", nets)).toBeUndefined();
    expect(validNetwork({ cidr: "10.0.0.0/33", name: "x" })).toBe(false);
    expect(validNetwork({ cidr: "10.0.0.0/8", name: "x" })).toBe(true);
  });

  it("wraps admin audit lines in the same envelope", () => {
    const e = normalizeAudit(JSON.stringify({ ts: "2026-11-13T10:00:00Z", who: "alice", action: "sync.start", ip: "1.2.3.4" }), "audit", 7)!;
    expect(e).toMatchObject({ schema: 1, id: "audit:7", type: "admin.sync.start", who: "alice", time: "2026-11-13T10:00:00Z" });
    expect(normalizeAudit("garbage", "audit", 0)).toBeNull();
  });
});

describe("tailing", () => {
  const dir = () => mkdtemp(join(tmpdir(), "om-tail-"));

  it("returns only complete lines and picks up the rest when the newline arrives", async () => {
    const f = join(await dir(), "a.log");
    await writeFile(f, "one\ntwo\npart");
    const r1 = (await readNewLines(f, null))!;
    expect(r1.lines.map((l) => l.text)).toEqual(["one", "two"]);
    await appendFile(f, "ial\n");
    const r2 = (await readNewLines(f, r1.next))!;
    expect(r2.lines).toEqual([{ text: "partial", offset: 8 }]);
    expect((await readNewLines(f, r2.next))!.lines).toEqual([]);
  });

  it("starts at the end when asked, and restarts after truncation or rotation", async () => {
    const d = await dir(), f = join(d, "a.log");
    await writeFile(f, "old1\nold2\n");
    const first = (await readNewLines(f, null, { startAtEnd: true }))!;
    expect(first.lines).toEqual([]);
    await appendFile(f, "new1\n");
    const r = (await readNewLines(f, first.next))!;
    expect(r.lines.map((l) => l.text)).toEqual(["new1"]);
    await truncate(f, 0); await appendFile(f, "after-truncate\n"); // copytruncate: same file, smaller than the cursor
    expect((await readNewLines(f, r.next))!.lines.map((l) => l.text)).toEqual(["after-truncate"]);
    const cur = (await readNewLines(f, null))!.next;
    await rename(f, join(d, "a.log.1")); // rotation: a new file at the same path
    await writeFile(f, "rotated-1\nrotated-2\n");
    expect((await readNewLines(f, cur))!.lines.map((l) => l.text)).toEqual(["rotated-1", "rotated-2"]);
  });

  it("is quiet when the file does not exist yet", async () => {
    expect(await readNewLines(join(await dir(), "nope.log"), null)).toBeNull();
  });
});

describe("activity store and processor", () => {
  async function fixture() {
    const d = await mkdtemp(join(tmpdir(), "om-act-"));
    const log = join(d, "access.log"), state = join(d, "state", "activity.json");
    return { d, log, state, proc: () => new AccessProcessor({ logFile: log, stateFile: state, networks: nets }) };
  }
  const dl = (ip: string, plugin: string, version: string, extra: Record<string, unknown> = {}) => line({ ip, u: `/plugins/${plugin}/${version}/main.js`, ...extra });

  it("tracks per-client last-fetched versions and counts distinct clients, not requests", async () => {
    const f = await fixture();
    await writeFile(f.log, [dl("10.0.0.1", "demo", "1.0.0"), dl("10.0.0.1", "demo", "1.0.0"), dl("10.0.0.2", "demo", "1.0.0"), dl("10.0.0.1", "demo", "1.1.0", { t: "2026-11-13T11:00:00+00:00" }),
      line({ ip: "10.0.0.3", u: "/index.json" })].join("\n") + "\n");
    const p = f.proc();
    expect(await p.step(new Date("2026-11-13T12:00:00Z"))).toBe(5);
    const rows = p.store.clientRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.addr === "10.0.0.1")!.plugins.demo.version).toBe("1.1.0");
    const stats = p.store.publicStats(new Date("2026-11-13T12:00:00Z"), 30, 1);
    expect(stats.plugins.demo).toEqual({ installs: 2, versions: { "1.0.0": 2, "1.1.0": 1 } });
  });

  it("ignores failed requests so probing for non-existent files creates no clients or counts", async () => {
    const f = await fixture();
    await writeFile(f.log, [dl("10.0.0.9", "demo", "9.9.9", { s: 404 }), dl("10.0.0.9", "ghost", "1.0.0", { s: 404 })].join("\n") + "\n");
    const p = f.proc();
    await p.step();
    expect(p.store.clientRows()).toHaveLength(0);
    expect(p.store.publicStats(new Date("2026-11-13T12:00:00Z"), 30, 1).plugins).toEqual({});
  });

  it("survives a restart without resetting or double counting", async () => {
    const f = await fixture();
    await writeFile(f.log, [dl("10.0.0.1", "demo", "1.0.0"), dl("10.0.0.2", "demo", "1.0.0")].join("\n") + "\n");
    const a = f.proc();
    expect(await a.step()).toBe(2);
    const b = f.proc(); // new process, same state file
    expect(await b.step()).toBe(0); // nothing re-read
    expect(b.store.publicStats(new Date("2026-11-13T12:00:00Z"), 30, 1).plugins.demo.installs).toBe(2); // counts kept
    await appendFile(f.log, dl("10.0.0.3", "demo", "1.0.0") + "\n");
    expect(await b.step()).toBe(1);
    expect(b.store.publicStats(new Date("2026-11-13T12:00:00Z"), 30, 1).plugins.demo.installs).toBe(3);
    expect(await readFile(f.state, "utf8")).not.toContain("10.0.0.1|"); // client keys are salted hashes
  });

  it("withholds small counts and publishes only aggregates, atomically", async () => {
    const f = await fixture();
    const lines = [];
    for (let i = 1; i <= 6; i++) lines.push(dl(`10.0.0.${i}`, "popular", "2.0.0"));
    for (let i = 1; i <= 2; i++) lines.push(dl(`10.0.1.${i}`, "niche", "1.0.0"));
    await writeFile(f.log, lines.join("\n") + "\n");
    const p = f.proc();
    await p.step();
    await publishStats(f.d, p.store, 30, 5, new Date("2026-11-13T12:00:00Z"));
    const pub = await readFile(join(f.d, "stats.json"), "utf8");
    const stats = JSON.parse(pub);
    expect(stats.plugins.popular.installs).toBe(6);
    expect(stats.plugins.niche).toBeUndefined();
    expect(pub).not.toMatch(/10\.0\.|Mozilla|obsidian\/|Windows/); // no addresses or user agents in the public file
  });

  it("bounds memory: the client table never exceeds its cap", () => {
    const s = new ActivityStore();
    const ev = (i: number): RegistryEvent => ({ schema: 1, id: String(i), time: new Date(1_700_000_000_000 + i * 1000).toISOString(), type: "catalog.check", status: 200, bytes: 1, install: false, addr: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, client: { kind: "other", ua: `ua-${i}` } });
    for (let i = 0; i < 5200; i++) s.apply(ev(i));
    expect(s.clientRows().length).toBeLessThanOrEqual(5000);
  });

  it("labels fetched versions against the registry without claiming they are installed", () => {
    const state = [{ id: "demo", versions: [
      { version: "1.1.0", published: "x", staged: false, review: null, approval: null },
      { version: "1.0.0", published: "x", staged: false, review: null, approval: { ok: true, by: "t" } }] }];
    const row = (id: string, version: string, addr: string) => ({ key: addr, first: "a", last: "b", kind: "obsidian", ua: "u", addr, checks: 0, plugins: { [id]: { version, time: "t" } } });
    const views = clientViews([row("demo", "1.0.0", "a1"), row("demo", "1.1.0", "a2"), row("ghost", "1.0.0", "a3")], state as never);
    expect(views.map((v) => v.plugins[0].status)).toEqual(["behind", "unapproved", "not in registry"]);
    expect(adoption(views).find((a) => a.version === "1.0.0" && a.id === "demo")!.clients).toBe(1);
  });
});

describe("Splunk HEC forwarding", () => {
  const servers: Server[] = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  /** Mock HEC: answers with the queued status codes, then 200; records headers and bodies. */
  async function mockHec(statuses: number[] = [], echoToken = false) {
    const seen: { auth?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body });
        const status = statuses.shift() ?? 200;
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(status === 200 ? { text: "Success", code: 0 } : { text: echoToken ? `bad token tok-SECRET-123` : "Server is busy", code: 9 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  const env = { HEC_TOKEN: "tok-SECRET-123" };

  async function setup(over: Partial<SplunkConfig> = {}, statuses: number[] = [], echoToken = false) {
    const d = await mkdtemp(join(tmpdir(), "om-hec-"));
    const hec = await mockHec(statuses, echoToken);
    const cfg: SplunkConfig = { url: hec.url, tokenEnv: "HEC_TOKEN", allowInsecureHttp: true, backfill: true, ...over };
    const accessLog = join(d, "access.log"), auditLog = join(d, "audit.jsonl");
    await writeFile(accessLog, "");
    await writeFile(auditLog, "");
    const mk = async () => new SplunkForwarder(cfg, { accessLog, auditLog, stateFile: join(d, "state", "splunk.json"), networks: nets, host: "h1" }, await makeHecPost(cfg, env));
    return { d, hec, cfg, accessLog, auditLog, mk };
  }
  const dl = (n: number) => line({ ip: `10.0.0.${n}`, u: "/plugins/demo/1.0.0/main.js" });

  it("sends original-time events with the Splunk auth header, index only when configured", async () => {
    const s = await setup({ index: "om", sourcetype: "om:test" });
    await appendFile(s.accessLog, dl(1) + "\n");
    await appendFile(s.auditLog, JSON.stringify({ ts: "2026-11-13T10:05:00Z", who: "alice", action: "sync.start" }) + "\n");
    const f = await s.mk();
    expect(await f.step()).toBe(2);
    expect(s.hec.seen[0].auth).toBe("Splunk tok-SECRET-123");
    const first = JSON.parse(s.hec.seen[0].body);
    expect(first).toMatchObject({ time: Date.parse("2026-11-13T10:00:00+00:00") / 1000, host: "h1", sourcetype: "om:test", index: "om" });
    expect(first.event).toMatchObject({ type: "plugin.download", install: true, zone: "Corporate" });
    expect(JSON.parse(s.hec.seen[1].body).event).toMatchObject({ type: "admin.sync.start", who: "alice" });
    expect(buildBatch([{ time: "2026-11-13T10:00:00Z" }], { url: "u", tokenEnv: "x" }, "h")).not.toContain("\"index\"");
  });

  it("does not advance on failure, retries after backoff, and never sends an event twice", async () => {
    const s = await setup({}, [503]);
    await appendFile(s.accessLog, dl(1) + "\n");
    const f = await s.mk();
    const t0 = Date.now();
    expect(await f.step(t0)).toBe(0);
    expect(f.status()).toMatchObject({ failures: 1 });
    expect(f.status().lastError).toMatch(/HEC 503/);
    expect(await f.step(t0 + 1000)).toBe(0); // still backing off: no request made
    expect(s.hec.seen).toHaveLength(1);
    expect(await f.step(t0 + 120_000)).toBe(1); // backoff over, same batch re-sent
    expect(s.hec.seen).toHaveLength(2);
    expect(s.hec.seen[0].body).toBe(s.hec.seen[1].body); // identical payload, identical event id
    expect(await f.step(t0 + 240_000)).toBe(0); // nothing sent twice
    expect(s.hec.seen).toHaveLength(2);
    expect(f.status()).toMatchObject({ failures: 0, lastError: null, sent: 1 });
    const g = await s.mk(); // restart: cursor persisted, nothing re-sent
    expect(await g.step(t0 + 300_000)).toBe(0);
  });

  it("treats 403 and 400 as failures that keep the data, and never leaks the token in errors", async () => {
    const s = await setup({}, [403, 400], true);
    await appendFile(s.accessLog, dl(1) + "\n");
    const f = await s.mk();
    expect(await f.step(1_000_000)).toBe(0);
    expect(f.status().lastError).toMatch(/HEC 403/);
    expect(f.status().lastError).not.toContain("tok-SECRET-123");
    expect(await f.step(2_000_000)).toBe(0);
    expect(f.status().lastError).toMatch(/HEC 400/);
    expect(await f.step(9_000_000)).toBe(1); // admin fixes the problem; data was kept
  });

  it("by default starts at the end of the log instead of dumping history", async () => {
    const s = await setup({ backfill: false });
    await appendFile(s.accessLog, dl(1) + "\n" + dl(2) + "\n");
    const f = await s.mk();
    expect(await f.step()).toBe(0); // first run: positions at the end
    await appendFile(s.accessLog, dl(3) + "\n");
    expect(await f.step()).toBe(1);
    expect(s.hec.seen).toHaveLength(1);
  });

  it("keeps a failed stream from blocking the other and never throws", async () => {
    const s = await setup({ forward: ["audit"] });
    await appendFile(s.accessLog, dl(1) + "\n");
    await appendFile(s.auditLog, JSON.stringify({ ts: "2026-11-13T10:05:00Z", who: "a", action: "denied" }) + "\n");
    const f = await s.mk();
    expect(await f.step()).toBe(1); // only the audit stream was enabled
  });

  it("validates configuration and fails closed", async () => {
    expect(validateSplunk({ url: "http://splunk:8088", tokenEnv: "T" }).join()).toMatch(/https/);
    expect(validateSplunk({ url: "http://splunk:8088", tokenEnv: "T", allowInsecureHttp: true })).toEqual([]);
    expect(validateSplunk({ url: "https://splunk:8088" }).join()).toMatch(/exactly one/);
    expect(validateSplunk({ url: "https://splunk:8088", tokenEnv: "T", tokenFile: "f" }).join()).toMatch(/exactly one/);
    expect(validateSplunk({ url: "nonsense", tokenEnv: "T" }).join()).toMatch(/valid URL/);
    expect(validateSplunk({ url: "https://s", tokenEnv: "T", forward: ["x" as never] }).join()).toMatch(/unknown stream/);
    await expect(makeHecPost({ url: "https://s", tokenEnv: "MISSING" }, {})).rejects.toThrow(/MISSING/);
    const base = { registryConfig: "r", auditLog: "a", allowInsecureHttp: true, password: { usersFile: "u" } };
    expect(validateConfig({ ...base, stats: { publish: true } }).join()).toMatch(/needs accessLog/);
    expect(validateConfig({ ...base, accessLog: "/l", networks: [{ cidr: "bad", name: "x" }] }).join()).toMatch(/networks/);
    expect(validateConfig({ ...base, accessLog: "/l", stats: { publish: true, minCount: 5 }, splunk: { url: "https://s", tokenEnv: "T" } })).toEqual([]);
  });
});
