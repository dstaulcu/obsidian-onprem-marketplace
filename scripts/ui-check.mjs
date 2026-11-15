// Opens the landing page and the admin dashboard in a real browser (the Edge/Chrome already installed; nothing is downloaded), clicks
// through every tab, saves a screenshot of each and fails on any script error, console error or failed request.
//   npm run ui-check [-- --admin https://localhost:8443 --registry http://localhost:8080 --out ui-check-out]
// Needs the containers running (docker compose --profile signer up -d) and, for the admin pages, a TEST login in config/test-login.txt
// ("user: ..." and "password: ..." lines). Only local addresses are accepted, because the admin's self-signed certificate is trusted here.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const root = resolve(import.meta.dirname, "..");
const adminUrl = arg("admin", "https://localhost:8443").replace(/\/+$/, "");
const registryUrl = arg("registry", "http://localhost:8080").replace(/\/+$/, "");
const out = resolve(arg("out", join(root, "ui-check-out")));
const loginFile = arg("login", join(root, "config", "test-login.txt"));
for (const u of [adminUrl, registryUrl]) if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(u)) { console.error("refusing a non-local address: " + u); process.exit(2); }
mkdirSync(out, { recursive: true });

const problems = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => problems.push(`${label}: script error: ${e.message}`));
  // "Failed to load resource" console lines carry no address; the response check below reports those with the address.
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) problems.push(`${label}: console error: ${m.text()}`); });
  page.on("requestfailed", (r) => problems.push(`${label}: request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/me$/.test(r.url()) && !/\/favicon\.ico$/.test(r.url())) problems.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
};
const shot = async (page, name) => { const f = join(out, name + ".png"); await page.screenshot({ path: f, fullPage: true }); console.log("  saved " + f); };

async function tabs(page, label, selector) {
  const names = await page.$$eval(selector, (els) => els.map((e) => ({ id: e.dataset.tab || e.id, text: e.textContent.trim().replace(/\s+/g, " ") })));
  console.log(`${label}: ${names.length} tab(s): ${names.map((n) => n.text).join(", ")}`);
  if (!names.length) problems.push(`${label}: no tabs found`);
  for (const n of names) {
    await page.locator(selector).filter({ hasText: n.text.split(" ")[0] }).first().click();
    await page.waitForTimeout(600);
    await shot(page, `${label}-${(n.id || n.text).toString().replace(/[^A-Za-z0-9_-]/g, "")}`);
  }
}

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });

// landing page (no login)
{
  const page = await ctx.newPage(); watch(page, "landing");
  const r = await page.goto(registryUrl + "/", { waitUntil: "networkidle" });
  console.log(`landing: HTTP ${r?.status()}, title "${await page.title()}"`);
  await shot(page, "landing-home");
  await tabs(page, "landing", '[role="tab"]');
  await page.close();
}

// admin dashboard (test login)
{
  let creds = null;
  try {
    const t = readFileSync(loginFile, "utf8");
    creds = { user: /^user:\s*(.+)$/m.exec(t)?.[1].trim(), password: /^password:\s*(.+)$/m.exec(t)?.[1].trim() };
  } catch { /* handled below */ }
  const page = await ctx.newPage(); watch(page, "admin");
  await page.goto(adminUrl + "/", { waitUntil: "networkidle" });
  if (!creds?.user || !creds?.password) { console.log("admin: no test login found, only the sign-in page was checked"); await shot(page, "admin-signin"); }
  else {
    await page.fill("#f-name", creds.user); await page.fill("#f-pass", creds.password);
    await page.click('#loginform button[type="submit"]');
    await page.waitForSelector("#tabs .tab", { timeout: 15000 }).catch(() => problems.push("admin: signed in but the dashboard did not appear"));
    await page.waitForTimeout(1500);
    await shot(page, "admin-home");
    await tabs(page, "admin", "#tabs .tab");
  }
  await page.close();
}

await browser.close();
const unique = [...new Set(problems)];
console.log(unique.length ? `\n${unique.length} problem(s):\n- ` + unique.join("\n- ") : "\nno script errors, console errors or failed requests");
process.exit(unique.length ? 1 : 0);
