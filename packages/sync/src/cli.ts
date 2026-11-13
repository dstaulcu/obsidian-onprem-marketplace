import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config } from "./sync";
import { approveVersion, generateKeys } from "./signing";
import { type PublishPolicy } from "./catalog";
import { loadRubric, renderRubricDoc, testRule } from "./rubric";
import { allVersions, publishHeld, runReviews, runSync } from "./jobs";

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
  const r = await runSync(cfg);
  process.exit(r.errors.length ? 1 : 0);
}
