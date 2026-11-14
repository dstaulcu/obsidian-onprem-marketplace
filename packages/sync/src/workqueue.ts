import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_RE } from "./review";

/**
 * Generic file queue between the admin service and a separate worker container (the reviewer, the signer). The worker holds
 * a credential the admin must not (a model key, the signing key); the admin treats every byte that comes back as untrusted.
 *
 *   <queue>/requests/<uuid>.json   admin -> worker   { v: 1, ...request }
 *   <queue>/results/<uuid>.json    worker -> admin   { ok: true, ...fields } | { ok: false, error }
 *   <queue>/heartbeat              touched by the worker every few seconds (mtime); the admin refuses to queue work when it
 *                                  is stale instead of making every item wait out a timeout
 *
 * Writes are temp file + rename, ids are UUIDs checked before they become file names, sizes are capped both ways, and a
 * worker answer that looks like it contains a secret is replaced by an error.
 */
const ID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]json$/;
export const MAX_REQUEST_BYTES = 1_000_000;
export const MAX_RESULT_BYTES = 256_000;
export const HEARTBEAT_STALE_MS = 30_000;
const STALE_FILE_MS = 60 * 60_000;

export type Fields = Record<string, unknown>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Printable text only, clipped. Anything a worker says is shown to admins, so control characters are dropped. */
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/[^ -~]/g, " ").slice(0, n);
const dirs = (q: string) => ({ req: join(q, "requests"), res: join(q, "results"), beat: join(q, "heartbeat") });

async function writeAtomic(path: string, data: string) {
  await writeFile(path + ".tmp", data, { mode: 0o600 });
  await rename(path + ".tmp", path);
}

export interface CallOpts { waitMs?: number; pollMs?: number; staleMs?: number; /** What to call the worker in messages, e.g. "reviewer". */ what?: string }

/** Admin side: queue one request and wait for the worker's answer. Throws if the worker reports an error or answers badly. */
export async function queueCall(queue: string, request: Fields, o: CallOpts & { waitMs: number }): Promise<Fields> {
  const { req, res } = dirs(queue);
  const id = randomUUID();
  const body = JSON.stringify({ v: 1, ...request });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("request is too large for the queue");
  await mkdir(req, { recursive: true });
  await writeAtomic(join(req, id + ".json"), body);
  const out = join(res, id + ".json");
  const deadline = Date.now() + o.waitMs;
  for (;;) {
    const r = await takeResult(out, o.what ?? "worker");
    if (r) return r;
    if (Date.now() >= deadline) break;
    await sleep(o.pollMs ?? 1000);
  }
  await rm(join(req, id + ".json"), { force: true }); // withdraw it if nobody picked it up
  throw new Error(`the ${o.what ?? "worker"} did not answer in time`);
}

/** null when a worker is alive, otherwise a short reason to show the admin. */
export async function queueReady(queue: string, what: string, staleMs = HEARTBEAT_STALE_MS): Promise<string | null> {
  try {
    const age = Date.now() - (await stat(dirs(queue).beat)).mtimeMs;
    return age <= staleMs ? null : `the ${what} container is not running (its heartbeat is stale)`;
  } catch { return `the ${what} container is not running (no heartbeat found)`; }
}

async function takeResult(path: string, what: string): Promise<Fields | null> {
  let size: number;
  try { size = (await stat(path)).size; } catch { return null; }
  if (size > MAX_RESULT_BYTES) { await rm(path, { force: true }); throw new Error(`the ${what}'s answer was too large and was discarded`); }
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return null; }
  await rm(path, { force: true });
  let j: Fields;
  try { j = JSON.parse(text) as Fields; } catch { throw new Error(`the ${what}'s answer was not valid JSON`); }
  if (!j || typeof j !== "object" || Array.isArray(j) || typeof j.ok !== "boolean") throw new Error(`the ${what}'s answer had an unexpected shape`);
  if (!j.ok) throw new Error(`${what} reported: ` + clip(j.error, 300));
  return j;
}

/**
 * Worker side: handles every request currently queued, oldest first, one at a time. Returns how many it handled. A request is
 * claimed by deleting it, so a crash mid-way loses that one request (the admin times out) but can never run it twice.
 */
export async function processQueue(queue: string, handle: (req: Fields) => Promise<Fields>, log: (s: string) => void = () => {}): Promise<number> {
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
    let request: Fields | null = null;
    try { const j = JSON.parse(text) as Fields; if (j && typeof j === "object" && !Array.isArray(j) && j.v === 1) request = j; } catch { /* handled below */ }
    if (!request) { await fail("malformed request"); continue; }
    const tag = n.slice(0, 8);
    log(`request ${tag}: started`);
    try {
      const body = JSON.stringify({ ...(await handle(request)), ok: true });
      if (Buffer.byteLength(body) > MAX_RESULT_BYTES) await fail("answer too large");
      else if (SECRET_RE.test(body)) await fail("answer contained secret-like content and was discarded");
      else await writeAtomic(out, body);
      log(`request ${tag}: answered`);
    } catch (e) {
      const msg = clip((e as Error).message, 300);
      await fail(SECRET_RE.test(msg) ? "worker failed (details withheld: secret-like content)" : msg);
      log(`request ${tag}: failed: ${msg}`);
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

/** Long-running worker loop. `stop.now` ends it; the heartbeat keeps beating while a long request is in flight. */
export async function runLoop(queue: string, handle: (req: Fields) => Promise<Fields>, stop: { now: boolean }, log: (s: string) => void = () => {}, pollMs = 1000) {
  await touchHeartbeat(queue);
  const timer = setInterval(() => { void touchHeartbeat(queue).catch(() => {}); }, 5000);
  try {
    while (!stop.now) {
      try { await processQueue(queue, handle, log); } catch (e) { log("worker error: " + (e as Error).message); }
      await sleep(pollMs);
    }
  } finally { clearInterval(timer); }
}
