// Registry landing page. Everything from the registry (index.json, stats.json, downloads.json) is untrusted text: it is only ever
// shown with textContent, and the few values that become links are shape-checked first. Settings come from landing.json,
// which the admin controls: nominateUrl, sourceBase (https only), pinned (plugin ids shown first).
(async () => {
  const $ = (id) => document.getElementById(id);
  const get = async (path) => { try { const r = await fetch(path, { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch { return null; } };
  const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k))); return e; };
  const cut = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n);
  const SAFE_REPO = /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/, SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  const isHttps = (u) => typeof u === "string" && u.startsWith("https://");

  const cfg = (await get("/landing.json")) || {};
  const pinned = Array.isArray(cfg.pinned) ? cfg.pinned.filter((x) => typeof x === "string").slice(0, 10) : [];
  // Tabs. A first visit opens "Get started"; after that the tab last used (or the #hash) is remembered in this browser.
  const TABS = ["plugins", "start"];
  const pick = (id, save) => {
    if (!TABS.includes(id)) id = "plugins";
    for (const t of TABS) { $("panel-" + t).hidden = t !== id; const b = $("tab-" + t); b.setAttribute("aria-selected", String(t === id)); b.tabIndex = t === id ? 0 : -1; }
    if (save) { try { localStorage.setItem("om-tab", id); } catch { /* optional */ } try { history.replaceState(null, "", "#" + id); } catch { /* optional */ } }
  };
  let firstTab = "start"; try { firstTab = localStorage.getItem("om-tab") || "start"; } catch { /* optional */ }
  const wanted = location.hash.slice(1);
  pick(TABS.includes(wanted) ? wanted : firstTab, false);
  for (const t of TABS) $("tab-" + t).addEventListener("click", () => pick(t, true));
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const cur = TABS.findIndex((t) => $("tab-" + t).getAttribute("aria-selected") === "true");
    const next = TABS[(cur + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]; pick(next, true); $("tab-" + next).focus();
  });
  $("gotoplugins").addEventListener("click", () => pick("plugins", true));
  const nominate = isHttps(cfg.nominateUrl) ? cfg.nominateUrl : "";
  if (nominate) { $("nominatelink").href = nominate; $("nominate").hidden = false; $("nominatetop").href = nominate; $("nominatetop").hidden = false; }

  const index = await get("/index.json");
  const stats = await get("/stats.json");
  const downloads = await get("/downloads/downloads.json");
  const items = Array.isArray(index) ? index.filter((p) => p && typeof p.id === "string" && SAFE_ID.test(p.id)) : null;
  const installs = (id) => { const s = stats && stats.plugins && stats.plugins[id]; return s && typeof s.installs === "number" ? s.installs : null; };
  const haveStats = !!(stats && stats.plugins && typeof stats.plugins === "object" && Object.keys(stats.plugins).length > 0);

  // ---- downloads (om.exe and friends)
  const files = downloads && Array.isArray(downloads.files) ? downloads.files.filter((f) => f && SAFE_FILE.test(String(f.name))) : [];
  if (files.length) {
    const box = $("downloadlist"); box.replaceChildren();
    for (const f of files) {
      const a = el("a", "dl", "Download " + f.name); a.href = "/downloads/" + f.name; a.setAttribute("download", "");
      const mb = typeof f.size === "number" ? (f.size / 1048576).toFixed(1) + " MB" : "";
      box.append(el("li", "card", el("div", "row", el("span", "name", cut(f.name, 80)), el("span", "ver", "v" + cut(f.version, 40) + (mb ? " - " + mb : ""))),
        f.note ? el("div", "muted small", cut(f.note, 200)) : null, a,
        el("div", "muted small", "SHA-256 ", el("code", null, cut(f.sha256, 64)))));
    }
    $("downloads").hidden = false; $("nodownload").hidden = true;
  }
  document.querySelectorAll(".origin").forEach((e) => { e.textContent = location.origin; });
  // Getting started: help text and the optional key page come from landing.json (admin-controlled), shown as text; only https links are used.
  if (typeof cfg.keyHelp === "string" && cfg.keyHelp.trim()) $("keyhelp").textContent = cut(cfg.keyHelp, 300);
  if (isHttps(cfg.keyUrl)) { $("keylink").href = cfg.keyUrl; $("keylink").hidden = false; }
  if (typeof cfg.toolHint === "string" && cfg.toolHint.trim()) $("toolhint").textContent = cut(cfg.toolHint, 300);
  if (typeof cfg.contact === "string" && cfg.contact.trim()) $("contact").textContent = cut(cfg.contact, 300);
  $("copycmds").addEventListener("click", async () => {
    const b = $("copycmds"); try { await navigator.clipboard.writeText($("cmds").textContent); b.textContent = "Copied"; } catch { b.textContent = "Select the text and copy"; }
    setTimeout(() => { b.textContent = "Copy"; }, 2000);
  });

  // ---- plugin list
  const list = $("list"), count = $("count");
  const say = (t) => { list.replaceChildren(el("li", "muted", t)); count.textContent = ""; };
  if (!items) return say("The plugin list could not be loaded.");
  if (!items.length) return say("No plugins are published yet.");

  const sortSel = $("sort"), q = $("q");
  if (!haveStats) { const o = sortSel.querySelector("option[value=installs]"); if (o) o.remove(); }
  const sorters = {
    name: (a, b) => cut(a.name || a.id, 200).localeCompare(cut(b.name || b.id, 200)),
    updated: (a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0),
    installs: (a, b) => (installs(b.id) || 0) - (installs(a.id) || 0) || sorters.name(a, b),
  };
  const rel = (iso) => { const ms = Date.parse(iso); if (isNaN(ms)) return ""; const d = Math.round((Date.now() - ms) / 86400000); return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 60 ? d + " days ago" : new Date(ms).toISOString().slice(0, 10); };

  const card = (p, isPinned) => {
    const li = el("li", "card" + (isPinned ? " pinned" : ""));
    const top = el("div", "row", el("span", "name", cut(p.name || p.id, 120), isPinned ? el("span", "tag", "Featured") : null), el("span", "ver", "v" + cut(p.latestVersion || "?", 40)));
    const meta = [];
    if (p.author) meta.push("by " + cut(p.author, 80));
    const u = rel(p.updated); if (u) meta.push("updated " + u);
    if (p.isDesktopOnly) meta.push("desktop only");
    const n = installs(p.id); if (n !== null) meta.push(n + " client" + (n === 1 ? "" : "s") + " in " + cut(stats.windowDays, 4) + " days");
    li.append(top, el("div", "desc", cut(p.description, 300)), el("div", "muted small", meta.join("  |  ")));
    if (isHttps(cfg.sourceBase) && SAFE_REPO.test(String(p.repo || ""))) {
      const a = el("a", "src", "Source and feedback"); a.href = cfg.sourceBase.replace(/\/+$/, "") + "/" + p.repo; a.target = "_blank"; a.rel = "noopener noreferrer"; li.append(a);
    }
    return li;
  };
  const render = () => {
    const term = q.value.trim().toLowerCase();
    const match = (p) => !term || [p.name, p.id, p.description, p.author].some((x) => cut(x, 400).toLowerCase().includes(term));
    const found = items.filter(match).sort(sorters[sortSel.value] || sorters.name);
    const rank = (p) => { const i = pinned.indexOf(p.id); return i < 0 ? 1e9 : i; };
    found.sort((a, b) => rank(a) - rank(b)); // stable: pinned first, in the configured order; the rest keep the chosen sort
    list.replaceChildren();
    for (const p of found) list.append(card(p, pinned.includes(p.id)));
    count.textContent = found.length === items.length ? items.length + " plugin" + (items.length === 1 ? "" : "s") : found.length + " of " + items.length + " plugins";
    if (!found.length) list.append(el("li", "card empty", "Nothing matches \"" + cut(q.value, 60) + "\". ", nominate ? (() => { const a = el("a", null, "Nominate it"); a.href = nominate; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; })() : null, nominate ? " and an admin will look at it." : ""));
  };
  $("tabcount").textContent = String(items.length); $("tabcount").hidden = false;
  q.addEventListener("input", render); sortSel.addEventListener("change", render);
  $("controls").hidden = false;
  if (haveStats) { $("statsnote").hidden = false; $("statsnote").textContent = "Client counts are how many different clients fetched a plugin in the last " + cut(stats.windowDays, 4) + " days. They come from downloads, not from use, and small counts are left out."; }
  render();
})();
