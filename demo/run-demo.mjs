// Plays the demo (see demo/README.md, "The story") in a visible browser against the isolated demo stack, with a pause and a spoken-style
// caption per act, a screenshot per act in demo/demo-out/, and a check of what each act should produce. Acts that happen in Obsidian
// use the `om` command-line installer on a demo vault instead (Playwright cannot drive Obsidian itself).
//   node demo/stack.mjs reset      first: a clean stack (nothing synced)
//   node demo/run-demo.mjs [--pause 2500] [--headless] [--only 3,4] [--bail] [--light] [--no-captions] [--no-intro] [--click "Pause@3000,Resume@9000"]  (buttons: Back, Pause, Next, Skip act, Speed) [--no-video] [--gif]
// --pause    milliseconds to hold after each act so an audience can read (default 2500; 0 = as fast as possible)
// --only     comma list of act numbers; later acts need the earlier ones to have run on this stack
// dark mode is the default (the landing page, dashboard and report pages follow the browser colour scheme); --light switches it off
// Exit code 1 if any check failed. Local addresses only: the demo certificate is self-signed and is trusted here.
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes("--" + n);
const root = resolve(import.meta.dirname, "..");
const stack = join(root, "demo", "stack");
const out = join(root, "demo", "demo-out");
const REGISTRY = "http://localhost:8180", ADMIN = "https://localhost:8543";
const pause = Number(arg("pause", "2500"));
const only = arg("only", "") ? new Set(arg("only", "").split(",").map(Number)) : null;
const login = (() => { try { const t = readFileSync(join(stack, "login.txt"), "utf8"); return { user: /^user:\s*(.+)$/m.exec(t)[1].trim(), password: /^password:\s*(.+)$/m.exec(t)[1].trim() }; } catch { return null; } })();
if (!login) { console.error("demo/stack/login.txt not found: run `node demo/stack.mjs reset` first"); process.exit(2); }
// A previous run's output is replaced. If something still has a file open (another demo run in progress, a video player), say so and stop
// before changing anything else, rather than deleting half of that run's files and then failing.
try { rmSync(out, { recursive: true, force: true }); } catch (e) {
  console.error(`demo/demo-out is in use (${e.code}): is another demo run still going, or a video open? Close it and run again.`); process.exit(2);
}
mkdirSync(out, { recursive: true });

