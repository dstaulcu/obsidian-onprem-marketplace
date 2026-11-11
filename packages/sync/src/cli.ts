import { readFile } from "node:fs/promises";
import { makeFetcher, syncRegistry, type Config } from "./sync";

const cfgPath = process.argv[2] ?? "registry.config.json";
const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Config;
const token = cfg.tokenEnv ? process.env[cfg.tokenEnv] : undefined;
const r = await syncRegistry(cfg, makeFetcher(token));
console.log(`added ${r.added.length}, skipped ${r.skipped.length}, errors ${r.errors.length}`);
r.added.forEach((a) => console.log("  + " + a));
r.errors.forEach((e) => console.error("  ! " + e));
process.exit(r.errors.length ? 1 : 0);
