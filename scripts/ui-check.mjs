// Opens the landing page and the admin dashboard in a real browser (the Edge/Chrome already installed; nothing is downloaded), clicks
// through every tab, saves a screenshot of each and fails on any script error, console error or failed request. It does this three times:
// light at desktop width, dark at desktop width, and light at phone width (where it also fails if the page scrolls sideways).
//   npm run ui-check [-- --admin https://localhost:8443 --registry http://localhost:8080 --out ui-check-out --only light]
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
const only = arg("only", "");
for (const u of [adminUrl, registryUrl]) if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(u)) { console.error("refusing a non-local address: " + u); process.exit(2); }
mkdirSync(out, { recursive: true });

const VARIANTS = [
  { name: "light", colorScheme: "light", viewport: { width: 1400, height: 1000 } },
  { name: "dark", colorScheme: "dark", viewport: { width: 1400, height: 1000 } },
  { name: "phone", colorScheme: "light", viewport: { width: 390, height: 844 }, isMobile: true, checkOverflow: true },
].filter((v) => !only || v.name === only);

let creds = null;
try {
  const t = readFileSync(loginFile, "utf8");
  creds = { user: /^user:\s*(.+)$/m.exec(t)?.[1].trim(), password: /^password:\s*(.+)$/m.exec(t)?.[1].trim() };
} catch { /* handled below */ }

const problems = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => problems.push(`${label}: script error: ${e.message}`));
  // "Failed to load resource" console lines carry no address; the response check below reports those with the address.
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) problems.push(`${label}: console error: ${m.text()}`); });
  page.on("requestfailed", (r) => problems.push(`${label}: request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/me$/.test(r.url()) && !/\/favicon\.ico$/.test(r.url())) problems.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
};
const shot = async (page, name) => { await page.screenshot({ path: join(out, name + ".png"), fullPage: true }); };
const overflow = async (page, label, v) => {
  if (!v.checkOverflow) return;
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  if (w.scroll > w.client + 1) problems.push(`${label}: the page scrolls sideways (content ${w.scroll}px wide in a ${w.client}px window)`);
};

async function tabs(page, label, selector, v) {
  const names = await page.$$eval(selector, (els) => els.map((e) => ({ id: e.dataset.tab || e.id, text: e.textContent.trim().replace(/\s+/g, " ") })));
  if (!names.length) problems.push(`${label}: no tabs found`);
  for (const n of names) {
    await page.locator(selector).filter({ hasText: n.text.split(" ")[0] }).first().click();
    await page.waitForTimeout(500);
    await shot(page, `${label}-${(n.id || n.text).toString().replace(/[^A-Za-z0-9_-]/g, "")}`);
    await overflow(page, `${label} ${n.text.split(" ")[0]}`, v);
  }
  return names.length;
}

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
for (const v of VARIANTS) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: v.viewport, colorScheme: v.colorScheme, isMobile: !!v.isMobile, hasTouch: !!v.isMobile });
  // landing page (no login)
  {
    const page = await ctx.newPage(); watch(page, `landing/${v.name}`);
    const r = await page.goto(registryUrl + "/", { waitUntil: "networkidle" });
    await shot(page, `${v.name}-landing-home`);
    const n = await tabs(page, `${v.name}-landing`, '[role="tab"]', v);
    console.log(`${v.name}: landing HTTP ${r?.status()}, ${n} tab(s)`);
    await page.close();
  }
  // admin dashboard (test login)
  {
    const page = await ctx.newPage(); watch(page, `admin/${v.name}`);
    await page.goto(adminUrl + "/", { waitUntil: "networkidle" });
    if (!creds?.user || !creds?.password) { console.log(`${v.name}: no test login found, only the sign-in page was checked`); await shot(page, `${v.name}-admin-signin`); await overflow(page, "admin sign-in", v); }
    else {
      await page.fill("#f-name", creds.user); await page.fill("#f-pass", creds.password);
      await page.click('#loginform button[type="submit"]');
      await page.waitForSelector("#tabs .tab", { timeout: 15000 }).catch(() => problems.push(`admin/${v.name}: signed in but the dashboard did not appear`));
      await page.waitForTimeout(1200);
      await shot(page, `${v.name}-admin-home`);
      const n = await tabs(page, `${v.name}-admin`, "#tabs .tab", v);
      console.log(`${v.name}: admin ${n} tab(s)`);
    }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(`screenshots are in ${out}`);
const unique = [...new Set(problems)];
console.log(unique.length ? `\n${unique.length} problem(s):\n- ` + unique.join("\n- ") : "\nno script errors, console errors, failed requests or sideways scrolling");
process.exit(unique.length ? 1 : 0);
