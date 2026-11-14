// Single-page UI served as three static strings (no framework, no build step, nothing loaded from elsewhere).
// Strict CSP (no inline script/style): all styling is classes in APP_CSS, and every registry-derived value is
// inserted with textContent / text nodes, because plugin ids, versions and findings are untrusted.
// NOTE: these are template literals. Do not put backticks, dollar-brace or single backslashes in them
// (a backslash-n must be written as two backslashes), and keep regexes free of backslashes (use [.] not a backslash-dot).
export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Registry admin</title><link rel="stylesheet" href="/app.css"></head>
<body>
<header class="top">
  <div class="brand"><span class="logo" aria-hidden="true"></span><h1>Registry admin</h1></div>
  <span class="spacer"></span>
  <span id="who" class="who" hidden></span>
  <button id="theme" class="btn ghost" type="button" title="Switch between automatic, light and dark">Theme: auto</button>
  <button id="logout" class="btn ghost" type="button" hidden>Sign out</button>
</header>
<main>
  <div id="banner" class="banner" role="alert" hidden></div>

  <section id="login" class="logincard" hidden>
    <h2>Sign in</h2>
    <p class="muted">Use your admin password. If you have a client certificate installed you are signed in automatically.</p>
    <form id="loginform">
      <label for="f-name">User</label><input id="f-name" name="name" autocomplete="username" required>
      <label for="f-pass">Password</label><input id="f-pass" name="password" type="password" autocomplete="current-password" required>
      <button class="btn primary wide" type="submit">Sign in</button>
      <p id="loginerr" class="err" role="alert"></p>
    </form>
  </section>

  <section id="app" hidden>
    <div class="actions">
      <button id="sync" class="btn primary" type="button">Sync now</button>
      <button id="review" class="btn" type="button">Review all</button>
      <span id="running" class="running" hidden><span class="spinner" aria-hidden="true"></span><span id="runningtext"></span></span>
      <span class="spacer"></span>
      <span id="updated" class="muted small"></span>
      <button id="refresh" class="btn ghost" type="button">Refresh</button>
    </div>

    <div id="cards" class="cards"></div>

    <div id="tabs" class="tabs" role="tablist" aria-label="Sections"></div>

    <div id="panel-plugins" class="panel" role="tabpanel">
      <div class="toolbar"><input id="q-plugins" class="search" type="search" placeholder="Filter plugins and versions" aria-label="Filter plugins"></div>
      <div id="plugins"></div>
    </div>
    <div id="panel-clients" class="panel" role="tabpanel" hidden>
      <p id="clientsnote" class="muted small"></p>
      <div id="adoption"></div>
      <div class="toolbar"><input id="q-clients" class="search" type="search" placeholder="Filter clients" aria-label="Filter clients"></div>
      <div id="clients"></div>
    </div>
    <div id="panel-activity" class="panel" role="tabpanel" hidden><div id="activity"></div></div>
    <div id="panel-forwarding" class="panel" role="tabpanel" hidden><div id="forwarder"></div></div>
    <div id="panel-jobs" class="panel" role="tabpanel" hidden>
      <div id="jobs" class="joblist"></div>
      <pre id="out" class="out" tabindex="0" aria-label="Job output"></pre>
    </div>
  </section>
</main>
<aside id="drawer" class="drawer" hidden aria-label="Notes">
  <header><h3 id="drawertitle">Notes</h3><button id="drawerclose" class="btn ghost" type="button">Close</button></header>
  <div id="notelist" class="notelist"></div>
  <form id="noteform">
    <label for="n-text">Add a note (all admins can read it)</label>
    <textarea id="n-text" maxlength="2000" rows="4" required></textarea>
    <label for="n-ref">Reference (optional, for example a ticket number)</label>
    <input id="n-ref" maxlength="100">
    <button class="btn primary" type="submit">Add note</button> <span id="noteerr" class="err" role="alert"></span>
    <p class="muted small">Plain text. Notes are for people: they never change what clients can install.</p>
  </form>
