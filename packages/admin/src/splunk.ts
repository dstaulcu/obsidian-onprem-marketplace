import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { normalizeAudit, parseAccessLine, type Network } from "./events";
import { readJson, readNewLines, writeJsonAtomic, type Cursor } from "./tail";

/**
 * Forwards events to a Splunk HTTP Event Collector. Delivery is at-least-once: a cursor only advances after HEC answers
 * 200, every event carries a stable `id` (source + byte offset) so Splunk can de-duplicate a re-sent batch, and a
 * failure never blocks the dashboard (this has its own cursors, independent of the stats processor).
 */
export interface SplunkConfig {
  /** e.g. https://splunk.example.internal:8088 (the /services/collector/event path is added). */
  url: string;
  /** Name of the environment variable holding the HEC token, or a file containing it. The token is never in this config. */
  tokenEnv?: string;
  tokenFile?: string;
  /** Omitted when unset: an index the token may not write to makes HEC reject the whole batch. */
  index?: string;
  sourcetype?: string;
  source?: string;
  host?: string;
  /** PEM CA bundle to trust (on-prem Splunk is often self-signed). Verification is never switched off. */
  caFile?: string;
  /** Allow http:// (development only). */
  allowInsecureHttp?: boolean;
  /** Raw log bytes read per batch (default 256). */
  batchKB?: number;
  /** On first enable, also send the existing history. Default false: start at the end of the log. */
  backfill?: boolean;
  /** Which streams to send. Default both. */
  forward?: ("access" | "audit")[];
}

export function validateSplunk(c: SplunkConfig): string[] {
  const e: string[] = [];
  let u: URL | null = null;
  try { u = new URL(c.url); } catch { e.push("splunk.url is not a valid URL"); }
  if (u && u.protocol !== "https:" && !(u.protocol === "http:" && c.allowInsecureHttp)) e.push("splunk.url must be https:// (set splunk.allowInsecureHttp only for development)");
  if ((c.tokenEnv ? 1 : 0) + (c.tokenFile ? 1 : 0) !== 1) e.push("set exactly one of splunk.tokenEnv or splunk.tokenFile (the token itself never goes in this file)");
  if (c.batchKB !== undefined && !(c.batchKB >= 1 && c.batchKB <= 4096)) e.push("splunk.batchKB must be 1-4096");
  for (const f of c.forward ?? []) if (f !== "access" && f !== "audit") e.push(`splunk.forward: unknown stream ${String(f)}`);
  return e;
}

export interface HecResult { ok: boolean; status: number; text: string }
export type HecPost = (body: string) => Promise<HecResult>;

export async function resolveToken(c: SplunkConfig, env: NodeJS.ProcessEnv): Promise<string> {
  const t = c.tokenEnv ? env[c.tokenEnv] : c.tokenFile ? await readFile(c.tokenFile, "utf8") : "";
  return (t ?? "").trim();
}

