import { createServer as createHttp, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFile } from "node:fs/promises";
import { isSafeVersion, isValidPluginId } from "@om/shared";
import type { Config, Fetcher } from "@om/sync/src/sync";
import { allVersions, publishHeld, runReviews, runSync, type ReviewOpts } from "@om/sync/src/jobs";
import { manageVersion, MANAGE_ACTIONS, type ManageAction } from "@om/sync/src/manage";
import type { QueueSigner } from "@om/sync/src/signer";
import { findEntry } from "@om/sync/src/catalog";
import { checkApproval } from "@om/shared";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadRubric, type Rubric } from "@om/sync/src/rubric";
import { diffSnapshots, listSnapshots, loadSnapshot, saveSnapshot, staleTargets, staticImpact, toSnapshot } from "@om/sync/src/rubricdiff";
import { NoteError, type NoteStore } from "./notes";
import type { Audit } from "./audit";
import type { AdminConfig } from "./config";
import { Busy, JobRunner } from "./jobs";
import { checkLogin, LoginLimiter } from "./auth/password";
import { cookieValue, SessionStore } from "./auth/session";
import type { Authenticator, Identity } from "./auth/types";
import { registryState } from "./state";
import type { AccessProcessor } from "./activity";
import type { SplunkForwarder } from "./splunk";
import { adoption, clientViews } from "./views";
import { APP_CSS, APP_JS, INDEX_HTML } from "./ui";

export interface Deps {
  cfg: AdminConfig;
  loadRegistryConfig(): Promise<Config>;
  /** Where reviews run (the queue to the reviewer container). Unset: in-process. */
  reviewOpts?: ReviewOpts;
  /** Shared triage notes. Unset: the notes API answers 404. */
  notes?: NoteStore;
  /** Where approvals are signed (the queue to the signer container). Unset: approving stays on the command line. */
  signer?: QueueSigner;
  publicKey: string;
  audit: Audit;
  authenticators: Authenticator[];
  password?: { usersFile: string; sessions: SessionStore; limiter: LoginLimiter };
  jobs: JobRunner;
  /** Server-side client activity from the registry access log (optional). */
  activity?: AccessProcessor;
  forwarder?: SplunkForwarder | null;
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  /** Mark the session cookie Secure (true whenever the listener is TLS). */
  secure: boolean;
}

const COOKIE = "om_session";
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body)); };

/** Loads the rubric shipped with the admin and keeps a copy of this version, so it can be compared with later ones. */
async function rubricCtx(d: Deps, rc: Config): Promise<{ current: Rubric; snapDir: string }> {
  const current = await loadRubric(rc.review?.rubricDir ?? "rubric");
  const snapDir = join(d.cfg.stateDir ?? join(dirname(d.cfg.auditLog), "state"), "rubrics");
  await saveSnapshot(snapDir, current);
  return { current, snapDir };
}
/** Web address used for "report an issue" links: the configured one, else derived from the GitHub API address. */
function githubWebBase(configured: string | undefined, apiBase: string): string {
  if (configured) return configured;
  try { const u = new URL(apiBase); return u.hostname === "api.github.com" ? "https://github.com" : u.origin; } catch { return ""; }
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { throw new HttpError(400, "invalid JSON"); }
}

