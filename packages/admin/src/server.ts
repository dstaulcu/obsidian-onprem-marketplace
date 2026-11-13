import { createServer as createHttp, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFile } from "node:fs/promises";
import { isSafeVersion, isValidPluginId } from "@om/shared";
import type { Config, Fetcher } from "@om/sync/src/sync";
import { allVersions, publishHeld, runReviews, runSync } from "@om/sync/src/jobs";
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
        json(res, 200, { registryUrl: d.cfg.registryUrl ?? null, plugins: await registryState(rc.outDir, d.publicKey) });
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
          const r = await runSync(rc, log, d.env, d.fetcher);
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
        else if (typeof body.id === "string" && typeof body.version === "string" && isValidPluginId(body.id) && isSafeVersion(body.version)) targets = [{ id: body.id, version: body.version }];
        else throw new HttpError(400, "send {\"all\":true} or {\"id\",\"version\"}");
        const job = d.jobs.start("review", who.name, async (log) => {
          await runReviews(rc, targets, log, d.env);
          await publishHeld(rc.outDir, rc.publishPolicy ?? "all", log);
        });
        await d.audit.record(who.name, "review.start", { job: job.id, targets: body.all === true ? "all" : `${targets[0].id}@${targets[0].version}` }, ip);
        json(res, 202, { job });
        return;
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
