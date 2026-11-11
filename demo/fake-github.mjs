// A tiny stand-in for the GitHub releases API so the demo runs offline and repeatably.
// Serves demo/fixtures/<owner>/<repo>/<version>/{main.js,manifest.json,styles.css}
// as releases, in the same shape sync reads from GitHub.
// Usage: node demo/fake-github.mjs [port]   (default 9090)
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const port = Number(process.argv[2] ?? 9090);
const semver = (v) => v.split(".").map(Number);
const newestFirst = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const rel = /^\/repos\/([\w.-]+)\/([\w.-]+)\/releases$/.exec(url.pathname);
  if (rel) {
    const dir = join(root, rel[1], rel[2]);
    if (!existsSync(dir)) { res.writeHead(404).end("{}"); return; }
    const releases = readdirSync(dir).filter((v) => statSync(join(dir, v)).isDirectory()).sort(newestFirst).map((v) => ({
      tag_name: v, draft: false, prerelease: false, published_at: "2026-11-01T12:00:00Z",
      assets: readdirSync(join(dir, v)).map((n) => ({ name: n, url: `http://127.0.0.1:${port}/assets/${rel[1]}/${rel[2]}/${v}/${n}` })),
    }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(releases));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const file = normalize(join(root, url.pathname.slice("/assets/".length)));
    if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(readFileSync(file));
    return;
  }
  res.writeHead(404).end();
}).listen(port, "127.0.0.1", () => console.log(`fake GitHub on http://127.0.0.1:${port} (serving ${root})`));