</aside>
<script src="/app.js"></script></body></html>`;

export const APP_CSS = `:root{
  --bg:#f4f5f8;--surface:#fff;--surface2:#f8f9fb;--text:#1b2130;--muted:#5a6376;--border:#e0e3ea;--shadow:0 1px 2px rgba(20,25,40,.06),0 2px 8px rgba(20,25,40,.04);
  --accent:#3452d1;--accent-text:#fff;--accent-soft:#e8ecfd;
  --ok:#17703f;--ok-bg:#e1f4e8;--warn:#8a5a00;--warn-bg:#fdf0d3;--bad:#b3261e;--bad-bg:#fde6e4;--info:#33507a;--info-bg:#e6edf7;
  --code-bg:#10131a;--code-text:#d7dce6;color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0e1117;--surface:#161b24;--surface2:#1b212c;--text:#e5e8ee;--muted:#98a2b3;--border:#2a313e;--shadow:0 1px 2px rgba(0,0,0,.4);
  --accent:#8097ff;--accent-text:#0e1117;--accent-soft:#222a45;
  --ok:#62d492;--ok-bg:#12301f;--warn:#f0b75a;--warn-bg:#392c0f;--bad:#ff8f86;--bad-bg:#3b1715;--info:#9db9e6;--info-bg:#1c2a3f;
  --code-bg:#0a0c11;--code-text:#d7dce6;color-scheme:dark;}}
:root[data-theme="dark"]{
  --bg:#0e1117;--surface:#161b24;--surface2:#1b212c;--text:#e5e8ee;--muted:#98a2b3;--border:#2a313e;--shadow:0 1px 2px rgba(0,0,0,.4);
  --accent:#8097ff;--accent-text:#0e1117;--accent-soft:#222a45;
  --ok:#62d492;--ok-bg:#12301f;--warn:#f0b75a;--warn-bg:#392c0f;--bad:#ff8f86;--bad-bg:#3b1715;--info:#9db9e6;--info-bg:#1c2a3f;
  --code-bg:#0a0c11;--code-text:#d7dce6;color-scheme:dark;}

[hidden]{display:none!important}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1,h2,h3{margin:0;font-weight:650}h2{font-size:1.15rem}h3{font-size:1rem}
.muted{color:var(--muted)}.small{font-size:12px}.err{color:var(--bad);min-height:1.2em;margin:.6rem 0 0}.spacer{flex:1}
code,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:12.5px}
code{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:0 .3rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.top{display:flex;align-items:center;gap:.7rem;padding:.7rem 1.25rem;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:.6rem}.brand h1{font-size:1.05rem}
.logo{width:22px;height:22px;border-radius:6px;background:var(--accent);position:relative;display:inline-block}
.logo::after{content:"";position:absolute;left:5px;top:5px;width:12px;height:12px;border:2px solid var(--accent-text);border-radius:3px}
.who{font-size:12.5px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);padding:.2rem .6rem;border-radius:999px}

main{max-width:1100px;margin:0 auto;padding:1.25rem}
.btn{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.45rem .9rem;cursor:pointer;box-shadow:var(--shadow)}
.btn:hover{border-color:var(--accent)}.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);font-weight:600}
.btn.ghost{background:transparent;box-shadow:none}.btn.tiny{padding:.15rem .5rem;font-size:12px;box-shadow:none}.rowacts{display:inline-flex;gap:.4rem;flex-wrap:wrap}.revcell{display:inline-flex;gap:.55rem;align-items:center}.reportlink{font-size:12px;color:var(--accent)}.btn.wide{width:100%;margin-top:1rem}

.banner{padding:.7rem 1rem;border-radius:8px;margin-bottom:1rem;border:1px solid var(--border);background:var(--info-bg);color:var(--info)}
.banner.bad{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}.banner.ok{background:var(--ok-bg);color:var(--ok);border-color:var(--ok)}

.logincard{max-width:380px;margin:8vh auto 0;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.5rem;box-shadow:var(--shadow)}
.logincard h2{margin-bottom:.4rem}.logincard label{display:block;margin:.9rem 0 .25rem;font-weight:600;font-size:13px}
input{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem .65rem;width:100%}
.search{max-width:320px}

.actions{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem}
.running{display:inline-flex;align-items:center;gap:.5rem;padding:.3rem .7rem;border-radius:999px;background:var(--info-bg);color:var(--info);font-size:13px}
.spinner{width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none}}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem;margin-bottom:1.25rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.85rem 1rem;box-shadow:var(--shadow)}
.card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.card .value{font-size:1.7rem;font-weight:700;line-height:1.2;margin-top:.15rem}.card .sub{color:var(--muted);font-size:12px;margin-top:.1rem}
.card.warn .value{color:var(--warn)}.card.ok .value{color:var(--ok)}.card.bad .value{color:var(--bad)}

