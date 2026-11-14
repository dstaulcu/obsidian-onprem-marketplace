import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_RE, type Reviewer } from "./review";
import type { ProviderConfig } from "./reviewers";

/**
 * File queue between the admin service and the separate reviewer container.
 *
 * The reviewer does ONE job: send a prompt to the model and return the raw answer. Everything that decides anything
 * (hash checks, static scan, building the prompt, validating the answer, the verdict, writing review.html/review.json)
 * stays in the admin. The reviewer has no access to the registry, and the admin treats every byte coming back as
 * untrusted: it goes through the same schema validation and secret filter as a local model answer, so a compromised or
 * confused reviewer can produce an "error" verdict at worst, never a pass or a file in the served registry.
 *
 *   <queue>/requests/<uuid>.json   admin -> reviewer   { v: 1, prompt }
 *   <queue>/results/<uuid>.json    reviewer -> admin   { ok: true, output, model, costUsd? } | { ok: false, error }
 *   <queue>/heartbeat              touched by the reviewer every few seconds (mtime); the admin refuses to queue
 *                                  work when it is stale instead of making every version wait out a timeout
 *
 * Writes are temp file + rename, ids are UUIDs checked before they become file names, sizes are capped both ways.
 */
const ID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]json$/;
export const MAX_REQUEST_BYTES = 1_000_000; // prompts are capped near 60 KB of source plus rubric; this is generous
export const MAX_RESULT_BYTES = 256_000; // a verdict, a summary and a few findings
export const HEARTBEAT_STALE_MS = 30_000;
/** Longer than the reviewer's own 5 minute model timeout, so a slow review is reported by the reviewer, not guessed at. */
export const DEFAULT_WAIT_MS = 6 * 60_000;
const STALE_FILE_MS = 60 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[^ -~]/g, " ").slice(0, n);
const dirs = (q: string) => ({ req: join(q, "requests"), res: join(q, "results"), beat: join(q, "heartbeat") });

async function writeAtomic(path: string, data: string) {
  await writeFile(path + ".tmp", data, { mode: 0o600 });
  await rename(path + ".tmp", path);
}

export interface QueueReviewer extends Reviewer {
  /** null when a reviewer is alive, otherwise a short reason to show the admin. */
  ready(): Promise<string | null>;
}

/** Admin side: a Reviewer that hands the prompt to the reviewer container and waits for the answer. Never spawns anything. */
export function queueReviewer(queue: string, o: { waitMs?: number; pollMs?: number; staleMs?: number } = {}): QueueReviewer {
  const { req, res, beat } = dirs(queue);
  const rv = (async (prompt: string) => {
    const id = randomUUID();
    const body = JSON.stringify({ v: 1, prompt });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("prompt is too large for the review queue");
    await mkdir(req, { recursive: true });
    await writeAtomic(join(req, id + ".json"), body);
    const deadline = Date.now() + (o.waitMs ?? DEFAULT_WAIT_MS);
    const out = join(res, id + ".json");
    for (;;) {
      const r = await takeResult(out);
      if (r) return r;
      if (Date.now() >= deadline) break;
      await sleep(o.pollMs ?? 1000);
    }
    await rm(join(req, id + ".json"), { force: true }); // withdraw it if nobody picked it up
    throw new Error("the reviewer did not answer in time");
  }) as QueueReviewer;
  rv.ready = async () => {
    try {
      const age = Date.now() - (await stat(beat)).mtimeMs;
      return age <= (o.staleMs ?? HEARTBEAT_STALE_MS) ? null : "the reviewer container is not running (its heartbeat is stale)";
    } catch { return "the reviewer container is not running (no heartbeat found)"; }
  };
  return rv;
}

async function takeResult(path: string): Promise<{ output: unknown; model: string; costUsd?: number } | null> {
  let size: number;
  try { size = (await stat(path)).size; } catch { return null; }
  if (size > MAX_RESULT_BYTES) { await rm(path, { force: true }); throw new Error("the reviewer's answer was too large and was discarded"); }
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return null; }
  await rm(path, { force: true });
  let j: { ok?: unknown; error?: unknown; output?: unknown; model?: unknown; costUsd?: unknown };
  try { j = JSON.parse(text); } catch { throw new Error("the reviewer's answer was not valid JSON"); }
  if (!j || typeof j !== "object" || typeof j.ok !== "boolean") throw new Error("the reviewer's answer had an unexpected shape");
  if (!j.ok) throw new Error("reviewer reported: " + clip(j.error, 300));
  return { output: j.output, model: clip(j.model, 100), costUsd: typeof j.costUsd === "number" && Number.isFinite(j.costUsd) ? j.costUsd : undefined };
}

