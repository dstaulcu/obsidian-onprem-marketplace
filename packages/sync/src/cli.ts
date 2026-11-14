import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config } from "./sync";
import { approveVersion, generateKeys } from "./signing";
import { type PublishPolicy } from "./catalog";
import { loadRubric, renderRubricDoc, testRule } from "./rubric";
import { allVersions, publishHeld, runReviews, runSync } from "./jobs";
import { makeReviewer } from "./reviewers";
import { runWorker, validateReviewQueue } from "./reviewqueue";
import { loadSigningKey, signerHandler } from "./signer";
import { runLoop } from "./workqueue";
import { publishDownload } from "./downloads";

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
} else if (cmd === "publish-download") {
  // om-sync publish-download <file> --version <v> [--registry registry] [--name om.exe] [--note text]
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const file = rest[0], version = flag("version");
  if (!file || file.startsWith("--") || !version) { console.error("usage: publish-download <file> --version <v> [--registry dir] [--name name] [--note text]"); process.exit(2); }
  try {
    const e = await publishDownload(flag("registry", "registry")!, file, { version, name: flag("name"), note: flag("note") });
    console.log(`published downloads/${e.name} ${e.version} (${(e.size / 1048576).toFixed(1)} MB)
sha256 ${e.sha256}`);
  } catch (e) { console.error((e as Error).message); process.exit(1); }
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
} else if (cmd === "sign-worker") {
  // om-sync sign-worker --queue /signq --registry /data [--key-file /run/secrets/signing-key] [--public-key /config/public-key.txt]
  // The separate signer container: the only process with the signing key. Answers approval requests from the admin.
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const queue = flag("queue"), registry = flag("registry");
  if (!queue || !registry) { console.error("usage: sign-worker --queue <dir> --registry <dir> [--key-file f] [--public-key f]"); process.exit(2); }
  let key;
  try { key = await loadSigningKey(flag("key-file", process.env.OM_SIGNING_KEY_FILE)); } catch (e) { console.error("sign-worker: " + (e as Error).message); process.exit(2); }
  // Refuse to run with a key that does not match the public key the admin and the clients verify with: every approval would show as invalid.
  const pubFile = flag("public-key");
  if (pubFile) {
    const pinned = (await readFile(pubFile, "utf8")).trim();
    if (pinned !== key.publicSpkiB64) { console.error("sign-worker: the signing key does not match the public key in " + pubFile + "; refusing to start"); process.exit(2); }
  }
  const stop = { now: false };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stop.now = true; });
  console.log(`sign-worker: queue ${queue}, registry ${registry} (read-only), public key ${key.publicSpkiB64.slice(0, 16)}...`);
  await runLoop(queue, signerHandler(registry, key.privatePem, (l) => console.log(l)), stop, (l) => console.log(l));
} else if (cmd === "review-worker") {
  // om-sync review-worker --queue /queue [--config registry.config.json]
  // The separate reviewer container: answers prompts the admin queues. It holds the model credentials and sees no registry files.
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const queue = flag("queue");
  if (!queue) { console.error("usage: review-worker --queue <dir> [--config registry.config.json]"); process.exit(2); }
  const cfg = JSON.parse(await readFile(flag("config", "registry.config.json")!, "utf8")) as Config;
  const bad = validateReviewQueue(cfg.review);
  if (bad.length) { bad.forEach((b) => console.error("review-worker: " + b)); process.exit(2); }
  const rc = cfg.review!;
  // Claude Code needs a writable home; in the container the root file system is read-only, so HOME points at a tmpfs.
  if (process.env.HOME) await mkdir(process.env.HOME, { recursive: true });
  const inner = makeReviewer(rc);
  const needsKey = (rc.provider ?? "claude-code") === "claude-code";
  const reviewer: typeof inner = async (prompt, ctx) => {
    if (needsKey && !process.env.ANTHROPIC_API_KEY) throw new Error("the reviewer container has no ANTHROPIC_API_KEY");
    return inner(prompt, ctx);
  };
  const stop = { now: false };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stop.now = true; });
  console.log(`review-worker: queue ${queue}, provider ${rc.provider ?? "claude-code"}, model ${rc.model ?? "(default)"}`);
  if (needsKey && !process.env.ANTHROPIC_API_KEY) console.warn("review-worker: ANTHROPIC_API_KEY is not set; every request will be answered with an error");
  await runWorker(queue, reviewer, stop, (l) => console.log(l));
} else {
  const cfgPath = cmd ?? "registry.config.json";
  const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Config;
  const r = await runSync(cfg);
  process.exit(r.errors.length ? 1 : 0);
}
