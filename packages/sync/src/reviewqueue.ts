import type { Reviewer } from "./review";
import type { ProviderConfig } from "./reviewers";
import { clip, HEARTBEAT_STALE_MS, processQueue, queueCall, queueReady, runLoop, touchHeartbeat, type CallOpts } from "./workqueue";

export { MAX_REQUEST_BYTES, MAX_RESULT_BYTES, HEARTBEAT_STALE_MS, touchHeartbeat } from "./workqueue";

/**
 * The reviewer side of the work queue (see workqueue.ts for the protocol and its limits).
 *
 * The reviewer container does ONE job: send a prompt to the model and return the raw answer. Everything that decides anything
 * (hash checks, static scan, building the prompt, validating the answer, the verdict, writing review.html/review.json) stays in
 * the admin. The reviewer has no access to the registry, and the admin treats its answer as untrusted: it goes through the same
 * schema validation and secret filter as a local model answer, so a compromised or confused reviewer can produce an "error"
 * verdict at worst, never a pass or a file in the served registry.
 */
/** Longer than the reviewer's own 5 minute model timeout, so a slow review is reported by the reviewer, not guessed at. */
export const DEFAULT_WAIT_MS = 6 * 60_000;

export interface QueueReviewer extends Reviewer {
  /** null when a reviewer is alive, otherwise a short reason to show the admin. */
  ready(): Promise<string | null>;
}

/** Admin side: a Reviewer that hands the prompt to the reviewer container and waits for the answer. Never spawns anything. */
export function queueReviewer(queue: string, o: Omit<CallOpts, "waitMs"> & { waitMs?: number } = {}): QueueReviewer {
  const rv = (async (prompt: string) => {
    const j = await queueCall(queue, { prompt }, { ...o, what: "reviewer", waitMs: o.waitMs ?? DEFAULT_WAIT_MS });
    return { output: j.output, model: clip(j.model, 100), costUsd: typeof j.costUsd === "number" && Number.isFinite(j.costUsd) ? j.costUsd : undefined };
  }) as QueueReviewer;
  rv.ready = () => queueReady(queue, "reviewer", o.staleMs ?? HEARTBEAT_STALE_MS);
  return rv;
}

const handler = (reviewer: Reviewer) => async (req: Record<string, unknown>) => {
  if (typeof req.prompt !== "string" || !req.prompt) throw new Error("malformed request");
  const r = await reviewer(req.prompt);
  return { output: r.output, model: clip(r.model, 100), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
};

/** Reviewer side: handles every request currently queued. Returns how many it handled. */
export const processQueueOnce = (queue: string, reviewer: Reviewer, log: (s: string) => void = () => {}) => processQueue(queue, handler(reviewer), log);

/** Long-running worker loop for the reviewer container. */
export const runWorker = (queue: string, reviewer: Reviewer, stop: { now: boolean }, log: (s: string) => void = () => {}, pollMs = 1000) =>
  runLoop(queue, handler(reviewer), stop, log, pollMs);

/** Both sides refuse a review setup that cannot work across the queue (a harness that needs the plugin files on disk). */
export function validateReviewQueue(review: ProviderConfig | undefined): string[] {
  if (!review) return ["the registry config has no \"review\" section"];
  if (review.provider === "wrapper" && review.wrapper?.stageFiles)
    return ["review.wrapper.stageFiles cannot be used with a review queue: the reviewer container never receives the plugin files, only the prompt"];
  return [];
}