/**
 * Reviewer side: handles every request currently queued, oldest first, one at a time. Returns how many it handled.
 * A request is claimed by deleting it, so a crash mid-review loses that one request (the admin times out and records
 * an error verdict) but can never run it twice.
 */
export async function processQueueOnce(queue: string, reviewer: Reviewer, log: (s: string) => void = () => {}): Promise<number> {
  const { req, res } = dirs(queue);
  await mkdir(req, { recursive: true });
  await mkdir(res, { recursive: true });
  const names = (await readdir(req)).filter((n) => ID_FILE.test(n));
  const dated: { n: string; t: number }[] = [];
  for (const n of names) { try { dated.push({ n, t: (await stat(join(req, n))).mtimeMs }); } catch { /* raced away */ } }
  dated.sort((a, b) => a.t - b.t);
  let done = 0;
  for (const { n } of dated) {
    const path = join(req, n), out = join(res, n);
    const fail = (why: string) => writeAtomic(out, JSON.stringify({ ok: false, error: why }));
    let size = 0;
    try { size = (await stat(path)).size; } catch { continue; }
    done++; // handled (answered or rejected) from here on
    if (size > MAX_REQUEST_BYTES) { await rm(path, { force: true }); await fail("request too large"); continue; }
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    await rm(path, { force: true }); // claim
    let prompt: unknown;
    try { const j = JSON.parse(text) as { v?: unknown; prompt?: unknown }; if (j.v === 1) prompt = j.prompt; } catch { /* handled below */ }
    if (typeof prompt !== "string" || !prompt) { await fail("malformed request"); continue; }
    log(`review ${n.slice(0, 8)}: started (${prompt.length} chars)`);
    try {
      const r = await reviewer(prompt);
      const body = JSON.stringify({ ok: true, output: r.output, model: clip(r.model, 100), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) });
      if (Buffer.byteLength(body) > MAX_RESULT_BYTES) await fail("model answer too large");
      else if (SECRET_RE.test(body)) await fail("model answer contained secret-like content and was discarded");
      else await writeAtomic(out, body);
      log(`review ${n.slice(0, 8)}: answered`);
    } catch (e) {
      const msg = clip((e as Error).message, 300);
      await fail(SECRET_RE.test(msg) ? "reviewer failed (details withheld: secret-like content)" : msg);
      log(`review ${n.slice(0, 8)}: failed: ${msg}`);
    }
  }
  await sweep(req); await sweep(res);
  return done;
}

/** Removes anything left over for more than an hour (an admin that never collected, or a request nobody took). */
async function sweep(dir: string) {
  try {
    for (const n of await readdir(dir)) {
      try { if (Date.now() - (await stat(join(dir, n))).mtimeMs > STALE_FILE_MS) await rm(join(dir, n), { force: true }); } catch { /* raced */ }
    }
  } catch { /* directory missing */ }
}

export async function touchHeartbeat(queue: string) {
  const { beat } = dirs(queue);
  const now = new Date();
  try { await utimes(beat, now, now); } catch { await mkdir(queue, { recursive: true }); await writeFile(beat, now.toISOString()); }
}

/** Long-running worker loop. `stop.now` ends it; the heartbeat keeps beating while a long review is in flight. */
export async function runWorker(queue: string, reviewer: Reviewer, stop: { now: boolean }, log: (s: string) => void = () => {}, pollMs = 1000) {
  await touchHeartbeat(queue);
  const timer = setInterval(() => { void touchHeartbeat(queue).catch(() => {}); }, 5000);
  try {
    while (!stop.now) {
      try { await processQueueOnce(queue, reviewer, log); } catch (e) { log("worker error: " + (e as Error).message); }
      await sleep(pollMs);
    }
  } finally { clearInterval(timer); }
}

/** Both sides refuse a review setup that cannot work across the queue (a harness that needs the plugin files on disk). */
export function validateReviewQueue(review: ProviderConfig | undefined): string[] {
  if (!review) return ["the registry config has no \"review\" section"];
  if (review.provider === "wrapper" && review.wrapper?.stageFiles)
    return ["review.wrapper.stageFiles cannot be used with a review queue: the reviewer container never receives the plugin files, only the prompt"];
  return [];
}