// ---- `om`, the command-line installer, run against the demo registry with the demo's public key ----------------------------------
const om = (args) => {
  const r = spawnSync(process.execPath, [join(root, "packages/cli/dist/om.cjs"), ...args, "--registry", REGISTRY, "--key", join(stack, "config", "public-key.txt")],
    { cwd: root, encoding: "utf8", env: { ...process.env, OM_USER_CONFIG: join(stack, "om-user.json") } });
  return { code: r.status, text: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
};
const VAULT = join(root, "demo", "vault");
const installed = (id) => { try { return JSON.parse(readFileSync(join(VAULT, ".obsidian", "plugins", id, "manifest.json"), "utf8")).version; } catch { return null; } };

// ---- bookkeeping ------------------------------------------------------------------------------------------------------------------
const failures = [];
let current = "";
const check = (ok, what) => { console.log(`   ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(`act ${current}: ${what}`); };
const knownGaps = [];
const gap = (what) => { console.log(`   GAP  ${what}`); knownGaps.push(`act ${current}: ${what}`); };
const say = (s) => console.log(`   > ${s}`);

const browser = await chromium.launch({ channel: "msedge", headless: flag("headless"), slowMo: pause ? 120 : 0 }).catch(() => chromium.launch({ channel: "chrome", headless: flag("headless"), slowMo: pause ? 120 : 0 }));
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: flag("light") ? "light" : "dark", viewport: { width: 1400, height: 950 },
  // one page for the whole run, so this is one continuous video (webm; --gif converts it with ffmpeg)
  ...(flag("no-video") ? {} : { recordVideo: { dir: join(out, "video"), size: { width: 1400, height: 950 } } }) });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
// ---- captions: a bar at the bottom of the page saying what is happening and why ------------------------------------------------------
// Drawn through CDP evaluate and the DOM style API, because the admin page's CSP forbids inline scripts and style attributes.
const STORY = {
  1: ["A user opens the marketplace page", "This is the registry's public face, served as plain static files. Right now nothing has been approved, so there is nothing to install.", "Users never see a plugin an admin has not signed off on."],
  2: ["The admin signs in", "The dashboard is a separate service. Its own login is the only way in; it can mirror, review and queue approvals, but it never holds the signing key.", "Keeping the key out of the web-facing service means a break-in there cannot approve anything."],
  3: ["Nominate and add repositories", "Each plugin lives in its own GitHub repository. The admin first checks that a repository has a release the registry would accept, then adds it. Adding also mirrors the releases and has them reviewed.", "The check applies the same rules as sync, so nothing is added that sync would later reject."],
  4: ["Every version is reviewed before anyone can install it", "Fixed checks look for known-risky patterns, and a model reads the code. The model's answer is treated as untrusted and can never lower what the fixed checks found.", "Plugin code runs with full access to a vault. A reviewer has to look at it before a person does."],
  5: ["Report a finding", "For a plugin that fails, one click opens a prefilled issue on the plugin's own repository with the review attached. The admin reads it and posts it themselves; nothing is sent automatically.", "The author gets exactly what was found, and the admin stays in control of what is posted."],
  6: ["Approve: a separate signer does the signing", "A plugin that failed review cannot be approved without a written reason. For a clean one, the request goes to a separate signer container that has the key, no network, and re-checks the files and the review itself before it signs.", "A signature is the only thing clients trust, so the key lives in the smallest, most locked-down place."],
  7: ["A user installs", "The client checks the signature against a public key pinned in advance, and checks every file against the approved hashes. Only the approved plugin installs; the unapproved one is refused. (Shown with the command-line installer, which does exactly what the Obsidian plugin does.)", "A client does not trust the web server, only the signature."],
  8: ["An update", "Approving the next version makes it available. Clients pick it up, and the Clients tab shows which version each one last fetched and what it needs from Obsidian.", "Admins can see who is behind and whether an update is safe for them."],
  9: ["Tamper", "Someone changes the file on the web server after it was approved. The client compares it with the signed hash, sees a mismatch, and refuses to install.", "A compromised web server cannot push code to users, because it cannot make a valid signature."],
  10: ["Pull a version back", "Withdraw removes the approval and hides the version from clients without deleting anything. Approving it again brings it back. Copies already installed stay installed.", "A fast, reversible brake if something turns out to be wrong, without breaking anyone's vault."],
  11: ["The rubric", "The list of checks the reviews use is data, not code. Changing a rule marks older reviews stale and shows whether the change would move any result.", "Admins can see and tune what 'safe enough' means, and know which approvals rest on old rules."],
};
let cap = null;
// Presenter controls (buttons on the caption bar, and Space / right arrow): pause at the next caption, end the current caption early, or
// fast-forward the rest of an act's pauses. They only affect the reading pauses, never the checks or the actions themselves.
const ctl = { paused: false, next: false, back: false, skipAct: false, speed: 1 };
const SPEEDS = [1, 1.5, 2, 0.5];
/** Updates the progress bar and the "next in Ns" text on the caption bar (a no-op while the page is changing). */
const tick = (frac, label) => page.evaluate(([f, l]) => {
  const fill = document.getElementById("om-demo-fill"), t = document.getElementById("om-demo-timer");
  if (fill) fill.style.width = Math.round(f * 1000) / 10 + "%";
  if (t) t.textContent = l;
}, [frac, label]).catch(() => {});
/**
 * A reading pause, with a countdown on the caption bar. Pausing freezes it; Next ends it; Skip act ends this and the act's later ones; Speed
 * makes it run faster or slower. Back replays this caption from its start, or, when the caller can go back (opts.onBack), returns "back".
 */
const linger = async (ms, opts = {}) => {
  if (!ms) return;
  ctl.next = false; ctl.back = false;
  let left = ms, last = Date.now();
  while (true) {
    const now = Date.now(); if (!ctl.paused) left -= (now - last) * ctl.speed; last = now;
    if (ctl.skipAct) { await tick(0, ""); return; }
    if (ctl.next) { ctl.next = false; await tick(0, ""); return; }
    if (ctl.back) { ctl.back = false; if (opts.onBack) { await tick(0, ""); return "back"; } left = ms; await showCaption(); }
    if (!ctl.paused && left <= 0) { await tick(0, ""); return; }
    await tick(1 - Math.max(left, 0) / ms, ctl.paused ? "Paused" : `next in ${Math.ceil(Math.max(left, 0) / ctl.speed / 1000)}s`);
    await page.waitForTimeout(100);
  }
};
const drawCaption = (p, c) => p.evaluate((c) => {
  const old = document.getElementById("om-demo-caption"); if (old) old.remove();
  if (!c) { document.body.style.paddingBottom = ""; return; }
  const set = (el, o) => { for (const k in o) el.style[k] = o[k]; return el; };
  const bar = set(document.createElement("div"), { position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483647", pointerEvents: "none",
    background: "rgba(8,12,20,0.985)", color: "#e8edf5", borderTop: "3px solid #7c8cff", padding: "14px 28px 16px", font: "16px/1.45 system-ui, Segoe UI, sans-serif", boxShadow: "0 -8px 24px rgba(0,0,0,0.4)" });
  bar.id = "om-demo-caption";
  const head = set(document.createElement("div"), { fontWeight: "700", fontSize: "18px", marginBottom: "4px" });
  head.textContent = `${c.label ?? `Act ${c.n} of ${c.total}`}  ·  ${c.title}`;
  const what = set(document.createElement("div"), {}); what.textContent = c.what;
  const why = set(document.createElement("div"), { color: "#9fb0ff", marginTop: "4px" }); why.textContent = "Why: " + c.why;
  bar.append(head, what, why);
  // presenter controls, top right of the bar (the bar itself ignores the mouse; these do not)
  const box = set(document.createElement("div"), { position: "absolute", top: "10px", right: "18px", display: "flex", gap: "8px", pointerEvents: "auto" });
  const mk = (label, cmd, title) => {
    const b = set(document.createElement("button"), { font: "600 13px system-ui, Segoe UI, sans-serif", color: "#e8edf5", background: "#232a3d", border: "1px solid #4a557a", borderRadius: "6px", padding: "5px 12px", cursor: "pointer" });
    b.type = "button"; b.textContent = label; b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); if (window.__omCtl) window.__omCtl(cmd); });
    return b;
  };
  const timer = set(document.createElement("span"), { alignSelf: "center", marginRight: "6px", color: "#9fb0ff", font: "600 13px system-ui, Segoe UI, sans-serif", minWidth: "78px", textAlign: "right" });
  timer.id = "om-demo-timer";
  box.append(timer, mk("← Back", "back", "Previous scene or section where it can be replayed; otherwise replay this caption (it cannot undo a change already made)"),
    mk(c.paused ? "Resume" : "Pause", "pause", "Hold here until resumed (Space)"), mk("Next →", "next", "End this caption now (right arrow)"),
    mk("Skip act", "skip", "Fast-forward the rest of this act's pauses"), mk("Speed " + c.speed + "×", "speed", "How fast the reading pauses run"));
  // progress along the top edge of the bar: how much of this caption's time has passed
  bar.style.borderTop = "3px solid #2a3150";
  const fill = set(document.createElement("div"), { position: "absolute", top: "-3px", left: "0", height: "3px", width: "0%", background: c.paused ? "#f0b429" : "#7c8cff" });
  fill.id = "om-demo-fill";
  bar.append(fill, box);
  if (!window.__omKeys) {
    window.__omKeys = true;
    addEventListener("keydown", (e) => {
      const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !window.__omCtl) return;
      if (e.code === "Space") { e.preventDefault(); window.__omCtl("pause"); } else if (e.code === "ArrowRight") window.__omCtl("next"); else if (e.code === "ArrowLeft") window.__omCtl("back");
    });
  }
  if (c.step) { const s = set(document.createElement("div"), { marginTop: "8px", padding: "6px 10px", background: "rgba(124,140,255,0.18)", borderRadius: "6px", fontWeight: "600" }); s.textContent = "Now: " + c.step; bar.append(s); }
  document.body.append(bar);
  document.body.style.paddingBottom = bar.offsetHeight + 12 + "px";
}, c && { ...c, paused: ctl.paused, speed: ctl.speed }).catch(() => {});
const captionsOn = !flag("no-captions");
await page.exposeFunction("__omCtl", async (cmd) => {
  if (cmd === "pause") { ctl.paused = !ctl.paused; console.log(ctl.paused ? "   (paused)" : "   (resumed)"); await showCaption(); }
  else if (cmd === "next") ctl.next = true;
  else if (cmd === "back") ctl.back = true;
  else if (cmd === "speed") { ctl.speed = SPEEDS[(SPEEDS.indexOf(ctl.speed) + 1) % SPEEDS.length]; await showCaption(); }
  else if (cmd === "skip") { ctl.skipAct = true; ctl.paused = false; await showCaption(); }
});
const showCaption = () => captionsOn && cap ? drawCaption(page, cap) : Promise.resolve();
/** What is about to happen, on the bar, held long enough to read before the page moves. */
const step = async (text) => { if (!captionsOn || !cap) return; cap = { ...cap, step: text }; await showCaption(); await linger(Math.round(pause * 0.8)); };
page.on("domcontentloaded", () => { showCaption(); });
/** Everything happens on ONE page, so the single video shows the whole story. openExtra goes to a report or similar; back() returns to the dashboard. */
const openExtra = async (url) => { await page.goto(url, { waitUntil: "load" }); if (captionsOn && cap) await drawCaption(page, cap); return page; };
const back = async (tabName = "Plugins") => { await page.goto(ADMIN + "/", { waitUntil: "networkidle" }); await page.waitForSelector("#tabs .tab", { timeout: 15000 }); await tab(tabName); };
const narrate = async (p, text, hold, onBack) => { if (captionsOn && cap) { cap = { ...cap, step: text }; await drawCaption(p, cap); } return linger(hold, { onBack }); };
/** Walks a long page one section at a time (each <h2>): scroll to it, say what it is, hold long enough to read. */
const walk = async (p, notes, hold) => {
  const hs = p.locator("h2"), n = await hs.count();
  for (let i = 0; i < n; i++) {
    const t = (await hs.nth(i).innerText()).trim();
    await hs.nth(i).evaluate((e) => e.scrollIntoView({ block: "start" }));
    const r = await narrate(p, (notes.find(([re]) => re.test(t)) ?? [0, t])[1], hold, true);
    if (r === "back") i = Math.max(-1, i - 2); // the loop adds one: this goes to the previous section (the first one restarts)
  }
};
/** The user's side: the public marketplace page, shown on the same page for a few seconds, then back to the admin dashboard. */
const userView = async (text, name, expectHello) => {
  cap = cap ? { ...cap, step: text } : cap;
  await page.goto(REGISTRY + "/?v=" + Date.now() + "#plugins", { waitUntil: "networkidle" });
  if (captionsOn && cap) await drawCaption(page, cap);
  const seen = (await page.$$eval("#list li", (e) => e.map((x) => x.innerText.replace(/\s+/g, " ").trim()))).join(" | ");
  say("what users see: " + (seen || "(nothing)"));
  check(!/Shady/i.test(seen), "users never see shady-sync");
  if (expectHello !== null && expectHello !== undefined) check(/Hello Notes/i.test(seen) === expectHello, expectHello ? "users see hello-notes" : "users do not see hello-notes yet");
  await shot("users-" + name);
  await linger(Math.round(pause * 3));
  cap = cap ? { ...cap, step: undefined } : cap; await back();
};

const shot = (name) => page.screenshot({ path: join(out, `${current.toString().padStart(2, "0")}-${name}.png`), fullPage: true });
const tab = async (name) => { await page.locator("#tabs .tab").filter({ hasText: name }).first().click(); await page.waitForTimeout(500); };
const idle = async () => { await page.waitForTimeout(900); await page.locator("#running").waitFor({ state: "hidden", timeout: 180000 }); await page.waitForTimeout(600); }; // locator waits only: the page's CSP forbids waitForFunction
const row = (id, version) => page.locator(`section.group:has(h3:text-is("${id}")) tr:has(.mono:text-is("${version}"))`);
const refresh = async () => { await page.click("#refresh"); await page.waitForTimeout(1200); };
/** Buttons that ask "Click again" within four seconds. */
const confirmClick = async (scope, label) => { const b = scope.locator("button", { hasText: new RegExp(`^${label}$`) }); await b.click(); await scope.locator("button", { hasText: "Click again" }).click(); };
const rowText = async (id, version) => (await row(id, version).innerText()).replace(/\s+/g, " ");

const ACTS = [
  [1, "A user opens the marketplace page", async () => {
    await page.goto(REGISTRY + "/", { waitUntil: "networkidle" });
    say("Nothing is approved yet, so users see an empty list. This is what they see first.");
    check((await page.title()).length > 0, "the landing page loads");
    await shot("landing-empty");
  }],
  [2, "Admin signs in", async () => {
    await page.goto(ADMIN + "/", { waitUntil: "networkidle" });
    await page.fill("#f-name", login.user); await page.fill("#f-pass", login.password);
    await page.click('#loginform button[type="submit"]');
    await page.waitForSelector("#tabs .tab", { timeout: 15000 });
    await page.waitForTimeout(1000);
    const tabs = await page.$$eval("#tabs .tab", (e) => e.map((x) => x.textContent.replace(/\d+$/, "").trim()));
    say("Tabs: " + tabs.join(", "));
    check(["Plugins", "Clients", "Activity", "Repositories", "Nominations", "Rubric", "Forwarding", "Jobs"].every((t) => tabs.includes(t)), "all eight tabs are there");
    await shot("dashboard-empty");
  }],
  [3, "Add the repositories", async () => {
    await tab("Repositories");
    for (const repo of ["demo/hello-notes", "demo/shady-sync"]) {
      await step(`Checking ${repo}: does it have a release the registry would accept?`);
      await page.fill("#f-repo", repo);
      await page.click("#repocheck");
      await page.locator("#repoout").filter({ hasText: /would (not )?be accepted/i }).waitFor({ timeout: 30000 });
      check(/would be accepted/i.test(await page.textContent("#repoout")), `${repo}: the check accepts it`);
      await shot("check-" + repo.split("/")[1]);
      await linger(pause / 2);
      await step(`Adding ${repo}: mirror its releases, then review them`);
      await page.click("#repoadd");
      await idle();
    }
    say("Adding a repository syncs it and, with a model configured, reviews it straight away.");
    await shot("repositories");
    await tab("Plugins"); await refresh();
    check(await row("hello-notes", "1.0.0").count() === 1 && await row("hello-notes", "1.1.0").count() === 1, "hello-notes 1.0.0 and 1.1.0 are listed");
    check(await row("shady-sync", "1.0.0").count() === 1, "shady-sync 1.0.0 is listed");
    await shot("plugins-synced");
  }],
  [4, "Review", async () => {
    await tab("Plugins");
    await step("The reviews are in: hello-notes passed, shady-sync failed");
    const hello = await rowText("hello-notes", "1.0.0"), shady = await rowText("shady-sync", "1.0.0");
    say("hello-notes: " + (/\bpass\b/.test(hello) ? "pass" : "?") + "   shady-sync: " + (/\bfail\b/.test(shady) ? "fail" : /findings/.test(shady) ? "findings" : "?"));
    check(/\bpass\b/.test(hello), "hello-notes reviews as pass");
    check(/\bfail\b|findings/.test(shady), "shady-sync reviews as fail or findings");
    // open the report the way an admin would
    await step("Opening shady-sync's full report: its manifest, the checks that fired and the model's findings");
    const report = row("shady-sync", "1.0.0").locator("a.reportlink");
    const hold = Math.round(pause * 3.5);
    // the clean one first, briefly, for contrast
    const hp = await openExtra(await row("hello-notes", "1.0.0").locator("a.reportlink").getAttribute("href"));
    await narrate(hp, "hello-notes: a clean report. No fixed check fired and the model found nothing to flag", hold);
    await shot("review-report-hello-notes");
    await back();
    const rp = await openExtra(await report.getAttribute("href"));
    await narrate(rp, "shady-sync: the same kind of report, but this one is a failure. Reading it from the top", Math.round(pause * 2));
    await walk(rp, [
      [/manifest/i, "The plugin's own manifest: what the author says it is and does. The review judges the code against this"],
      [/deterministic/i, "Fixed checks that need no model: every rule that fired and how serious it is. These set a floor the model cannot lower"],
      [/where/i, "The exact lines that tripped each check, so an admin can confirm with their own eyes"],
      [/model/i, "The model's reading of the code, including the injection attempt aimed at the reviewer, which it was told to ignore"],
    ], hold);
    const body = await rp.innerText("body");
    check(/manifest/i.test(body), "the report includes the plugin's manifest");
    check(/ignore|injection/i.test(body), "the report mentions the injection attempt");
    await shot("review-report-shady-sync");
    cap = { ...cap, step: undefined }; await back();
    await shot("plugins-reviewed");
    await userView("Before any approval: this is the public page users see right now", "before-approval", false);
  }],
  [5, "Report a finding", async () => {
    const btn = row("shady-sync", "1.0.0").locator("button.issuelink");
    // KNOWN GAP: the button is built from the repository in index.json, which lists only published plugins. With publishPolicy "approved" a
    // plugin whose versions are all held back (such as one that failed review) has no repository there, so no button. Reported, not hidden.
    if (await btn.count() === 0) gap("no Report issue button for a plugin with nothing published (the repository is only known from index.json)");
    else check(await btn.count() === 1, "shady-sync has a Report issue button");
    if (await btn.count()) {
      // The demo's "GitHub" has no web pages, so show the prefilled issue (title and text) instead of a browser error. Nothing is posted.
      let seen = null;
      await ctx.route(/\/issues\/new/, (route) => {
        const u = new URL(route.request().url()); seen = { title: u.searchParams.get("title") ?? "", body: u.searchParams.get("body") ?? "" };
        const esc = (s) => s.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));
        route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset=utf-8><meta name="color-scheme" content="dark light"><title>New issue (demo stand-in)</title><body style="font:14px system-ui;max-width:900px;margin:2rem auto"><h2>New issue (demo stand-in, nothing is posted)</h2><p><b>${esc(seen.title)}</b></p><pre style="white-space:pre-wrap">${esc(seen.body)}</pre>` });
      });
      const popup = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
      await btn.click();
      const p = await popup;
      if (p) {
        await p.waitForLoadState("load").catch(() => {}); const issueUrl = p.url(); await p.close();
        await page.goto(issueUrl, { waitUntil: "load" }); if (captionsOn && cap) await drawCaption(page, cap); // same page, so it is in the video
        say("Opens the new-issue page, prefilled: " + (seen?.title ?? "(no title)"));
        check(!!seen && /issues\/new/.test(issueUrl), "the popup is a new-issue page");
        check(!!seen && /shady-sync/.test(seen.title + seen.body), "its text is the review of shady-sync");
        await narrate(page, "The issue is prefilled with the review: the manifest, the checks that fired and the model's findings. Nothing is posted until the admin does it", Math.round(pause * 3));
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
        await narrate(page, "The review text is untrusted input: it is shown only inside code fences, with backticks removed and the length capped", Math.round(pause * 3));
        await shot("report-issue"); cap = { ...cap, step: undefined }; await back();
      } else check(false, "Report issue opened a page");
    }
  }],
  [6, "Approve", async () => {
    // shady-sync cannot be approved without a written reason
    await step("shady-sync failed review, so approving it needs a written reason; with none it stays unapproved");
    await row("shady-sync", "1.0.0").locator("button", { hasText: "Approve..." }).click();
    await page.waitForTimeout(500);
    await row("shady-sync", "1.0.0").locator("button", { hasText: "Approve anyway" }).click(); // empty reason: nothing may happen
    await page.waitForTimeout(800);
    check(!/approved/i.test((await rowText("shady-sync", "1.0.0")).replace(/not approved/i, "")), "shady-sync is NOT approved without a reason");
    await shot("shady-needs-override");
    await step("Approving hello-notes 1.0.0: the request goes to the separate signer container, which signs it");
    await confirmClick(row("hello-notes", "1.0.0"), "Approve");
    await idle(); await refresh();
    const t = await rowText("hello-notes", "1.0.0");
    check(/Approved/.test(t.replace(/Not approved/i, "")), "hello-notes 1.0.0 shows Approved");
    say("Say aloud: the admin container never holds the signing key; the signer container does, and it has no network.");
    const logs = spawnSync("docker", ["compose", "-f", join(root, "demo", "docker-compose.yml"), "logs", "--tail", "5", "signer"], { encoding: "utf8" }).stdout;
    check(/hello-notes/.test(logs), "the signer's log shows the signature");
    say("signer log: " + logs.trim().split("\n").pop());
    await shot("approved-1.0.0");
    await userView("After approving hello-notes 1.0.0: the public page now offers it. shady-sync is still not there", "after-approval", true);
  }],
  [7, "A user installs (command line stands in for Obsidian)", async () => {
    rmSync(VAULT, { recursive: true, force: true }); mkdirSync(join(VAULT, ".obsidian"), { recursive: true }); // an empty vault, as Obsidian would make
    await step("The client asks the registry what it can install");
    const list = om(["list"]);
    say(list.text.split("\n").slice(0, 6).join(" | "));
    check(/hello-notes@1\.0\.0/.test(list.text), "hello-notes 1.0.0 is offered");
    check(!/shady-sync/.test(list.text), "shady-sync is not offered at all");
    const r = om(["install", "hello-notes", "--vault", VAULT]);
    say(r.text.split("\n").pop());
    check(r.code === 0 && installed("hello-notes") === "1.0.0", "hello-notes 1.0.0 installs");
    await step("Trying to install the unapproved shady-sync: it is refused");
    const s = om(["install", "shady-sync", "--vault", VAULT]);
    check(s.code !== 0 && installed("shady-sync") === null, "shady-sync is refused");
  }],
  [8, "Update path", async () => {
    await step("Approving hello-notes 1.1.0, then the client updates from 1.0.0");
    await confirmClick(row("hello-notes", "1.1.0"), "Approve");
    await idle(); await refresh();
    check(/Approved/.test((await rowText("hello-notes", "1.1.0")).replace(/Not approved/i, "")), "hello-notes 1.1.0 shows Approved");
    const r = om(["update", "--vault", VAULT]);
    say(r.text.split("\n").pop());
    check(r.code === 0 && installed("hello-notes") === "1.1.0", "the client updates to 1.1.0");
    await userView("After approving 1.1.0: users are now offered the newer version", "after-update", true);
    await tab("Clients"); await page.waitForTimeout(1200);
    await shot("clients");
  }],
  [9, "Tamper", async () => {
    const f = join(stack, "registry-data", "plugins", "hello-notes", "1.1.0", "main.js");
    const backup = join(stack, "main.js.orig");
    if (!existsSync(f)) { check(false, "the served file exists (" + f + ")"); return; }
    await step("Changing main.js on the web server after it was approved");
    copyFileSync(f, backup); appendFileSync(f, "\n// injected by an attacker after approval\n");
    const other = join(root, "demo", "vault-tamper"); rmSync(other, { recursive: true, force: true }); mkdirSync(join(other, ".obsidian"), { recursive: true });
    await step("A client downloads it: the hash no longer matches the signed approval, so it refuses");
    const r = om(["install", "hello-notes@1.1.0", "--vault", other]);
    say(r.text.split("\n").pop());
    check(r.code !== 0 && !existsSync(join(other, ".obsidian", "plugins", "hello-notes", "main.js")), "the client refuses the changed file");
    copyFileSync(backup, f); rmSync(backup); rmSync(other, { recursive: true, force: true });
    const again = om(["verify", "--vault", VAULT]);
    check(again.code === 0, "after restoring the file, verify passes");
    say("Say aloud: a file changed on the web server after approval fails the check on the client.");
  }],
  [10, "Pull a version back", async () => {
    await tab("Plugins"); await refresh();
    await step("Withdrawing 1.1.0: users stop seeing it, installed copies stay");
    await confirmClick(row("hello-notes", "1.1.0"), "Withdraw");
    await idle(); await refresh();
    const w = om(["list"]);
    say(w.text.split("\n").find((l) => /hello-notes/.test(l)) ?? w.text);
    check(!/hello-notes@1\.1\.0/.test(w.text), "users no longer see 1.1.0");
    await shot("withdrawn");
    await userView("After withdrawing 1.1.0: the public page falls back to the last approved version", "withdrawn", true);
    await step("Approving 1.1.0 again: users see it once more");
    await confirmClick(row("hello-notes", "1.1.0"), "Approve");
    await idle(); await refresh();
    const r = om(["list"]);
    check(/hello-notes@1\.1\.0/.test(r.text), "approved again: users see 1.1.0");
    check(installed("hello-notes") === "1.1.0", "what was installed stays installed");
    await shot("reapproved");
    await userView("After approving it again: 1.1.0 is back", "reapproved", true);
  }],
  [11, "The rubric", async () => {
    await tab("Rubric"); await page.waitForTimeout(800);
    check((await page.innerText("#rubric")).trim().length > 50, "the rubric tab lists the checks");
    await shot("rubric");
  }],
];

