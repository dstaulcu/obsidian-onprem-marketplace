// Single-page UI served as three static strings (no framework, no build step). Strict CSP (no inline script/style),
// and every registry-derived value is inserted with textContent: plugin ids, versions and findings are untrusted.
export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registry admin</title><link rel="stylesheet" href="/app.css"></head>
<body><header><h1>Registry admin</h1><span id="who"></span><button id="logout" hidden>Sign out</button></header>
<main>
<section id="login" hidden><h2>Sign in</h2><form id="loginform"><label>User <input name="name" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button><p id="loginerr" class="err"></p></form></section>
<section id="app" hidden>
<div class="bar"><button id="sync">Sync now</button><button id="review">Review all</button><span id="msg"></span></div>
<h2>Plugins</h2><div id="plugins"></div>
<h2>Clients</h2><p id="clientsnote" class="note"></p><div id="adoption"></div><div id="clients"></div>
<h2>Recent activity</h2><div id="activity"></div>
<h2>Forwarding</h2><p id="forwarder"></p>
<h2>Jobs</h2><div id="jobs"></div><pre id="out"></pre>
</section></main><script src="/app.js"></script></body></html>`;

export const APP_CSS = `body{font:14px system-ui,sans-serif;margin:0;color:#1b1b1b;background:#fafafa}
header{display:flex;gap:1rem;align-items:center;padding:.6rem 1rem;background:#222;color:#fff}h1{font-size:1.1rem;margin:0;flex:1}
main{padding:1rem;max-width:960px;margin:auto}button{padding:.35rem .8rem;cursor:pointer}.bar{display:flex;gap:.6rem;align-items:center}
table{border-collapse:collapse;width:100%;margin:.4rem 0 1rem;background:#fff}th,td{border:1px solid #ddd;padding:.3rem .5rem;text-align:left}
.ok{color:#0a6b2d}.bad{color:#a40000}.warn{color:#8a5a00}.err{color:#a40000}pre{background:#111;color:#ddd;padding:.6rem;overflow:auto;max-height:22rem}
.note{color:#555;font-size:12px}code{background:#eee;padding:0 .25rem}label{display:block;margin:.4rem 0}`;

export const APP_JS = `(() => {
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-OM-Admin": "1" }, body: JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
let polling = null;

async function showPlugins() {
  const { data } = await api("/api/plugins"); const box = $("plugins"); box.replaceChildren();
  for (const p of data.plugins) {
    box.append(el("h3", p.id));
    const t = el("table"); const h = el("tr"); for (const c of ["Version", "State", "Review", "Approval", ""]) h.append(el("th", c)); t.append(h);
    for (const v of p.versions) {
      const r = el("tr"); r.append(el("td", v.version), el("td", v.staged ? "held back" : "published"));
      r.append(el("td", v.review ? v.review.verdict + (v.review.signed ? (v.review.valid === false ? " (BAD SIGNATURE)" : v.review.valid ? " (signed)" : " (signed, unverified)") : " (unsigned)") : "none", v.review && v.review.verdict === "pass" && v.review.valid !== false ? "ok" : "warn"));
      const a = el("td"); if (v.approval && v.approval.ok) { a.textContent = "approved by " + v.approval.by + (v.approval.override ? " (override)" : ""); a.className = "ok"; }
      else if (v.approval) { a.textContent = "INVALID: " + v.approval.reason; a.className = "bad"; } else { a.textContent = "not approved"; a.className = "warn"; }
      r.append(a);
      const c = el("td"); if (!(v.approval && v.approval.ok)) { c.append(el("code", "approve " + p.id + "@" + v.version)); c.title = "Run on the admin host: node packages/sync/dist/cli.js approve " + p.id + "@" + v.version + " --key keys/signing-key.pem"; }
      r.append(c); t.append(r);
    }
    box.append(t);
  }
  if (!data.plugins.length) box.append(el("p", "No plugins mirrored yet. Run a sync."));
}

const table = (heads, rows, classer) => { const t = el("table"); const h = el("tr"); heads.forEach((x) => h.append(el("th", x))); t.append(h);
  for (const r of rows) { const tr = el("tr"); r.forEach((c, i) => tr.append(el("td", String(c ?? ""), classer ? classer(i, c) : undefined))); t.append(tr); } return t; };
const statusClass = (c) => (c === "latest" ? "ok" : c === "behind" ? "warn" : c === "unapproved" || c === "not in registry" ? "bad" : undefined);

async function showClients() {
  const { data } = await api("/api/clients"); const note = $("clientsnote"), box = $("clients"), ad = $("adoption"); box.replaceChildren(); ad.replaceChildren();
  if (!data.enabled) { note.textContent = "Client activity is off: set accessLog in the admin config (see docs/admin.md)."; return; }
  note.textContent = data.note + (data.error ? "  Problem reading the log: " + data.error : "");
  ad.append(el("h3", "Last fetched, by plugin and version"));
  ad.append(table(["Plugin", "Version", "Clients", "Status"], data.adoption.map((a) => [a.id, a.version, a.clients, a.status]), (i, c) => (i === 3 ? statusClass(c) : undefined)));
  box.append(el("h3", "Known clients"));
  box.append(table(["Last seen", "Client", "OS", "Zone", "Address", "Last fetched", "Checks"], data.clients.map((c) => [c.last, c.kind + (c.version ? " " + c.version : ""), c.os || "", c.zone || "", c.addr,
    c.plugins.map((p) => p.id + "@" + p.version + (p.status === "latest" ? "" : " (" + p.status + ")")).join(", "), c.checks])));
}
async function showActivity() {
  const { data } = await api("/api/activity"); const box = $("activity"); box.replaceChildren();
  if (!data.enabled) return;
  box.append(table(["Time", "Event", "Plugin", "Version", "File", "Status", "Client", "Zone"], data.events.map((e) => [e.time, e.install ? "install/update" : e.type, e.plugin || "", e.version || "", e.file || "", e.status, e.client.kind + (e.client.version ? " " + e.client.version : ""), e.zone || ""])));
}
async function showForwarder() {
  const { data } = await api("/api/forwarder"); const p = $("forwarder");
  p.textContent = !data.enabled ? "Not configured." : "Sent " + data.sent + " events to " + data.url + (data.lastOk ? "; last OK " + data.lastOk : "") + (data.lastError ? ". PROBLEM: " + data.lastError + " (retry " + (data.retryAt || "soon") + ")" : ".");
  p.className = data.lastError ? "bad" : "";
}

async function showJobs(selectId) {
  const { data } = await api("/api/jobs"); const box = $("jobs"); box.replaceChildren();
  let running = false;
  for (const j of data.jobs) { running = running || j.status === "running";
    const b = el("button", j.kind + " by " + j.who + " " + j.started + " [" + j.status + "]"); b.onclick = () => showJob(j.id); box.append(b, el("br")); }
  const pick = selectId || (data.jobs[0] && data.jobs[0].id); if (pick) await showJob(pick);
  if (running && !polling) polling = setInterval(() => showJobs(), 1500);
  if (!running && polling) { clearInterval(polling); polling = null; await showPlugins(); }
}
async function showJob(id) { const { data } = await api("/api/jobs/" + id); if (data) $("out").textContent = data.output.join("\n") + (data.error ? "\nFAILED: " + data.error : ""); }

async function start(kind) {
  $("msg").textContent = "";
  const { status, data } = await api("/api/" + kind, {});
  if (status === 409) $("msg").textContent = "Another job is running."; else if (status !== 202) $("msg").textContent = (data && data.error) || "Failed (" + status + ")";
  await showJobs(data && data.job && data.job.id);
}

async function init() {
  const me = await api("/api/me");
  if (me.status !== 200) { $("login").hidden = !(me.data && me.data.passwordLogin); $("app").hidden = true; if ($("login").hidden) $("who").textContent = "Not authorised (client certificate required)"; return; }
  $("login").hidden = true; $("app").hidden = false; $("who").textContent = me.data.name + " (" + me.data.method + ")"; $("logout").hidden = me.data.method !== "password";
  await showPlugins(); await showClients(); await showActivity(); await showForwarder(); await showJobs();
}
$("loginform").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
  const r = await api("/api/login", { name: f.get("name"), password: f.get("password") });
  if (r.status === 200) { e.target.reset(); init(); } else $("loginerr").textContent = r.status === 429 ? "Too many attempts; try again later." : "Sign-in failed."; };
$("logout").onclick = async () => { await api("/api/logout", {}); location.reload(); };
$("sync").onclick = () => start("sync"); $("review").onclick = () => start("review");
init();
})();`;
