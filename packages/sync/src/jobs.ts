import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promoteStaged, type PublishPolicy } from "./catalog";
import { makeReviewer } from "./reviewers";
import { reviewVersion, type Reviewer } from "./review";
import { loadRubric } from "./rubric";
import { makeFetcher, rebuildIndex, syncRegistry, type Config, type SyncResult } from "./sync";

/**
 * Admin jobs shared by the CLI and the admin service. Output goes through an injectable Log so the service can
 * capture it per job instead of writing to the process console.
 */
export interface Log { log(s: string): void; err(s: string): void }
export const consoleLog: Log = { log: (s) => console.log(s), err: (s) => console.error(s) };

/** Publishes staged versions that now satisfy the publish policy, then refreshes index.json. */
export async function publishHeld(outDir: string, policy: PublishPolicy, out: Log = consoleLog) {
  if (policy === "all") return;
  const ids = await readdir(join(outDir, "plugins"));
  const promoted = await promoteStaged(join(outDir, "plugins"), ids, policy);
  if (promoted.length) { await rebuildIndex(outDir, {}); promoted.forEach((p) => out.log(`  published ${p}`)); }
}

export async function allVersions(outDir: string) {
  const out: { id: string; version: string }[] = [];
  let ids: string[] = [];
  try { ids = await readdir(join(outDir, "plugins")); } catch { return out; }
  for (const id of ids) {
    for (const f of ["versions.json", "staged.json"]) {
      try { for (const v of JSON.parse(await readFile(join(outDir, "plugins", id, f), "utf8"))) out.push({ id, version: v.version }); } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * Where reviews run. Without this, reviews run in this process with the configured provider. The admin container passes
 * a queue reviewer instead, so the model call (and the API key) live in a separate container, and there is never a
 * fallback to a local spawn.
 */
export interface ReviewOpts {
  reviewer?: Reviewer;
  /** Returns a reason to skip (for example "the reviewer is not running"), or null to go ahead. */
  preflight?: () => Promise<string | null>;
  /** Re-review versions that already have an up-to-date review. Used for a single, explicitly chosen version only. */
  force?: boolean;
}

export async function runReviews(cfg: Config, targets: { id: string; version: string }[], out: Log = consoleLog, env: NodeJS.ProcessEnv = process.env, opts: ReviewOpts = {}) {
  const rc = cfg.review!;
  if (opts.preflight) { const why = await opts.preflight(); if (why) { out.err("review: " + why + "; skipping reviews"); return; } }
  if (!opts.reviewer && (rc.provider ?? "claude-code") === "claude-code" && !env.ANTHROPIC_API_KEY) { out.err("review: ANTHROPIC_API_KEY is not set; skipping reviews"); return; }
  const rubric = await loadRubric(rc.rubricDir ?? "rubric");
  out.log(`review: rubric ${rubric.version} (${rubric.rules.length} checks)`);
  const reviewer = opts.reviewer ?? makeReviewer(rc);
  const privatePem = rc.signingKeyPath ? await readFile(rc.signingKeyPath, "utf8") : undefined;
  let started = 0;
  for (const t of targets) {
    if (rc.maxReviewsPerRun && started >= rc.maxReviewsPerRun) { out.log(`review: reached maxReviewsPerRun (${rc.maxReviewsPerRun}); rest next run`); break; }
    try {
      const o = await reviewVersion(cfg.outDir, t.id, t.version, reviewer, { privatePem, model: rc.model, rubric, force: opts.force });
      if (o.status === "reviewed") started++;
      out.log(`  review ${o.status} ${t.id}@${t.version}: ${o.verdict}`);
    } catch (e) { out.err(`  review failed ${t.id}@${t.version}: ${(e as Error).message}`); }
  }
}

/** Mirrors new releases, then (if enabled) reviews what was added and publishes anything the policy now allows. */
export async function runSync(cfg: Config, out: Log = consoleLog, env: NodeJS.ProcessEnv = process.env, fetcher = makeFetcher(cfg.tokenEnv ? env[cfg.tokenEnv] : undefined), reviewOpts: ReviewOpts = {}): Promise<SyncResult> {
  const t0 = Date.now();
  out.log(`sync: checking ${cfg.repos.length} repositor${cfg.repos.length === 1 ? "y" : "ies"} at ${cfg.githubApiBase}` + (cfg.tokenEnv && !env[cfg.tokenEnv] ? ` (${cfg.tokenEnv} is not set: anonymous GitHub rate limit applies)` : ""));
  const r = await syncRegistry(cfg, fetcher, (l) => out.log(l));
  out.log(`result: added ${r.added.length}, already present ${r.skipped.length}, errors ${r.errors.length} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  r.errors.forEach((e) => out.err("  ! " + e));
  if (r.added.length) out.log("next: new versions are NOT approved. Approve on the admin host with: approve <id@version> --key <signing key> --registry <registry folder>");
  // Review problems are reported but never change the exit code (a flagged version must not keep a schedule red).
  if (cfg.review?.enabled) await runReviews(cfg, r.addedVersions, out, env, reviewOpts);
  await publishHeld(cfg.outDir, cfg.publishPolicy ?? "all", out);
  return r;
}