// --click "Pause@3000,Resume@9000,Skip@12000": presses the caption bar's buttons (matched by label text) that many ms after the run starts.
// For unattended runs and for testing the controls; a person just clicks them, or uses Space (pause) and the right arrow (next).
for (const spec of (arg("click", "") ? arg("click", "").split(",") : [])) {
  const [label, at] = spec.split("@");
  if (label.trim() === "!shot") { setTimeout(() => { page.screenshot({ path: join(out, `click-shot-${at}.png`) }).catch(() => {}); }, Number(at)); continue; } // a picture of the screen at that moment
  setTimeout(() => { page.locator("#om-demo-caption button", { hasText: label.trim() }).first().click({ timeout: 4000 }).catch(() => console.log(`   (no "${label}" button to press at ${at} ms)`)); }, Number(at));
}
// ---- Introduction: the concept, shown on the project's own GitHub page, before anything is demonstrated --------------------------------
// This is the only part that needs the internet (the demo itself is local). If github.com cannot be reached it is skipped, never failed.
const REPO_WEB = "https://github.com/dstaulcu/obsidian-onprem-marketplace";
const INTRO = [
  { url: REPO_WEB, focus: [".markdown-body"], title: "What this is",
    what: "Obsidian's built-in plugin browser cannot be pointed at an internal source. This project adds one: a static registry, a page for users, a dashboard for admins, and an Obsidian plugin that installs from it.",
    why: "An organization needs control over which plugins reach people's vaults, without losing the convenience of installing from inside Obsidian." },
  { url: REPO_WEB, focus: ['[data-type="mermaid"]', ".markdown-body pre", ".markdown-body p >> nth=1"], title: "How a plugin gets to a user",
    what: "Plugins come from repositories an admin nominates. Each version is synced, reviewed by fixed checks plus a model, approved with a signature, and only then published. Clients verify before they install.",
    why: "Every step narrows what can reach a vault. Nothing is trusted just because it is on the server." },
  { url: REPO_WEB, focus: ['h2:has-text("For users")'], title: "For users",
    what: "Users browse approved plugins on a web page and install from inside Obsidian. A one-time setup pins the registry's public key.",
    why: "Installing stays as easy as the built-in browser, and the pinned key is what lets the client refuse anything that was not approved." },
  { url: REPO_WEB, focus: ['h2:has-text("For admins")'], title: "For admins",
    what: "Admins work in a dashboard: review results, approvals, which clients run which versions, the rubric the reviews use, and the repositories being mirrored.",
    why: "The people accountable for approvals get one place to see the evidence and decide." },
  { url: REPO_WEB, focus: ['p:has-text("Safety by design")'], title: "Safety by design",
    what: "The admin service never holds the signing key or a model credential. A separate signer container with no network signs approvals, and a separate reviewer container runs the model. Every privileged action is audited.",
    why: "Breaking into the web-facing service must not be enough to approve or publish anything." },
  { url: REPO_WEB + "/blob/main/docs/concepts/security.md", focus: ["article h1", ".markdown-body"], title: "The trust model is written down",
    what: "What is trusted, what is not, and the known gaps are documented, including what this does not protect against.",
    why: "Whoever approves plugins should know where the protection ends." },
];
async function intro() {
  let up = false;
  try { up = (await fetch("https://github.com", { method: "HEAD", signal: AbortSignal.timeout(6000) })).ok; } catch { /* offline */ }
  if (!up) { console.log("\nIntroduction skipped: github.com cannot be reached (the rest of the demo is local and does not need it)."); return; }
  console.log("\nIntroduction: the project on GitHub");
  for (let i = 0; i < INTRO.length; i++) {
    const s = INTRO[i]; current = 0;
    cap = { label: `Introduction ${i + 1} of ${INTRO.length}`, title: s.title, what: s.what, why: s.why };
    try {
      await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(pause ? 2500 : 300); // let the page and its diagram render
      let at = false;
      for (const sel of s.focus) { const l = page.locator(sel).first(); if (await l.count()) { await l.evaluate((e) => e.scrollIntoView({ block: "start", behavior: "instant" })).catch(() => {}); at = true; break; } }
      if (!at) console.log("   (could not find the part of the page to focus on; showing the top)");
      await page.waitForTimeout(pause ? 800 : 100); // let any scroll settle before the caption is drawn
      await drawCaption(page, cap);
      console.log(`   ${i + 1}. ${s.title}`);
      if (await linger(Math.round(pause * 4), { onBack: true }) === "back") i = Math.max(-1, i - 2); // back goes to the previous scene (the first restarts)
      await linger(Math.round(pause * 4));
    } catch (e) { console.log(`   (introduction page ${i + 1} skipped: ${e.message.split("\n")[0]})`); }
  }
  cap = { label: "Introduction", title: "Now, the demonstration", what: "A local copy, running in containers on this machine, with two example plugins: one ordinary, and one built to look suspicious (it is inert). Watch what the admin sees and what a user sees at each step.", why: "Seeing the same plugin before and after each decision is the clearest way to show what the process protects." };
  await drawCaption(page, cap); await linger(Math.round(pause * 3));
  cap = null;
}
if (captionsOn && !flag("no-intro") && (!only || only.has(0))) await intro();

