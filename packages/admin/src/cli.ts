import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "@om/sync/src/sync";
import type { ReviewOpts } from "@om/sync/src/jobs";
import { queueReviewer, validateReviewQueue } from "@om/sync/src/reviewqueue";
import { LoginLimiter, setPassword } from "./auth/password";
import { mtlsAuthenticator } from "./auth/mtls";
import { SessionStore } from "./auth/session";
import type { Authenticator } from "./auth/types";
import { fileAudit } from "./audit";
import { NoteStore } from "./notes";
import { loadAdminConfig } from "./config";
import { JobRunner } from "./jobs";
import { createAdminServer } from "./server";
import { AccessProcessor, publishStats } from "./activity";
import { makeHecPost, SplunkForwarder } from "./splunk";
import type { AdminConfig } from "./config";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };

const HELP = `om-admin - web admin for the marketplace registry

  splunk-test [--config admin.config.json]  send one test event to the configured Splunk HEC and report the result
  serve  [--config admin.config.json]       start the admin service (mTLS and/or password login; TLS required)
  passwd <user> [--users admin-users.json]  add or change a local admin password (prompted; or OM_ADMIN_PASSWORD)`;

/** Reads a password without echoing it (TTY), or one line from stdin when piped. */
function prompt(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(label);
    let buf = "";
    const tty = process.stdin.isTTY;
    if (tty) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          process.stdin.off("data", onData);
          if (tty) process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1); else buf += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function buildForwarder(cfg: AdminConfig): Promise<SplunkForwarder | null> {
  if (!cfg.splunk) return null;
  const post = await makeHecPost(cfg.splunk, process.env);
  const stateDir = cfg.stateDir ?? join(dirname(cfg.auditLog), "state");
  return new SplunkForwarder(cfg.splunk, { accessLog: cfg.accessLog, auditLog: cfg.auditLog, stateFile: join(stateDir, "splunk.json"), networks: cfg.networks ?? [], basePath: cfg.basePath }, post);
}

async function main() {
  if (cmd === "splunk-test") {
    const cfg = await loadAdminConfig(flag("config", "admin.config.json")!);
    const fwd = await buildForwarder(cfg);
    if (!fwd) { console.error("no \"splunk\" section in the config"); return 2; }
    const r = await fwd.sendTest();
    console.log(r.ok ? "HEC accepted the test event (HTTP 200)." : `HEC refused it: HTTP ${r.status || "unreachable"} ${r.text}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "passwd") {
    const users = flag("users", "admin-users.json")!;
    const user = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--users");
    if (!user) { console.error("usage: passwd <user> [--users file]"); return 2; }
    let pw = process.env.OM_ADMIN_PASSWORD;
    if (pw === undefined) {
      pw = await prompt("New password (min 12 chars): ");
      if ((await prompt("Repeat: ")) !== pw) { console.error("passwords differ"); return 1; }
    }
    try { await setPassword(users, user, pw); console.log(`saved ${user} in ${users}`); return 0; } catch (e) { console.error((e as Error).message); return 1; }
  }
  if (cmd === "serve") {
    const cfg = await loadAdminConfig(flag("config", "admin.config.json")!);
    const publicKey = cfg.publicKeyFile ? (await readFile(cfg.publicKeyFile, "utf8")).trim() : "";
    if (!publicKey) console.warn("warning: no publicKeyFile configured; approvals and signed reviews are shown as unverified");
    const authenticators: Authenticator[] = cfg.mtls ? [mtlsAuthenticator(cfg.mtls.allow)] : [];
    const p = cfg.password;
    // Background work: tail the access log into the dashboard store, forward to Splunk, publish counts-only stats.json.
    // Each runs on its own cursor and never throws, so a Splunk outage cannot stall the dashboard or the API.
    const stateDir = cfg.stateDir ?? join(dirname(cfg.auditLog), "state");
    const activity = cfg.accessLog ? new AccessProcessor({ logFile: cfg.accessLog, stateFile: join(stateDir, "activity.json"), networks: cfg.networks ?? [], basePath: cfg.basePath }) : undefined;
    const forwarder = await buildForwarder(cfg);
    const loadRc = async () => JSON.parse(await readFile(cfg.registryConfig, "utf8")) as Config;
    // With a review queue, the model call happens in the separate reviewer container and never in this process.
    let reviewOpts: ReviewOpts | undefined;
    if (cfg.reviewQueue) {
      const bad = validateReviewQueue((await loadRc()).review);
      if (bad.length) { bad.forEach((b) => console.error("review queue: " + b)); return 1; }
      const q = queueReviewer(cfg.reviewQueue);
      reviewOpts = { reviewer: q, preflight: () => q.ready() };
    }
    const server = await createAdminServer({
      cfg, publicKey, authenticators, activity, forwarder, jobs: new JobRunner(), audit: fileAudit(cfg.auditLog), secure: !!cfg.tls, env: process.env,
      loadRegistryConfig: loadRc, reviewOpts, notes: new NoteStore(join(stateDir, "notes.jsonl")),
      password: p ? {
        usersFile: p.usersFile,
        sessions: new SessionStore((p.idleMinutes ?? 30) * 60_000, (p.maxHours ?? 8) * 3_600_000),
        limiter: new LoginLimiter(p.maxFailures ?? 5, 15 * 60_000, (p.lockoutMinutes ?? 15) * 60_000),
      } : undefined,
    });
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { if (activity) await activity.step(); if (forwarder) await forwarder.step(); } finally { busy = false; }
    };
    const publish = async () => {
      if (!activity || !cfg.stats?.publish) return;
      try { await publishStats((await loadRc()).outDir, activity.store, cfg.stats.windowDays ?? 30, cfg.stats.minCount ?? 5); } catch (e) { console.error("stats publish failed:", (e as Error).message); }
    };
    setInterval(() => { void tick(); }, 10_000).unref();
    setInterval(() => { void publish(); }, 5 * 60_000).unref();
    void tick().then(publish);
    const port = cfg.listen?.port ?? 8443, host = cfg.listen?.host ?? "0.0.0.0";
    server.listen(port, host, () => console.log(`admin listening on ${cfg.tls ? "https" : "http (INSECURE, development only)"}://${host}:${port}  methods: ${[cfg.mtls && "mtls", cfg.password && "password"].filter(Boolean).join(", ")}`));
    return null; // keep running
  }
  console.log(HELP);
  return cmd === "help" ? 0 : 2;
}

main().then((code) => { if (code !== null) process.exit(code); }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
