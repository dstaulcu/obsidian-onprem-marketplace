// Usage: node scripts/bootstrap-vault.mjs <vaultPath> <registryUrl> [publicKeyFile] [off|warn|require-signed]
// With a public key file the key is pinned in the vault and the trust mode defaults to require-signed.
// Installs the On-Prem Marketplace plugin into a vault and enables it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [vault, registryUrl, keyFile, modeArg] = process.argv.slice(2);
if (!vault || !registryUrl) {
  console.error("usage: bootstrap-vault.mjs <vaultPath> <registryUrl>");
  process.exit(2);
}
const src = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/plugin");
const cfg = join(vault, ".obsidian");
const dest = join(cfg, "plugins", "onprem-marketplace");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json"]) copyFileSync(join(src, f), join(dest, f));
const publicKey = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const trustMode = modeArg ?? (publicKey ? "require-signed" : "off");
if (!["off", "warn", "require-signed"].includes(trustMode)) { console.error("trust mode must be off, warn or require-signed"); process.exit(2); }
writeFileSync(join(dest, "data.json"), JSON.stringify({ registryUrl, checkIntervalMinutes: 240, trustMode, publicKey }, null, 2));

const listPath = join(cfg, "community-plugins.json");
const list = existsSync(listPath) ? JSON.parse(readFileSync(listPath, "utf8")) : [];
if (!list.includes("onprem-marketplace")) list.push("onprem-marketplace");
writeFileSync(listPath, JSON.stringify(list, null, 2));
console.log(`Installed into ${dest}. In Obsidian: Settings > Community plugins > turn off Restricted mode, then reload.`);
