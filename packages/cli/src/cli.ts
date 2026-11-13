import { dirname } from "node:path";
import { run } from "./run";

// CommonJS bundle (also used for the single-executable build), so no top-level await.
const script = process.argv[1] && /\.c?js$/.test(process.argv[1]) ? process.argv[1] : process.execPath;
run(process.argv.slice(2), { log: (s) => console.log(s), err: (s) => console.error(s) }, { env: process.env, configDir: dirname(script) })
  .then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
