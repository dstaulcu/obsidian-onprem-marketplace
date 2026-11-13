import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promoteStaged, type PublishPolicy } from "./catalog";
import { makeReviewer } from "./reviewers";
import { reviewVersion } from "./review";
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

export async function runReviews(cfg: Config, targets: { id: string; version: string }[], out: Log = consoleLog, env: NodeJS.ProcessEnv = process.env) {
  const rc = cfg.review!;
  if ((rc.provider ?? "claude-code") === "claude-code" && !env.ANTHROPIC_API_KEY) { out.err("review: ANTHROPIC_API_KEY is not set; skipping reviews"); return; }
  const rubric = await loadRubric(rc.rubricDir ?? "rubric");
  out.log(`review: rubric ${rubric.version} (${rubric.rules.length} checks)`);
  const reviewer = makeReviewer(rc);
  const privatePem = rc.signingKeyPath ? await readFile(rc.signingKeyPath, "utf8") : undefined;
  let started = 0;
  for (const t of targets) {
    if (rc.maxReviewsPerRun && started >= rc.maxReviewsPerRun) { out.log(`review: reached maxReviewsPerRun (${rc.maxReviewsPerRun}); rest next run`); break; }
    try {
      const o = await reviewVersion(cfg.outDir, t.id, t.version, reviewer, { privatePem, model: rc.model, rubric });
      if (o.status === "reviewed") started++;
      out.log(`  review ${o.status} ${t.id}@${t.version}: ${o.verdict}`);
    } catch (e) { out.err(`  review failed ${t.id}@${t.version}: ${(e as Error).message}`); }
  }
}

/** Mirrors new releases, then (if enabled) reviews what was added and publishes anything the policy now allows. */
export async function runSync(cfg: Config, out: Log = consoleLog, env: NodeJS.ProcessEnv = process.env, fetcher = makeFetcher(cfg.tokenEnv ? env[cfg.tokenEnv] : undefined)): Promise<SyncResult> {
  const r = await syncRegistry(cfg, fetcher);
  out.log(`added ${r.added.length}, skipped ${r.skipped.length}, errors ${r.errors.length}`);
  r.added.forEach((a) => out.log("  + " + a));
  r.errors.forEach((e) => out.err("  ! " + e));
  // Review problems are reported but never change the exit code (a flagged version must not keep a schedule red).
  if (cfg.review?.enabled) await runReviews(cfg, r.addedVersions, out, env);
  await publishHeld(cfg.outDir, cfg.publishPolicy ?? "all", out);
  return r;
}
