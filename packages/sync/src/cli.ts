import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFetcher, syncRegistry, type Config } from "./sync";
import { approveVersion, generateKeys } from "./signing";
import { reviewVersion } from "./review";
import { makeReviewer } from "./reviewers";
import { promoteStaged, type PublishPolicy } from "./catalog";
import { loadRubric, renderRubricDoc, testRule } from "./rubric";
import { rebuildIndex } from "./sync";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "keygen") {
  // om-sync keygen <dir>  -> <dir>/signing-key.pem (SECRET) and <dir>/public-key.txt (give to clients)
  const dir = rest[0];
  if (!dir) { console.error("usage: keygen <dir>"); process.exit(2); }
  const priv = join(dir, "signing-key.pem");
  if (await access(priv).then(() => true, () => false)) { console.error(`${priv} exists; refusing to overwrite`); process.exit(1); }
  await mkdir(dir, { recursive: true });
  const k = generateKeys();
  await writeFile(priv, k.privatePem, { mode: 0o600 });
  await writeFile(join(dir, "public-key.txt"), k.publicSpkiB64 + "\n");
  console.log(`Wrote ${priv} (keep secret, never commit) and public-key.txt (pin this in clients).`);
} else if (cmd === "approve") {
  // om-sync approve <id@version> --key <pem> [--registry registry] [--by name] [--override "reason"] [--policy all|reviewed-pass|approved]
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const [id, version] = (rest[0] ?? "").split("@");
  const keyPath = flag("key");
  if (!id || !version || !keyPath) { console.error("usage: approve <id@version> --key <pem> [--registry dir] [--by name]"); process.exit(2); }
  const by = flag("by", process.env.USERNAME ?? process.env.USER ?? "admin")!;
  const registry = flag("registry", "registry")!;
  const a = await approveVersion(registry, id, version, await readFile(keyPath, "utf8"), by, flag("override"));
  console.log(`approved ${a.id}@${a.version} by ${a.approvedBy} (review: ${a.reviewVerdict}${a.override ? `, override: ${a.override}` : ""})`);
  await publishHeld(registry, (flag("policy") as PublishPolicy | undefined) ?? "all");
} else if (cmd === "rubric") {
  // om-sync rubric [--dir rubric] [--write docs/concepts/rubric.md]   -> validates the rubric, runs every rule's examples
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const rb = await loadRubric(flag("dir", "rubric")!);
  const fails = rb.rules.flatMap(testRule);
  if (fails.length) { fails.forEach((f) => console.error("  x " + f)); process.exit(1); }
  console.log(`rubric ${rb.version}: ${rb.rules.length} checks, all examples pass`);
  const out = flag("write");
  if (out) { await writeFile(out, renderRubricDoc(rb)); console.log(`wrote ${out}`); }
} else if (cmd === "review") {
  // om-sync review <id@version | --all> [--config registry.config.json]
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const cfg = JSON.parse(await readFile(flag("config", "registry.config.json")!, "utf8")) as Config;
  if (!cfg.review) { console.error("no \"review\" section in config"); process.exit(2); }
  let targets: { id: string; version: string }[];
  if (rest.includes("--all")) targets = await allVersions(cfg.outDir);
  else { const [id, version] = (rest[0] ?? "").split("@"); if (!id || !version) { console.error("usage: review <id@version | --all>"); process.exit(2); } targets = [{ id, version }]; }
  await runReviews(cfg, targets);
  await publishHeld(cfg.outDir, cfg.publishPolicy ?? "all");
} else {
  const cfgPath = cmd ?? "registry.config.json";
  const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Config;
  const token = cfg.tokenEnv ? process.env[cfg.tokenEnv] : undefined;
  const r = await syncRegistry(cfg, makeFetcher(token));
  console.log(`added ${r.added.length}, skipped ${r.skipped.length}, errors ${r.errors.length}`);
  r.added.forEach((a) => console.log("  + " + a));
  r.errors.forEach((e) => console.error("  ! " + e));
  // Review problems are reported but never change the exit code (a flagged version must not keep a schedule red).
  if (cfg.review?.enabled) await runReviews(cfg, r.addedVersions);
  await publishHeld(cfg.outDir, cfg.publishPolicy ?? "all");
  process.exit(r.errors.length ? 1 : 0);
}

/** Publishes staged versions that now satisfy the publish policy, then refreshes index.json. */
async function publishHeld(outDir: string, policy: PublishPolicy) {
  if (policy === "all") return;
  const ids = await readdir(join(outDir, "plugins"));
  const promoted = await promoteStaged(join(outDir, "plugins"), ids, policy);
  if (promoted.length) { await rebuildIndex(outDir, {}); promoted.forEach((p) => console.log(`  published ${p}`)); }
}

async function allVersions(outDir: string) {
  const out: { id: string; version: string }[] = [];
  for (const id of await readdir(join(outDir, "plugins"))) {
    for (const f of ["versions.json", "staged.json"]) {
      try { for (const v of JSON.parse(await readFile(join(outDir, "plugins", id, f), "utf8"))) out.push({ id, version: v.version }); } catch { /* skip */ }
    }
  }
  return out;
}

async function runReviews(cfg: Config, targets: { id: string; version: string }[]) {
  const rc = cfg.review!;
  if ((rc.provider ?? "claude-code") === "claude-code" && !process.env.ANTHROPIC_API_KEY) { console.error("review: ANTHROPIC_API_KEY is not set; skipping reviews"); return; }
  const rubric = await loadRubric(rc.rubricDir ?? "rubric");
  console.log(`review: rubric ${rubric.version} (${rubric.rules.length} checks)`);
  const reviewer = makeReviewer(rc);
  const privatePem = rc.signingKeyPath ? await readFile(rc.signingKeyPath, "utf8") : undefined;
  let started = 0;
  for (const t of targets) {
    if (rc.maxReviewsPerRun && started >= rc.maxReviewsPerRun) { console.log(`review: reached maxReviewsPerRun (${rc.maxReviewsPerRun}); rest next run`); break; }
    try {
      const o = await reviewVersion(cfg.outDir, t.id, t.version, reviewer, { privatePem, model: rc.model, rubric });
      if (o.status === "reviewed") started++;
      console.log(`  review ${o.status} ${t.id}@${t.version}: ${o.verdict}`);
    } catch (e) { console.error(`  review failed ${t.id}@${t.version}: ${(e as Error).message}`); }
  }
}