export function createHandler(d: Deps): RequestListener {
  const identify = (req: IncomingMessage): Identity | null => {
    for (const a of d.authenticators) { const id = a.authenticate(req); if (id) return id; }
    return d.password?.sessions.get(cookieValue(req.headers.cookie, COOKIE)) ?? null;
  };
  const ipOf = (req: IncomingMessage) => req.socket.remoteAddress ?? "?";

  /**
   * Browsers attach cookies and client certificates to cross-site requests. A custom header (which forces a CORS
   * preflight that we never approve) plus an Origin match stops a hostile page from driving the admin API.
   */
  const checkPost = (req: IncomingMessage) => {
    if (req.headers["x-om-admin"] !== "1") throw new HttpError(403, "missing X-OM-Admin header");
    const origin = req.headers.origin;
    if (origin) {
      let host = "";
      try { host = new URL(origin).host; } catch { /* leave empty: refused below */ }
      if (host !== req.headers.host) throw new HttpError(403, "cross-origin request refused");
    }
  };

  return async (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (d.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(INDEX_HTML); return; }
      if (method === "GET" && path === "/app.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(APP_JS); return; }
      if (method === "GET" && path === "/app.css") { res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }).end(APP_CSS); return; }
      if (!path.startsWith("/api/")) { json(res, 404, { error: "not found" }); return; }
      if (method === "POST") checkPost(req);

      if (method === "POST" && path === "/api/login") {
        const pw = d.password;
        if (!pw) { json(res, 404, { error: "password login is not enabled" }); return; }
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.slice(0, 64) : "";
        const secret = typeof body.password === "string" ? body.password.slice(0, 256) : "";
        const ip = ipOf(req);
        const keys = [`${ip}|${name.toLowerCase()}`, ip];
        if (keys.some((k) => pw.limiter.locked(k))) { await d.audit.record(name || "?", "login.locked", {}, ip); json(res, 429, { error: "too many attempts" }); return; }
        const who = await checkLogin(pw.usersFile, name, secret);
        if (!who) { keys.forEach((k) => pw.limiter.fail(k)); await d.audit.record(name || "?", "login.failed", {}, ip); json(res, 401, { error: "sign-in failed" }); return; }
        keys.forEach((k) => pw.limiter.ok(k));
        const sid = pw.sessions.create(who);
        res.setHeader("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/${d.secure ? "; Secure" : ""}`);
        await d.audit.record(who, "login.ok", {}, ip);
        json(res, 200, { name: who, method: "password" });
        return;
      }

      const who = identify(req);
      const ip = ipOf(req);
      if (!who) {
        if (path === "/api/me") { json(res, 401, { passwordLogin: !!d.password }); return; }
        await d.audit.record("-", "denied", { path, method }, ip);
        json(res, 401, { error: "authentication required" });
        return;
      }

      if (method === "GET" && path === "/api/me") { json(res, 200, who); return; }
      if (method === "POST" && path === "/api/logout") {
        d.password?.sessions.destroy(cookieValue(req.headers.cookie, COOKIE));
        res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        await d.audit.record(who.name, "logout", {}, ip);
        json(res, 200, { ok: true });
        return;
      }
      if (method === "GET" && path === "/api/plugins") {
        const rc = await d.loadRegistryConfig();
        json(res, 200, { registryUrl: d.cfg.registryUrl ?? null, githubWebBase: githubWebBase(d.cfg.githubWebBase, rc.githubApiBase), publishPolicy: rc.publishPolicy ?? "all", notes: !!d.notes, canApprove: !!d.signer, rubricVersion: (await rubricCtx(d, rc).catch(() => null))?.current.version ?? null, plugins: await registryState(rc.outDir, d.publicKey) });
        return;
      }
      if (method === "GET" && path === "/api/jobs") {
        json(res, 200, { jobs: d.jobs.list().map((j) => ({ id: j.id, kind: j.kind, who: j.who, status: j.status, started: j.started, finished: j.finished })) });
        return;
      }
      const jm = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(path);
      if (method === "GET" && jm) {
        const j = d.jobs.get(jm[1]);
        if (j) json(res, 200, j); else json(res, 404, { error: "no such job" });
        return;
      }

      if (method === "POST" && path === "/api/sync") {
        const rc = await d.loadRegistryConfig();
        const job = d.jobs.start("sync", who.name, async (log) => {
          const r = await runSync(rc, log, d.env, d.fetcher, d.reviewOpts);
          if (r.errors.length) throw new Error(`${r.errors.length} error(s) during sync`);
        });
        await d.audit.record(who.name, "sync.start", { job: job.id }, ip);
        json(res, 202, { job });
        return;
      }
      if (method === "POST" && path === "/api/review") {
        const body = await readJson(req);
        const rc = await d.loadRegistryConfig();
        if (!rc.review) throw new HttpError(400, "no \"review\" section in the registry config");
        let targets: { id: string; version: string }[];
        if (body.all === true) targets = await allVersions(rc.outDir);
        else if (body.stale === "all" || body.stale === "changed") {
          // Re-review after a rubric (or model) change: every stale version, or only those whose deterministic result would move.
          const { current, snapDir } = await rubricCtx(d, rc).catch((e: Error) => { throw new HttpError(503, "cannot load the rubric: " + e.message); });
          targets = await staleTargets(rc.outDir, current, snapDir, body.stale, rc.review.model);
          if (!targets.length) throw new HttpError(400, body.stale === "changed" ? "no version's static result would change under the current rubric" : "no reviewed version is stale");
        }
        else if (typeof body.id === "string" && typeof body.version === "string" && isValidPluginId(body.id) && isSafeVersion(body.version)) targets = [{ id: body.id, version: body.version }];
        else throw new HttpError(400, "send {\"all\":true}, {\"stale\":\"all\"|\"changed\"} or {\"id\",\"version\"}");
        // Fail fast and visibly when the reviewer container is down, instead of queueing work that would time out one version at a time.
        const why = await d.reviewOpts?.preflight?.();
        if (why) throw new HttpError(503, why);
        const job = d.jobs.start("review", who.name, async (log) => {
          await runReviews(rc, targets, log, d.env, { ...d.reviewOpts, force: body.all !== true && body.force === true });
          await publishHeld(rc.outDir, rc.publishPolicy ?? "all", log);
        });
        await d.audit.record(who.name, "review.start", { job: job.id, targets: body.all === true ? "all" : body.stale ? `stale:${body.stale} (${targets.length})` : `${targets[0].id}@${targets[0].version}` }, ip);
        json(res, 202, { job });
        return;
      }
      if (method === "GET" && path === "/api/rubric") {
        // The rubric the admin reviews with: what it checks now, and the earlier versions it has seen (for comparing).
        const rc = await d.loadRegistryConfig();
        const { current, snapDir } = await rubricCtx(d, rc).catch((e: Error) => { throw new HttpError(503, "cannot load the rubric: " + e.message); });
        json(res, 200, {
          current: { name: current.name, version: current.version, promptLines: current.prompt.split("\n").filter((l) => l.trim()).length, checks: current.rules.map((r) => ({ id: r.id, title: r.title, severity: r.severity, why: r.why })) },
          history: await listSnapshots(snapDir),
          note: "The rubric ships inside the admin image; to change it, change the repository's rubric folder and rebuild. A new version makes earlier reviews stale.",
        });
        return;
      }
      if (method === "GET" && path === "/api/rubric/diff") {
        const rc = await d.loadRegistryConfig();
        const { current, snapDir } = await rubricCtx(d, rc).catch((e: Error) => { throw new HttpError(503, "cannot load the rubric: " + e.message); });
        const from = new URL(req.url ?? "/", "http://x").searchParams.get("from") ?? "";
        const old = await loadSnapshot(snapDir, from);
        if (!old) throw new HttpError(404, "no saved copy of that rubric version");
        json(res, 200, diffSnapshots(old, toSnapshot(current)));
        return;
      }
      if (method === "GET" && path === "/api/rubric/impact") {
        // Free: re-runs only the deterministic checks over every mirrored version. No model is called.
        const rc = await d.loadRegistryConfig();
        const { current, snapDir } = await rubricCtx(d, rc).catch((e: Error) => { throw new HttpError(503, "cannot load the rubric: " + e.message); });
        const rows = await staticImpact(rc.outDir, current, snapDir);
        const count = (s: string) => rows.filter((r) => r.status === s).length;
        json(res, 200, { version: current.version, model: rc.review?.model ?? null, counts: { current: count("current"), unreviewed: count("unreviewed"), unchanged: count("unchanged"), changed: count("changed"), unknown: count("unknown") }, rows });
        return;
      }
      if (method === "POST" && path === "/api/approve") {
        // The signing key is not in this process. The signer container re-checks the files and the review and signs; we verify what
        // it returns against the public key and the hashes on disk, and only then write it into the registry.
        if (!d.signer) throw new HttpError(404, "approving from the dashboard is not enabled (no signerQueue in the admin config)");
        const body = await readJson(req);
        if (typeof body.id !== "string" || typeof body.version !== "string" || !isValidPluginId(body.id) || !isSafeVersion(body.version)) throw new HttpError(400, "send {id, version, override?}");
        if (body.override !== undefined && (typeof body.override !== "string" || body.override.length > 300)) throw new HttpError(400, "override must be text of at most 300 characters");
        if (!d.publicKey) throw new HttpError(503, "no public key is configured to verify the signer's answer");
        const why = await d.signer.ready();
        if (why) throw new HttpError(503, why);
        const rc = await d.loadRegistryConfig();
        const { id, version } = body as { id: string; version: string };
        const override = typeof body.override === "string" && body.override.trim() ? body.override.trim() : undefined;
        const signer = d.signer;
        const job = d.jobs.start("approve", who.name, async (log) => {
          try {
            const r = await signer.sign({ id, version, by: who.name, ...(override ? { override } : {}) });
            const pdir = join(rc.outDir, "plugins", id);
            const entry = await findEntry(pdir, version);
            if (!entry) throw new Error(`${id}@${version} is not in the registry`);
            const bytes = new Uint8Array(Buffer.from(r.approval, "utf8"));
            const chk = await checkApproval(bytes, r.sig.trim(), d.publicKey, { id, version, actual: entry.sha256 });
            if (!chk.ok) throw new Error("the signer's approval did not verify: " + chk.reason);
            if (chk.approval.approvedBy !== who.name) throw new Error("the signer's approval names a different approver");
            const vdir = join(pdir, version);
            await mkdir(vdir, { recursive: true });
            await writeFile(join(vdir, "approval.json.tmp"), bytes); await rename(join(vdir, "approval.json.tmp"), join(vdir, "approval.json"));
            await writeFile(join(vdir, "approval.json.sig.tmp"), r.sig.trim()); await rename(join(vdir, "approval.json.sig.tmp"), join(vdir, "approval.json.sig"));
            log.log(`approved ${id}@${version} by ${who.name} (review: ${chk.approval.reviewVerdict ?? "none"}${chk.approval.override ? `, override: ${chk.approval.override}` : ""})`);
            await d.audit.record(who.name, "approve", { job: job.id, target: id + "@" + version, reviewVerdict: chk.approval.reviewVerdict ?? "none", ...(chk.approval.override ? { override: chk.approval.override } : {}) }, ip);
            await publishHeld(rc.outDir, rc.publishPolicy ?? "all", log);
          } catch (e) {
            await d.audit.record(who.name, "approve.failed", { job: job.id, target: id + "@" + version, reason: (e as Error).message.slice(0, 200) }, ip);
            throw e;
          }
        });
        await d.audit.record(who.name, "approve.start", { job: job.id, target: id + "@" + version, ...(override ? { override } : {}) }, ip);
        json(res, 202, { job });
        return;
      }
      if (method === "POST" && path === "/api/manage") {
        // Withdraw / hold back / release / revoke approval. Runs as a job so it cannot interleave with a sync or review.
        const body = await readJson(req);
        const rc = await d.loadRegistryConfig();
        if (typeof body.id !== "string" || typeof body.version !== "string" || !isValidPluginId(body.id) || !isSafeVersion(body.version)) throw new HttpError(400, "send {action, id, version}");
        if (!MANAGE_ACTIONS.includes(body.action as ManageAction)) throw new HttpError(400, "action must be one of " + MANAGE_ACTIONS.join(", "));
        const { id, version } = body as { id: string; version: string };
        const action = body.action as ManageAction;
        const job = d.jobs.start("manage", who.name, async (log) => { log.log(await manageVersion(rc.outDir, id, version, action, rc.publishPolicy ?? "all")); });
        await d.audit.record(who.name, "manage." + action, { job: job.id, target: id + "@" + version }, ip);
        json(res, 202, { job });
        return;
      }
      if (path === "/api/notes") {
        if (!d.notes) throw new HttpError(404, "notes are not enabled");
        if (method === "GET") { json(res, 200, { notes: await d.notes.list() }); return; }
        if (method === "POST") {
          const body = await readJson(req);
          try {
            const n = await d.notes.add(who.name, body.plugin, body.version, body.text, body.ref);
            await d.audit.record(who.name, "note.add", { target: n.plugin + "@" + n.version, note: n.id }, ip);
            json(res, 201, { note: n });
          } catch (e) { if (e instanceof NoteError) throw new HttpError(400, e.message); throw e; }
          return;
        }
      }
      if (method === "GET" && path === "/api/clients") {
        if (!d.activity) { json(res, 200, { enabled: false, clients: [], adoption: [] }); return; }
        const rc = await d.loadRegistryConfig();
        const views = clientViews(d.activity.store.clientRows(), await registryState(rc.outDir, d.publicKey));
        json(res, 200, { enabled: true, note: "Derived from registry downloads: shows the last version each client fetched, not what is installed or enabled.", error: d.activity.lastError, clients: views, adoption: adoption(views) });
        return;
      }
      if (method === "GET" && path === "/api/activity") {
        json(res, 200, { enabled: !!d.activity, events: d.activity ? d.activity.store.recent.slice().reverse().slice(0, 100) : [] });
        return;
      }
      if (method === "GET" && path === "/api/forwarder") { json(res, 200, d.forwarder ? d.forwarder.status() : { enabled: false }); return; }
      json(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpError) { json(res, e.status, { error: e.message }); return; }
      if (e instanceof Busy) { json(res, 409, { error: e.message, running: e.running.id }); return; }
      console.error("admin error:", (e as Error).message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  };
}

export async function createAdminServer(d: Deps): Promise<Server> {
  const handler = createHandler(d);
  const t = d.cfg.tls;
  if (!t) return createHttp(handler);
  const mtls = !!t.clientCa;
  return createHttps({
    cert: await readFile(t.cert), key: await readFile(t.key), minVersion: "TLSv1.2",
    // With password login also enabled, a missing client cert must not abort the handshake; the authenticators decide.
    ...(mtls ? { ca: await readFile(t.clientCa!), requestCert: true, rejectUnauthorized: !d.password } : {}),
  }, handler);
}
