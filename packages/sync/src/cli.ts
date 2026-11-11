import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFetcher, syncRegistry, type Config } from "./sync";
import { approveVersion, generateKeys } from "./signing";

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
  // om-sync approve <id@version> --key <pem> [--registry registry] [--by name]
  const flag = (n: string, d?: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  const [id, version] = (rest[0] ?? "").split("@");
  const keyPath = flag("key");
  if (!id || !version || !keyPath) { console.error("usage: approve <id@version> --key <pem> [--registry dir] [--by name]"); process.exit(2); }
  const by = flag("by", process.env.USERNAME ?? process.env.USER ?? "admin")!;
  const a = await approveVersion(flag("registry", "registry")!, id, version, await readFile(keyPath, "utf8"), by);
  console.log(`approved ${a.id}@${a.version} by ${a.approvedBy}`);
} else {
  const cfgPath = cmd ?? "registry.config.json";
  const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Config;
  const token = cfg.tokenEnv ? process.env[cfg.tokenEnv] : undefined;
  const r = await syncRegistry(cfg, makeFetcher(token));
  console.log(`added ${r.added.length}, skipped ${r.skipped.length}, errors ${r.errors.length}`);
  r.added.forEach((a) => console.log("  + " + a));
  r.errors.forEach((e) => console.error("  ! " + e));
  process.exit(r.errors.length ? 1 : 0);
}
