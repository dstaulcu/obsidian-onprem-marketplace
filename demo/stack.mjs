// Starts, stops and resets the demo's isolated container stack (see demo/docker-compose.yml). Run from anywhere:
//   node demo/stack.mjs up      generate demo/stack/ if missing (demo-only keys, certificate, login, config), start the fake GitHub and
//                               the fake model service on the host, then docker compose up (project om-demo)
//   node demo/stack.mjs down    stop the containers (their volumes are removed) and the two host servers
//   node demo/stack.mjs reset   down, delete demo/stack/ and demo/vault, then up: a clean registry with nothing synced
// Ports: registry http://localhost:8180, admin https://localhost:8543 (login in demo/stack/login.txt), fake GitHub 9190, fake model 9191.
// Never touches registry-data/, config/ or the default compose project. The signing key made here exists only for the demo.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const demo = join(root, "demo");
const stack = join(demo, "stack");
const compose = join(demo, "docker-compose.yml");
const PORTS = { registry: 8180, admin: 8543, github: 9190, model: 9191 };
const PASSWORD = "demo-password-123"; // loopback-only demo login

const log = (m) => console.log(m);
const sh = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`); };
const write = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };

/** Makes the self-signed demo certificate with the first openssl that works (PATH ones differ: conda's, for example, may not). */
function makeCert(dir) {
  const errs = [];
  for (const c of ["openssl", "C:/Program Files/Git/mingw64/bin/openssl.exe", "C:/Program Files/Git/usr/bin/openssl.exe"]) {
    const r = spawnSync(c, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(dir, "server.key"), "-out", join(dir, "server.crt")], { encoding: "utf8" });
    if (r.status === 0 && existsSync(join(dir, "server.crt"))) return;
    errs.push(`${c}: ${r.error ? r.error.message : (r.stderr || "exit " + r.status).trim().slice(0, 300)}`);
  }
  throw new Error("could not make the demo certificate; openssl said:\n  " + errs.join("\n  "));
}

function generate() {
  for (const f of ["packages/sync/dist/cli.js", "packages/admin/dist/admin.cjs"]) if (!existsSync(join(root, f))) throw new Error(`${f} is missing: run npm run build first`);
  log("generating demo/stack (demo-only key, certificate, login, config)");
  const cfg = join(stack, "config");
  mkdirSync(join(cfg, "nginx-extra"), { recursive: true });
  mkdirSync(join(cfg, "tls"), { recursive: true });
  mkdirSync(join(stack, "registry-data"), { recursive: true });
  mkdirSync(join(stack, "secrets"), { recursive: true });
  // signing key: the private half goes only to the signer's secret, the public half to the config folder
  sh("node", [join(root, "packages/sync/dist/cli.js"), "keygen", join(stack, "keys")]);
  copyFileSync(join(stack, "keys", "signing-key.pem"), join(stack, "secrets", "signing-key.pem"));
  copyFileSync(join(stack, "keys", "public-key.txt"), join(cfg, "public-key.txt"));
  makeCert(join(cfg, "tls"));
  sh("node", [join(root, "packages/admin/dist/admin.cjs"), "passwd", "demo", "--users", join(cfg, "admin-users.json")], { env: { ...process.env, OM_ADMIN_PASSWORD: PASSWORD } });
  write(join(stack, "login.txt"), `user: demo\npassword: ${PASSWORD}\n`);
  // No repositories yet: act 3 of the demo adds them from the dashboard.
  write(join(cfg, "registry.config.json"), JSON.stringify({
    githubApiBase: `http://host.docker.internal:${PORTS.github}`,
    publishPolicy: "approved", // a version stays held back from clients until an admin approval matches it (the default, "all", lists everything mirrored)
    outDir: "/data",
    review: { enabled: true, provider: "openai-compatible", model: "demo-recorded", openai: { baseUrl: `http://host.docker.internal:${PORTS.model}/v1` } },
    repos: [],
  }, null, 2) + "\n");
  write(join(cfg, "admin.config.json"), JSON.stringify({
    listen: { host: "0.0.0.0", port: 8443 },
    tls: { cert: "/config/tls/server.crt", key: "/config/tls/server.key" },
    registryConfig: "/config/registry.config.json",
    publicKeyFile: "/config/public-key.txt",
    registryUrl: `http://localhost:${PORTS.registry}`,
    password: { usersFile: "/config/admin-users.json" },
    reviewQueue: "/queue", signerQueue: "/signq",
    auditLog: "/audit/admin-audit.jsonl", accessLog: "/logs/access.log",
    stats: { publish: true, windowDays: 30, minCount: 1 },
  }, null, 2) + "\n");
}

const pidFile = (n) => join(stack, `${n}.pid`);
function startHost(name, script, port) {
  mkdirSync(stack, { recursive: true });
  const out = openSync(join(stack, `${name}.log`), "w");
  const p = spawn(process.execPath, [join(demo, script), String(port), "0.0.0.0"], { detached: true, stdio: ["ignore", out, out], cwd: root });
  p.unref();
  writeFileSync(pidFile(name), String(p.pid));
  log(`${name}: started on :${port} (pid ${p.pid})`);
}
function stopHost(name) {
  try { process.kill(Number(readFileSync(pidFile(name), "utf8"))); log(`${name}: stopped`); } catch { /* not running */ }
  try { rmSync(pidFile(name)); } catch { /* none */ }
}

async function waitFor(url, what, tries = 90) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the demo certificate is self-signed; only loopback is ever contacted here
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) { log(`${what}: up`); return; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

const down = () => {
  spawnSync("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { stdio: "inherit", cwd: root });
  stopHost("fake-github"); stopHost("fake-model");
};
const reset = () => { down(); for (const d of [stack, join(demo, "vault"), join(demo, "demo-out")]) rmSync(d, { recursive: true, force: true }); };

async function up() {
  if (!existsSync(join(stack, "config", "admin.config.json"))) generate();
  stopHost("fake-github"); stopHost("fake-model");
  startHost("fake-github", "fake-github.mjs", PORTS.github);
  startHost("fake-model", "fake-model.mjs", PORTS.model);
  sh("docker", ["compose", "-f", compose, "up", "-d", "--build"]);
  await waitFor(`http://localhost:${PORTS.registry}/`, "registry");
  await waitFor(`https://localhost:${PORTS.admin}/`, "admin");
  log(`\nready. registry http://localhost:${PORTS.registry}   admin https://localhost:${PORTS.admin}   login in demo/stack/login.txt\nnext: node demo/run-demo.mjs`);
}

const cmd = process.argv[2];
// Fail early and plainly when the Docker engine is not running (Docker Desktop stopped or still starting), before anything is generated or started.
if ((cmd === "up" || cmd === "reset") && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.error("The Docker engine is not running. Start Docker Desktop, wait until it says it is running, then run this again.");
  process.exit(1);
}
try {
  if (cmd === "up") await up();
  else if (cmd === "down") down();
  else if (cmd === "reset") { reset(); await up(); }
  else { console.error("usage: node demo/stack.mjs <up|down|reset>"); process.exit(2); }
} catch (e) { console.error(e.message); process.exit(1); }