/** The real transport: node:https so a per-connection CA bundle is possible (global fetch cannot do that). */
export async function makeHecPost(c: SplunkConfig, env: NodeJS.ProcessEnv): Promise<HecPost> {
  const token = await resolveToken(c, env);
  if (!token) throw new Error(c.tokenEnv ? `environment variable ${c.tokenEnv} is empty or unset` : `token file ${c.tokenFile} is empty`);
  const ca = c.caFile ? await readFile(c.caFile) : undefined;
  const url = new URL(c.url);
  const path = url.pathname.replace(/\/+$/, "") + "/services/collector/event";
  const scrub = (s: string) => s.split(token).join("[token]").slice(0, 300);
  return (body) => new Promise<HecResult>((resolve) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      host: url.hostname, port: url.port || undefined, path, method: "POST", timeout: 15_000, ...(ca ? { ca } : {}),
      headers: { Authorization: `Splunk ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let text = ""; res.on("data", (d) => { if (text.length < 1000) text += d; });
      res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, text: scrub(text) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, status: 0, text: scrub(e.message) }));
    req.end(body);
  });
}

/** One HEC envelope per event, concatenated (HEC accepts a stream of JSON objects). `time` is the ORIGINAL event time. */
export function buildBatch(events: Record<string, unknown>[], c: SplunkConfig, host: string): string {
  return events.map((event) => {
    const t = Date.parse(String(event.time));
    return JSON.stringify({
      time: Number.isNaN(t) ? undefined : t / 1000, host, source: c.source ?? "om-admin", sourcetype: c.sourcetype ?? "om:event",
      ...(c.index ? { index: c.index } : {}), event,
    });
  }).join("");
}

export interface ForwarderStatus {
  enabled: boolean; url: string; sent: number; lastOk: string | null; lastError: string | null; failures: number; retryAt: string | null;
}
interface ForwarderState { access: Cursor | null; audit: Cursor | null; sent: number }

export interface ForwarderDeps { accessLog?: string; auditLog: string; stateFile: string; networks: Network[]; basePath?: string; host?: string }

export class SplunkForwarder {
  private st: ForwarderState = { access: null, audit: null, sent: 0 };
  private loaded = false;
  private lastOk: string | null = null;
  lastError: string | null = null;
  private failures = 0;
  private retryAt = 0;
  constructor(private c: SplunkConfig, private d: ForwarderDeps, private post: HecPost) {}

  status(): ForwarderStatus {
    return { enabled: true, url: this.c.url, sent: this.st.sent, lastOk: this.lastOk, lastError: this.lastError, failures: this.failures, retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null };
  }

  /** Sends a one-off event (not tied to any cursor) to check URL, token, CA and index. */
  async sendTest(): Promise<HecResult> {
    return this.post(buildBatch([{ schema: 1, id: `test:${Date.now()}`, time: new Date().toISOString(), type: "om.test", message: "om-admin connectivity test" }], this.c, this.host()));
  }

  private host() { return this.c.host ?? this.d.host ?? hostname(); }

  /** One pass over each enabled stream. Returns events sent. Never throws. */
  async step(now = Date.now()): Promise<number> {
    if (now < this.retryAt) return 0;
    if (!this.loaded) { this.st = { ...this.st, ...(await readJson<ForwarderState>(this.d.stateFile) ?? {}) }; this.loaded = true; }
    const streams = this.c.forward ?? ["access", "audit"];
    let total = 0;
    for (const s of streams) {
      const file = s === "access" ? this.d.accessLog : this.d.auditLog;
      if (!file) continue;
      try {
        const r = await readNewLines(file, this.st[s], { maxBytes: (this.c.batchKB ?? 256) * 1024, startAtEnd: !this.c.backfill });
        if (!r) continue;
        const events: Record<string, unknown>[] = [];
        for (const l of r.lines) {
          const e = s === "access"
            ? parseAccessLine(l.text, { source: "access", offset: l.offset, networks: this.d.networks, basePath: this.d.basePath }) as Record<string, unknown> | null
            : normalizeAudit(l.text, "audit", l.offset);
          if (e) events.push(e);
        }
        if (events.length) {
          const res = await this.post(buildBatch(events, this.c, this.host()));
          if (!res.ok) {
            this.failures++;
            this.lastError = `HEC ${res.status || "unreachable"}: ${res.text}`.trim();
            this.retryAt = now + Math.min(300, 5 * 2 ** Math.min(this.failures, 6)) * 1000;
            return total; // do NOT advance: the batch is re-sent after the backoff
          }
          this.st.sent += events.length; total += events.length;
          this.lastOk = new Date(now).toISOString();
        }
        this.failures = 0; this.lastError = null; this.retryAt = 0;
        this.st[s] = r.next;
        await writeJsonAtomic(this.d.stateFile, this.st);
      } catch (e) { this.lastError = (e as Error).message; this.failures++; this.retryAt = now + 30_000; return total; }
    }
    return total;
  }
}