.tabs{display:flex;gap:.25rem;border-bottom:1px solid var(--border);margin-bottom:1rem;overflow-x:auto}
.tab{font:inherit;color:var(--muted);background:none;border:0;border-bottom:2px solid transparent;padding:.6rem .9rem;cursor:pointer;white-space:nowrap}
.tab:hover{color:var(--text)}.tab[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.tab .count{margin-left:.35rem;font-size:11px;background:var(--warn-bg);color:var(--warn);border-radius:999px;padding:0 .4rem}
.toolbar{margin-bottom:.75rem}

.group{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:1rem;box-shadow:var(--shadow);overflow:hidden}
.group>header{display:flex;align-items:center;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid var(--border);background:var(--surface2)}
.group>header h3{flex:1}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th{position:sticky;top:0;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;padding:.55rem 1rem;background:var(--surface2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.55rem 1rem;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}tbody tr:hover td{background:var(--surface2)}
.standalone{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:1rem}
h2.section{margin:1.25rem 0 .6rem;font-size:1rem}

.badge{display:inline-block;padding:.1rem .55rem;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.b-ok{background:var(--ok-bg);color:var(--ok)}.b-warn{background:var(--warn-bg);color:var(--warn)}.b-bad{background:var(--bad-bg);color:var(--bad)}
.b-info{background:var(--info-bg);color:var(--info)}.b-muted{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.chip{display:inline-block;margin:0 .3rem .2rem 0;padding:.05rem .45rem;border-radius:6px;background:var(--surface2);border:1px solid var(--border);font-size:12px}
.chip.c-warn{border-color:var(--warn)}.chip.c-bad{border-color:var(--bad)}

.empty{padding:2rem 1rem;text-align:center;color:var(--muted)}.empty strong{display:block;color:var(--text);margin-bottom:.2rem}

.kv{display:grid;grid-template-columns:max-content 1fr;gap:.45rem 1.25rem;padding:1rem}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.45rem;background:var(--muted)}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}

.joblist{display:flex;flex-direction:column;gap:.35rem;margin-bottom:.9rem}
.job{display:flex;align-items:center;gap:.7rem;width:100%;text-align:left;font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem .8rem;cursor:pointer}
.job[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft)}.job .when{margin-left:auto;color:var(--muted);font-size:12px}
.out{background:var(--code-bg);color:var(--code-text);padding:.9rem 1rem;border-radius:10px;overflow:auto;max-height:24rem;margin:0;font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;white-space:pre-wrap}
.out:empty::before{content:"Select a job to see its output.";color:#7d8798}

.drawer{position:fixed;top:0;right:0;bottom:0;width:min(400px,100%);background:var(--surface);border-left:1px solid var(--border);box-shadow:-4px 0 18px rgba(0,0,0,.18);z-index:20;overflow:auto;padding:1rem}
.drawer>header{display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem}.drawer>header h3{flex:1;overflow-wrap:anywhere}
.drawer label{display:block;margin:.8rem 0 .25rem;font-weight:600;font-size:13px}
textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem .65rem;width:100%;resize:vertical}
.notelist{display:flex;flex-direction:column;gap:.6rem}
.note{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:.55rem .75rem}
.notemeta{color:var(--muted);font-size:12px;margin-bottom:.2rem}.notetext{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.btn.danger{border-color:var(--bad);color:var(--bad)}.reasoninput{width:15rem;padding:.2rem .5rem;font-size:12px}.issuelink{font-size:12px;color:var(--accent)}
@media (max-width:640px){main{padding:.75rem}.top{padding:.6rem .75rem}td,th{padding:.5rem .6rem}}`;

export const APP_JS = `(() => {
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-OM-Admin": "1" }, body: JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

// h(tag, class, ...children): strings become text nodes, never HTML.
const h = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls;
  for (const k of kids) { if (k === null || k === undefined || k === false) continue; e.append(k instanceof Node ? k : document.createTextNode(String(k))); } return e; };
const badge = (text, kind, title) => { const e = h("span", "badge b-" + kind, text); if (title) e.title = title; return e; };
const rel = (iso) => { const ms = Date.parse(iso); if (isNaN(ms)) return String(iso || ""); const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; };
const when = (iso) => { const e = h("span", null, rel(iso)); e.title = String(iso || ""); return e; };
const empty = (title, hint) => h("div", "empty", h("strong", null, title), hint || "");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/, SAFE_VER = /^[0-9A-Za-z._+-]+$/;

// A table; each row is an array of strings or nodes. Rows remember their text so the filter box can hide them.
function tbl(heads, rows) {
  const body = h("tbody");
  for (const r of rows) { const tr = h("tr"); tr.dataset.q = r.map((c) => (c instanceof Node ? c.textContent : String(c ?? ""))).join(" ").toLowerCase();
    r.forEach((c) => tr.append(h("td", null, c instanceof Node ? c : String(c ?? "")))); body.append(tr); }
  return h("div", "tablewrap", h("table", null, h("thead", null, h("tr", null, ...heads.map((x) => h("th", null, x)))), body));
}
function applyFilter(input, root, selector) {
  const q = input.value.trim().toLowerCase();
  root.querySelectorAll(selector).forEach((n) => { n.hidden = q !== "" && !(n.dataset.q || "").includes(q); });
}

// ---- state shared between panels and the summary cards
const S = { plugins: [], clients: null, activity: null, jobs: [], selectedJob: null, registryUrl: "", githubWebBase: "", canApprove: false, notesOn: false, notes: [], drawer: null };
let polling = null, activeTab = "plugins", jobRunning = false;

function say(text, kind) { const b = $("banner"); if (!text) { b.hidden = true; return; } b.textContent = text; b.className = "banner" + (kind ? " " + kind : ""); b.hidden = false; }

// ---- summary cards
function card(label, value, sub, kind) { return h("div", "card" + (kind ? " " + kind : ""), h("div", "label", label), h("div", "value", String(value)), h("div", "sub", sub || "")); }
function renderCards() {
  const vs = S.plugins.flatMap((p) => p.versions);
  const approved = vs.filter((v) => v.approval && v.approval.ok).length, invalid = vs.filter((v) => v.approval && !v.approval.ok).length;
  const waiting = vs.length - approved - invalid, held = vs.filter((v) => v.staged).length;
  const box = $("cards"); box.replaceChildren(
    card("Plugins", S.plugins.length, vs.length + " versions mirrored"),
    card("Approved", approved + " / " + vs.length, "signed and verified", vs.length && approved === vs.length ? "ok" : ""),
    card("Awaiting approval", waiting, held ? held + " held back from clients" : "nothing held back", waiting ? "warn" : "ok"),
    ...(invalid ? [card("Invalid approvals", invalid, "signature does not verify", "bad")] : []));
  if (S.clients && S.clients.enabled) {
    const day = S.clients.clients.filter((c) => Date.now() - Date.parse(c.last) < 86400000).length;
    box.append(card("Clients, 24 h", day, S.clients.clients.length + " known"));
    if (S.activity && S.activity.enabled) box.append(card("Installs, recent", S.activity.events.filter((e) => e.install).length, "downloads of main.js in the latest events"));
  }
  const last = S.jobs[0]; if (last) box.append(card("Last job", last.kind, last.status + ", " + rel(last.started), last.status === "failed" ? "bad" : ""));
  const waitTab = document.querySelector('[data-tab="plugins"] .count'); if (waitTab) { waitTab.textContent = String(waiting); waitTab.hidden = !waiting; }
}

// ---- plugins
function approvalBadge(a) {
  if (a && a.ok) return badge("Approved", "ok", "by " + a.by + (a.override ? " (with override)" : ""));
  if (a) return badge("Invalid", "bad", a.reason);
  return badge("Not approved", "warn", "Needs a signed approval before clients in require-signed mode will install it");
}
function reviewBadge(r) {
  if (!r) return badge("No review", "muted");
  const sig = r.signed ? (r.valid === false ? "BAD SIGNATURE" : r.valid ? "signed" : "signed, unverified") : "unsigned";
  const kind = r.valid === false ? "bad" : r.verdict === "pass" ? "ok" : r.verdict === "fail" ? "bad" : "warn";
  return badge(String(r.verdict), kind, "Review " + sig);
}
// The full findings live in review.html in the registry (the same report clients can open). It is built from a validated
// id and version plus the configured registry address, never from a value found in registry data, and opens in a new tab on the
// registry origin so nothing in it runs with the admin page's session.
function reportLink(id, version) {
  let base = S.registryUrl; while (base.endsWith("/")) base = base.slice(0, -1);
  if (!(base.startsWith("http://") || base.startsWith("https://")) || !SAFE_ID.test(id) || !SAFE_VER.test(version)) return null;
  const a = h("a", "reportlink", "Report"); a.href = base + "/plugins/" + id + "/" + version + "/review.html"; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = "Open the full review report (findings and what was checked)";
  return a;
}
// A button that needs a second click within a few seconds, so a stray click cannot withdraw a version (no browser dialogs).
function confirmButton(label, ask, fn, danger) {
  const b = h("button", "btn tiny rowbtn" + (danger ? " danger" : ""), label); b.type = "button"; b.disabled = jobRunning; let timer = null;
  b.onclick = () => {
    if (timer) { clearTimeout(timer); timer = null; b.textContent = label; fn(); return; }
    b.textContent = ask + " Click again"; timer = setTimeout(() => { timer = null; b.textContent = label; }, 4000);
  };
  b.title = label === "Release" ? "Publish this held-back version to clients (the publish policy still applies)" : "Remove the approval and hide this version from clients. Copies already installed stay installed.";
  return b;
}
// Approve: the signing key is not in this page or in the admin service. The request goes to the signer container, which re-checks the
// files and the review and signs; the admin verifies the answer before it is used. A review that is not a pass needs a written reason,
// which is recorded inside the signed approval and in the audit log.
function approveControl(p, v) {
  const verdict = v.review ? v.review.verdict : null;
  if (verdict === "pass") return confirmButton("Approve", "Sign this approval?", () => runJob("/api/approve", { id: p.id, version: v.version }));
  const wrap = h("span", "rowacts"); const b = h("button", "btn tiny rowbtn", "Approve..."); b.type = "button"; b.disabled = jobRunning;
  b.title = verdict ? "The review is '" + verdict + "', so a written reason is required" : "There is no review yet, so a written reason is required";
  b.onclick = () => {
    const inp = h("input", "reasoninput"); inp.placeholder = "Reason (signed into the approval)"; inp.maxLength = 300; inp.setAttribute("aria-label", "Reason for approving without a passing review");
    const go = h("button", "btn tiny primary", "Approve anyway"); go.type = "button";
    go.onclick = () => { const why = inp.value.trim(); if (!why) { inp.focus(); return; } runJob("/api/approve", { id: p.id, version: v.version, override: why }); };
    wrap.replaceChildren(inp, go); inp.focus();
  };
  wrap.append(b); return wrap;
}
const manage = (action, id, version) => runJob("/api/manage", { action, id, version });
async function runJob(path, body) {
  say("");
  const r = await api(path, body);
  if (r.status !== 202) { say((r.data && r.data.error) || "Failed (" + r.status + ")", "bad"); return; }
  S.selectedJob = r.data.job.id; await showJobs(r.data.job.id);
  for (let i = 0; i < 60; i++) {
    const j = await api("/api/jobs/" + r.data.job.id);
    if (j.data && j.data.status !== "running") { say(j.data.status === "done" ? (j.data.output[0] || "Done.") : (j.data.error || "Failed."), j.data.status === "done" ? "ok" : "bad"); break; }
    await new Promise((x) => setTimeout(x, 400));
  }
  await showPlugins(); await showJobs(); renderCards();
}

// "Report an issue": opens the repository's new-issue page with a short prefilled text. The person reviews and posts it under
// their own GitHub identity; nothing is sent from here and no token is involved. The text holds only the verdict and a link to
// the report, never model output (which is derived from untrusted code). The repository comes from index.json but is shape-checked
// by the server, and the address is built here from the configured GitHub web address.
const REPO_OK = /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/;
function issueLink(p, v) {
  const verdict = v.review && ["findings", "fail"].includes(v.review.verdict) ? v.review.verdict : null;
  const base = S.githubWebBase; if (!verdict || !p.repo || !REPO_OK.test(p.repo) || !(base.startsWith("http://") || base.startsWith("https://")) || !SAFE_ID.test(p.id) || !SAFE_VER.test(v.version)) return null;
  const rep = S.registryUrl && (S.registryUrl.startsWith("http://") || S.registryUrl.startsWith("https://")) ? S.registryUrl.replace(/[/]+$/, "") + "/plugins/" + p.id + "/" + v.version + "/review.html" : "";
  const title = "Security review of " + p.id + " " + v.version + ": " + verdict;
  const NL = String.fromCharCode(10);
  const body = "An automated security review of " + p.id + "@" + v.version + " came back with: " + verdict + "." + NL + NL + (rep ? "Full report: " + rep + NL + NL : "") +
    "Please look at the findings and let us know if they are expected or will be addressed." + NL + NL + "(Opened from the registry admin; edit this text before posting.)";
  const a = h("a", "issuelink", "Report issue"); a.href = base.replace(/[/]+$/, "") + "/" + p.repo + "/issues/new?title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body);
  a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = "Open a prefilled issue on " + p.repo + " (you review and post it yourself)";
  return a;
}

// ---- notes drawer
const notesFor = (id, version) => S.notes.filter((n) => n.plugin === id && n.version === version);
function noteButton(id, version) {
  const n = notesFor(id, version).length; const b = h("button", "btn tiny", n ? "Notes (" + n + ")" : "Notes"); b.type = "button"; b.title = "Triage notes for " + id + "@" + version;
  b.onclick = () => openDrawer(id, version); return b;
}
function renderDrawer() {
  if (!S.drawer) return; const { id, version } = S.drawer; $("drawertitle").textContent = "Notes: " + id + "@" + version;
  const box = $("notelist"); box.replaceChildren(); const list = notesFor(id, version);
  if (!list.length) box.append(h("p", "muted", "No notes yet."));
  for (const n of list) box.append(h("div", "note", h("div", "notemeta", n.by + ", " + rel(n.at) + (n.ref ? ", ref: " + n.ref : "")), h("p", "notetext", n.text)));
}
function openDrawer(id, version) { S.drawer = { id, version }; renderDrawer(); $("drawer").hidden = false; $("noteerr").textContent = ""; $("n-text").focus(); }
function closeDrawer() { S.drawer = null; $("drawer").hidden = true; }

function copyButton(text) {
  const b = h("button", "btn tiny", "Copy approve command"); b.type = "button"; b.title = text;
  b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Copy failed (see tooltip)"; } setTimeout(() => { b.textContent = "Copy approve command"; }, 2200); };
  return b;
}
function reviewButton(id, version, verdict) {
  const b = h("button", "btn tiny rowbtn", !verdict ? "Review" : verdict === "error" ? "Retry review" : "Re-review"); b.type = "button"; b.disabled = jobRunning;
  b.title = !verdict ? "Review only " + id + "@" + version : verdict === "error" ? "The last review ended in an error. Review only " + id + "@" + version : "Run a fresh model review of only " + id + "@" + version + " (uses the model; replaces the existing review)";
  b.onclick = () => start("review", { id, version, force: true });
  return b;
}
async function showPlugins() {
  const { data } = await api("/api/plugins"); S.plugins = (data && data.plugins) || []; S.registryUrl = (data && typeof data.registryUrl === "string") ? data.registryUrl : ""; S.githubWebBase = (data && typeof data.githubWebBase === "string") ? data.githubWebBase : "";
  S.canApprove = !!(data && data.canApprove); S.notesOn = !!(data && data.notes); if (S.notesOn) { const n = await api("/api/notes"); S.notes = (n.data && n.data.notes) || []; } const box = $("plugins"); box.replaceChildren();
  if (!S.plugins.length) box.append(empty("Nothing mirrored yet", "Click Sync now to pull releases from the configured repositories."));
  for (const p of S.plugins) {
    const g = h("section", "group"); g.dataset.q = p.id.toLowerCase() + " " + p.versions.map((v) => v.version).join(" ");
    g.append(h("header", null, h("h3", null, p.id), badge(p.versions.length + (p.versions.length === 1 ? " version" : " versions"), "muted")));
    const rows = p.versions.map((v) => {
      const ok = v.approval && v.approval.ok;
      const cmd = SAFE_ID.test(p.id) && SAFE_VER.test(v.version) ? "node packages/sync/dist/cli.js approve " + p.id + "@" + v.version + " --key keys/signing-key.pem --registry registry-data --override 'reason'" : null;
      const acts = h("span", "rowacts"); acts.append(reviewButton(p.id, v.version, v.review ? v.review.verdict : null)); if (!ok) { if (S.canApprove) acts.append(approveControl(p, v)); else if (cmd) acts.append(copyButton(cmd)); }
      acts.append(v.staged ? confirmButton("Release", "Publish to clients?", () => manage("release", p.id, v.version)) : confirmButton("Withdraw", "Withdraw from clients?", () => manage("withdraw", p.id, v.version), true));
      const iss = v.review ? issueLink(p, v) : null; if (iss) acts.append(iss);
      if (S.notesOn) acts.append(noteButton(p.id, v.version));
      return [h("span", "mono", v.version), v.staged ? badge("Held back", "warn", "Not listed to clients yet") : badge("Published", "info"), h("span", "revcell", reviewBadge(v.review), v.review ? reportLink(p.id, v.version) : null), approvalBadge(v.approval), acts];
    });
    g.append(tbl(["Version", "State", "Review", "Approval", "Actions"], rows)); box.append(g);
  }
  applyFilter($("q-plugins"), box, ".group");
}

// ---- clients and activity
const statusKind = (c) => (c === "latest" ? "ok" : c === "behind" ? "warn" : c === "unapproved" || c === "not in registry" ? "bad" : "muted");
const clientName = (c) => c.kind + (c.version ? " " + c.version : "");
async function showClients() {
  const { data } = await api("/api/clients"); S.clients = data; const note = $("clientsnote"), box = $("clients"), ad = $("adoption"); box.replaceChildren(); ad.replaceChildren();
  if (!data || !data.enabled) { note.textContent = ""; ad.append(empty("Client activity is off", "Set accessLog in the admin config to read the registry web server log (see docs/admin.md).")); return; }
  note.textContent = (data.note || "") + (data.error ? "  Problem reading the log: " + data.error : "");
  ad.append(h("h2", "section", "Last fetched, by plugin and version"));
  ad.append(data.adoption.length ? h("div", "standalone", tbl(["Plugin", "Version", "Clients", "Status"], data.adoption.map((a) => [a.id, h("span", "mono", a.version), a.clients, badge(a.status, statusKind(a.status))]))) : empty("No downloads seen yet", "Activity appears once a client fetches a plugin from the registry."));
  box.append(h("h2", "section", "Known clients"));
  if (!data.clients.length) { box.append(empty("No clients yet")); return; }
  box.append(h("div", "standalone", tbl(["Last seen", "Client", "OS", "Zone", "Address", "Last fetched", "Checks"], data.clients.map((c) => [when(c.last), clientName(c), c.os || "", c.zone || "", h("span", "mono", c.addr),
    h("span", null, ...c.plugins.map((p) => h("span", "chip" + (p.status === "latest" ? "" : p.status === "behind" ? " c-warn" : " c-bad"), p.id + "@" + p.version + (p.status === "latest" ? "" : " (" + p.status + ")")))), c.checks]))));
  applyFilter($("q-clients"), box, "tbody tr");
}
async function showActivity() {
  const { data } = await api("/api/activity"); S.activity = data; const box = $("activity"); box.replaceChildren();
  if (!data || !data.enabled) { box.append(empty("Client activity is off", "Set accessLog in the admin config (see docs/admin.md).")); return; }
  if (!data.events.length) { box.append(empty("No activity yet")); return; }
  box.append(h("div", "standalone", tbl(["Time", "Event", "Plugin", "Version", "File", "HTTP", "Client", "Zone"], data.events.map((e) => [when(e.time),
    e.install ? badge("install / update", "ok", "Successful download of main.js") : badge(e.type === "catalog.check" ? "check" : e.type, "muted"), e.plugin || "", h("span", "mono", e.version || ""), e.file || "",
    badge(String(e.status), e.status >= 400 ? "bad" : "muted"), clientName(e.client), e.zone || ""]))));
}

// ---- forwarding
async function showForwarder() {
  const { data } = await api("/api/forwarder"); const box = $("forwarder"); box.replaceChildren();
  if (!data || !data.enabled) { box.append(empty("Forwarding is not configured", "Add a splunk section to the admin config to stream events to a Splunk HTTP Event Collector (see docs/admin.md).")); return; }
  const bad = !!data.lastError;
  const kv = h("dl", "kv",
    h("dt", null, "Status"), h("dd", null, h("span", "dot " + (bad ? "bad" : "ok")), bad ? "Problem, retrying" : "Healthy"),
    h("dt", null, "Destination"), h("dd", "mono", data.url),
    h("dt", null, "Events sent"), h("dd", null, String(data.sent)),
    h("dt", null, "Last success"), h("dd", null, data.lastOk ? when(data.lastOk) : "never"));
  if (bad) kv.append(h("dt", null, "Last error"), h("dd", null, data.lastError), h("dt", null, "Next retry"), h("dd", null, data.retryAt ? when(data.retryAt) : "soon"));
  box.append(h("div", "standalone", kv));
}

// ---- jobs
const jobKind = (s) => (s === "done" ? "ok" : s === "failed" ? "bad" : s === "running" ? "info" : "muted");
async function showJobs(selectId) {
  const { data } = await api("/api/jobs"); S.jobs = (data && data.jobs) || []; const box = $("jobs"); box.replaceChildren();
  let running = null;
  for (const j of S.jobs) { if (j.status === "running") running = running || j;
    const b = h("button", "job", badge(j.status, jobKind(j.status)), h("strong", null, j.kind), h("span", "muted", "by " + j.who), h("span", "when", rel(j.started))); b.type = "button"; b.title = j.started;
    b.setAttribute("aria-pressed", String(j.id === (selectId || S.selectedJob))); b.onclick = () => { S.selectedJob = j.id; showJobs(j.id); }; box.append(b); }
  if (!S.jobs.length) box.append(empty("No jobs yet", "Sync and review runs appear here with their output."));
  const pick = selectId || S.selectedJob || (S.jobs[0] && S.jobs[0].id); if (pick) { S.selectedJob = pick; await showJob(pick); }
  $("running").hidden = !running; if (running) $("runningtext").textContent = "Running " + running.kind + "...";
  jobRunning = !!running; $("sync").disabled = $("review").disabled = jobRunning; document.querySelectorAll(".rowbtn").forEach((b) => { b.disabled = jobRunning; });
  if (running && !polling) polling = setInterval(() => showJobs(), 1500);
  if (!running && polling) { clearInterval(polling); polling = null; await showPlugins(); renderCards(); }
  renderCards();
}
async function showJob(id) { const { data } = await api("/api/jobs/" + id); if (data) $("out").textContent = data.output.join("\\n") + (data.error ? "\\nFAILED: " + data.error : ""); }

async function start(kind, body) {
  say("");
  const { status, data } = await api("/api/" + kind, body || (kind === "review" ? { all: true } : {}));
  if (status === 409) say("Another job is already running.", "bad"); else if (status !== 202) say((data && data.error) || "Failed (" + status + ")", "bad");
  else { say(kind === "sync" ? "Sync started." : "Review started.", "ok"); setTimeout(() => say(""), 3000); }
  if (data && data.job) { S.selectedJob = data.job.id; }
  await showJobs(data && data.job && data.job.id);
}

// ---- tabs
const TABS = [["plugins", "Plugins"], ["clients", "Clients"], ["activity", "Activity"], ["forwarding", "Forwarding"], ["jobs", "Jobs"]];
function buildTabs() {
  const box = $("tabs"); box.replaceChildren();
  for (const [id, label] of TABS) { const b = h("button", "tab", label); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.tab = id;
    if (id === "plugins") { const c = h("span", "count", "0"); c.hidden = true; c.title = "Versions awaiting approval"; b.append(c); }
    b.onclick = () => selectTab(id); box.append(b); }
}
function selectTab(id) {
  if (!TABS.some((t) => t[0] === id)) id = "plugins"; activeTab = id;
  for (const [t] of TABS) { $("panel-" + t).hidden = t !== id; }
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
  try { history.replaceState(null, "", "#" + id); } catch {}
}

// ---- theme (remembered per browser; failure to remember is harmless)
function applyTheme(mode) { if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode; else delete document.documentElement.dataset.theme; $("theme").textContent = "Theme: " + (mode === "light" || mode === "dark" ? mode : "auto"); }
function initTheme() { let m = "auto"; try { m = localStorage.getItem("om-theme") || "auto"; } catch {} applyTheme(m);
  $("theme").onclick = () => { const cur = document.documentElement.dataset.theme || "auto"; const next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto"; applyTheme(next); try { localStorage.setItem("om-theme", next); } catch {} }; }

async function refreshAll() {
  await Promise.all([showPlugins(), showClients(), showActivity(), showForwarder(), showJobs()]);
  $("updated").textContent = "Updated " + new Date().toLocaleTimeString(); renderCards();
}
async function init() {
  const me = await api("/api/me");
  if (me.status !== 200) {
    const pw = !!(me.data && me.data.passwordLogin); $("login").hidden = !pw; $("app").hidden = true; $("who").hidden = true;
    if (!pw) say("Not authorised. This server requires a client certificate that is on the admin allow list.", "bad"); return;
  }
  say(""); $("login").hidden = true; $("app").hidden = false; $("who").hidden = false; $("who").textContent = me.data.name + " (" + me.data.method + ")"; $("logout").hidden = me.data.method !== "password";
  buildTabs(); selectTab((location.hash || "").slice(1) || "plugins"); await refreshAll();
  setInterval(() => { if (!document.hidden && !polling) refreshAll(); }, 30000);
}
$("loginform").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
  const r = await api("/api/login", { name: f.get("name"), password: f.get("password") });
  if (r.status === 200) { e.target.reset(); $("loginerr").textContent = ""; init(); } else $("loginerr").textContent = r.status === 429 ? "Too many attempts. Try again later." : "Sign-in failed."; };
$("logout").onclick = async () => { await api("/api/logout", {}); location.reload(); };
$("sync").onclick = () => start("sync"); $("review").onclick = () => start("review"); $("refresh").onclick = () => refreshAll();
$("q-plugins").oninput = () => applyFilter($("q-plugins"), $("plugins"), ".group"); $("q-clients").oninput = () => applyFilter($("q-clients"), $("clients"), "tbody tr");
$("drawerclose").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.drawer) closeDrawer(); });
$("noteform").onsubmit = async (e) => { e.preventDefault(); if (!S.drawer) return;
  const r = await api("/api/notes", { plugin: S.drawer.id, version: S.drawer.version, text: $("n-text").value, ref: $("n-ref").value });
  if (r.status === 201) { $("n-text").value = ""; $("n-ref").value = ""; $("noteerr").textContent = ""; const n = await api("/api/notes"); S.notes = (n.data && n.data.notes) || []; renderDrawer(); await showPlugins(); }
  else $("noteerr").textContent = (r.data && r.data.error) || "Could not save the note."; };
initTheme();
init();
})();`;
