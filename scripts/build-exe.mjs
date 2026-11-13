// Builds dist/om.exe (Node single executable application) from packages/cli/dist/om.cjs.
// Run `npm run build` first. Needs the Node version you want embedded; the exe is that node binary plus the script.
// Unsigned executables are often blocked on locked-down machines: code-sign the result if your policy requires it.
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "packages/cli/dist/om.cjs");
if (!existsSync(script)) { console.error("packages/cli/dist/om.cjs missing; run npm run build first"); process.exit(1); }
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
const blob = join(out, "om.blob");
const cfg = join(out, "sea-config.json");
writeFileSync(cfg, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", cfg], { stdio: "inherit" });

const exe = join(out, process.platform === "win32" ? "om.exe" : "om");
copyFileSync(process.execPath, exe);
execFileSync("npx", ["postject", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit", shell: true });
console.log(`Built ${exe}`);
