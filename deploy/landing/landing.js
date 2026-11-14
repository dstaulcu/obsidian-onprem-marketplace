// Lists the registry's plugins from index.json. Text only (textContent), so nothing from the registry is ever treated as markup.
// The nomination address comes from landing.json (set by the admin, never from registry data) and must be an https address.
(async () => {
  try {
    const c = await (await fetch("/landing.json", { cache: "no-cache" })).json();
    if (c && typeof c.nominateUrl === "string" && c.nominateUrl.startsWith("https://")) { document.getElementById("nominatelink").href = c.nominateUrl; document.getElementById("nominate").hidden = false; }
  } catch { /* no link shown */ }
})();
(async () => {
  const ul = document.getElementById("list");
  const say = (t) => { ul.replaceChildren(); const li = document.createElement("li"); li.className = "muted"; li.textContent = t; ul.append(li); };
  try {
    const r = await fetch("/index.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return say("No plugins are published yet.");
    ul.replaceChildren();
    for (const p of items) {
      const li = document.createElement("li");
      const v = document.createElement("span"); v.className = "ver"; v.textContent = "v" + String(p.latestVersion || "?").slice(0, 40);
      const n = document.createElement("div"); n.className = "name"; n.textContent = String(p.name || p.id || "").slice(0, 120);
      const d = document.createElement("div"); d.className = "muted small"; d.textContent = String(p.description || "").slice(0, 300);
      li.append(v, n, d); ul.append(li);
    }
  } catch (e) { say("The plugin list could not be loaded."); }
})();