for (const [n, title, fn] of ACTS) {
  if (only && !only.has(n)) continue;
  current = n; console.log(`\nAct ${n}: ${title}`);
  { const [t, what, why] = STORY[n]; cap = { n, total: ACTS.length, title: t, what, why }; ctl.skipAct = false; await showCaption(); await linger(pause * 2); } // time to read before anything moves
  try { await fn(); } catch (e) { check(false, "did not complete: " + e.message.split("\n")[0]); await shot("error").catch(() => {}); if (flag("bail")) break; }
  await linger(pause);
}
if (pageErrors.length) failures.push("script errors in the dashboard: " + [...new Set(pageErrors)].join("; "));
const video = page.video();
await ctx.close();
if (video) {
  const webm = join(out, "demo.webm");
  await video.saveAs(webm).catch((e) => console.log("could not save the video: " + e.message));
  rmSync(join(out, "video"), { recursive: true, force: true });
  if (existsSync(webm)) {
    console.log("video: " + webm);
    if (flag("gif")) {
      const gif = join(out, "demo.gif");
      const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "fps=8,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse", gif], { stdio: "inherit" });
      console.log(r.status === 0 ? "gif: " + gif : "gif not made: ffmpeg is needed on the PATH (winget install Gyan.FFmpeg)");
    }
  }
}
await browser.close();
console.log(`\nscreenshots: ${out}`);
if (knownGaps.length) console.log(`${knownGaps.length} known gap(s) in the product, not counted as failures:\n- ` + knownGaps.join("\n- "));
console.log(failures.length ?`${failures.length} check(s) failed:\n- ` + failures.join("\n- ") : "all checks passed");
process.exit(failures.length ? 1 : 0);
