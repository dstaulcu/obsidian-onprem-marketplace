import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { approveVersion, generateKeys } from "../../sync/src/signing";
import { run } from "../src/run";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const exists = (p: string) => access(p).then(() => true, () => false);
const keys = generateKeys();

/** Builds a signed registry folder with the given plugin versions; `approved` lists the versions to sign. */
async function makeRegistry(id: string, versions: string[], approved: string[], extra: { styles?: string[] } = {}) {
  const out = await mkdtemp(join(tmpdir(), "om-reg-"));
  const entries = [];
  for (const v of versions) {
    const dir = join(out, "plugins", id, v);
    await mkdir(dir, { recursive: true });
    const main = `code-${id}-${v}`, manifest = JSON.stringify({ id, name: id, version: v, minAppVersion: "1.5.0", description: "d", author: "a" });
    await writeFile(join(dir, "main.js"), main);
    await writeFile(join(dir, "manifest.json"), manifest);
    const hasStyles = !!extra.styles?.includes(v);
    if (hasStyles) await writeFile(join(dir, "styles.css"), "css");
    entries.push({ version: v, minAppVersion: "1.5.0", published: "x", hasStyles, sha256: { main: sha(main), manifest: sha(manifest), styles: hasStyles ? sha("css") : "" } });
  }
  entries.sort((a, b) => (a.version < b.version ? 1 : -1));
  await writeFile(join(out, "plugins", id, "versions.json"), JSON.stringify(entries));
  await writeFile(join(out, "index.json"), JSON.stringify([{ id, name: id, author: "a", description: "d", repo: "o/r", latestVersion: entries[0].version, minAppVersion: "1.5.0", isDesktopOnly: false, updated: "x" }]));
  for (const v of approved) await approveVersion(out, id, v, keys.privatePem, "tester", "test fixture");
  return out;
}

async function newVault() {
  const vault = await mkdtemp(join(tmpdir(), "om-vault-"));
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  return vault;
}

async function om(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await run(args, { log: (s) => out.push(s), err: (s) => err.push(s) }, { env: { OM_USER_CONFIG: join(tmpdir(), "om-no-user-config", "config.json"), ...env }, configDir: tmpdir() + "/om-no-config" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const base = (reg: string, vault: string) => ["--registry", reg, "--key", keys.publicSpkiB64, "--vault", vault];

describe("om install", () => {
  it("installs the newest approved version and merges community-plugins.json", async () => {
    const reg = await makeRegistry("demo", ["1.0.0", "1.1.0"], ["1.0.0"]);
    const vault = await newVault();
    await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["zeta", "alpha"]));
    const r = await om(["install", "demo", ...base(reg, vault)]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const m = JSON.parse(await readFile(join(vault, ".obsidian/plugins/demo/manifest.json"), "utf8"));
    expect(m.version).toBe("1.0.0"); // 1.1.0 is not approved
    expect(JSON.parse(await readFile(join(vault, ".obsidian/community-plugins.json"), "utf8"))).toEqual(["zeta", "alpha", "demo"]);
  });

  it("refuses an unapproved pinned version, a wrong key, and a missing key", async () => {
    const reg = await makeRegistry("demo", ["1.0.0", "1.1.0"], ["1.0.0"]);
    const vault = await newVault();
    expect((await om(["install", "demo@1.1.0", ...base(reg, vault)])).code).toBe(1);
    const other = generateKeys();
    expect((await om(["install", "demo", "--registry", reg, "--key", other.publicSpkiB64, "--vault", vault])).code).toBe(1);
    const nokey = await om(["install", "demo", "--registry", reg, "--vault", vault]);
    expect(nokey.code).toBe(1);
    expect(nokey.err).toMatch(/no public key/);
    expect(await exists(join(vault, ".obsidian/plugins/demo"))).toBe(false);
  });

  it("installs unapproved only when --mode off is explicit", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], []);
    const vault = await newVault();
    expect((await om(["install", "demo", "--registry", reg, "--vault", vault])).code).toBe(1);
    const r = await om(["install", "demo", "--registry", reg, "--vault", vault, "--mode", "off"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/NOT approved/);
  });

  it("leaves the vault unchanged when a file does not match its hash", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    await writeFile(join(reg, "plugins/demo/1.0.0/main.js"), "evil"); // tampered after approval
    const vault = await newVault();
    const r = await om(["install", "demo", ...base(reg, vault)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Checksum mismatch/);
    expect(await exists(join(vault, ".obsidian/plugins/demo"))).toBe(false);
    expect(await exists(join(vault, ".obsidian/community-plugins.json"))).toBe(false);
  });

  it("rejects path-like ids and versions and non-vault folders", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const vault = await newVault();
    expect((await om(["install", "../evil", ...base(reg, vault)])).code).toBe(1);
    expect((await om(["install", "demo@../../x", ...base(reg, vault)])).code).toBe(1);
    const notVault = await mkdtemp(join(tmpdir(), "om-novault-"));
    const r = await om(["install", "demo", ...base(reg, notVault)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not look like an Obsidian vault/);
    expect((await om(["install", "demo", ...base(reg, notVault), "--create"])).code).toBe(0);
  });

  it("removes a stale styles.css and keeps data.json on upgrade", async () => {
    const reg = await makeRegistry("demo", ["1.0.0", "1.1.0"], ["1.0.0", "1.1.0"], { styles: ["1.0.0"] });
    const vault = await newVault();
    await om(["install", "demo@1.0.0", ...base(reg, vault)]);
    expect(await exists(join(vault, ".obsidian/plugins/demo/styles.css"))).toBe(true);
    await writeFile(join(vault, ".obsidian/plugins/demo/data.json"), JSON.stringify({ mine: 1 }));
    expect((await om(["install", "demo", ...base(reg, vault)])).code).toBe(0);
    expect(await exists(join(vault, ".obsidian/plugins/demo/styles.css"))).toBe(false);
    expect(JSON.parse(await readFile(join(vault, ".obsidian/plugins/demo/data.json"), "utf8"))).toEqual({ mine: 1 });
  });
});

describe("om config / verify / status / update", () => {
  it("config merges without overwriting unless --force", async () => {
    const vault = await newVault();
    const dir = join(vault, ".obsidian/plugins/demo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data.json"), JSON.stringify({ a: 1, nested: { x: 1 } }));
    const preset = join(vault, "preset.json");
    await writeFile(preset, JSON.stringify({ a: 2, b: 3, nested: { x: 9, y: 2 } }));
    expect((await om(["config", "demo", "--file", preset, "--vault", vault])).code).toBe(0);
    expect(JSON.parse(await readFile(join(dir, "data.json"), "utf8"))).toEqual({ a: 1, b: 3, nested: { x: 1, y: 2 } });
    await om(["config", "demo", "--file", preset, "--vault", vault, "--force"]);
    expect(JSON.parse(await readFile(join(dir, "data.json"), "utf8"))).toEqual({ a: 2, b: 3, nested: { x: 9, y: 2 } });
  });

  it("verify detects a modified file", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const vault = await newVault();
    await om(["install", "demo", ...base(reg, vault)]);
    expect((await om(["verify", ...base(reg, vault)])).code).toBe(0);
    await writeFile(join(vault, ".obsidian/plugins/demo/main.js"), "tampered");
    const r = await om(["verify", ...base(reg, vault), "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).results[0].modified).toEqual(["main.js"]);
  });

  it("status reports updates and update installs only eligible newer versions", async () => {
    const reg = await makeRegistry("demo", ["1.0.0", "1.1.0"], ["1.0.0"]);
    const vault = await newVault();
    await om(["install", "demo@1.0.0", ...base(reg, vault)]);
    expect((await om(["status", ...base(reg, vault)])).out).toMatch(/update available \(1\.1\.0\)/);
    // 1.1.0 is not approved: update must not move to it
    await om(["update", ...base(reg, vault)]);
    expect(JSON.parse(await readFile(join(vault, ".obsidian/plugins/demo/manifest.json"), "utf8")).version).toBe("1.0.0");
    await approveVersion(reg, "demo", "1.1.0", keys.privatePem, "tester", "test fixture");
    expect((await om(["update", ...base(reg, vault)])).code).toBe(0);
    expect(JSON.parse(await readFile(join(vault, ".obsidian/plugins/demo/manifest.json"), "utf8")).version).toBe("1.1.0");
  });
});

describe("om marketplace / list", () => {
  it("installs the marketplace plugin and pins registry, mode and key", async () => {
    const reg = await makeRegistry("onprem-marketplace", ["0.1.1"], ["0.1.1"]);
    const vault = await mkdtemp(join(tmpdir(), "om-fresh-"));
    const r = await om(["marketplace", ...base(reg, vault), "--create"]);
    expect(r.err).toBe("");
    const data = JSON.parse(await readFile(join(vault, ".obsidian/plugins/onprem-marketplace/data.json"), "utf8"));
    expect(data).toMatchObject({ registryUrl: reg, trustMode: "require-signed", publicKey: keys.publicSpkiB64, checkIntervalMinutes: 240 });
    expect(JSON.parse(await readFile(join(vault, ".obsidian/community-plugins.json"), "utf8"))).toEqual(["onprem-marketplace"]);
  });

  it("list shows approval state", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const r = await om(["list", "--registry", reg, "--key", keys.publicSpkiB64]);
    expect(r.out).toMatch(/demo@1\.0\.0 approved/);
  });

  it("reads defaults from environment variables", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const vault = await newVault();
    const r = await om(["install", "demo", "--vault", vault], { OM_REGISTRY: reg, OM_PUBLIC_KEY: keys.publicSpkiB64 });
    expect(r.code).toBe(0);
  });
});

describe("vault discovery", () => {
  async function obsidianCfg(vaults: Record<string, { path: string; open?: boolean }>) {
    const f = join(await mkdtemp(join(tmpdir(), "om-obs-")), "obsidian.json");
    await writeFile(f, JSON.stringify({ vaults }));
    return f;
  }

  it("lists vaults Obsidian knows, flagging missing ones", async () => {
    const a = await newVault();
    const cfg = await obsidianCfg({ aaa111: { path: a, open: true }, bbb222: { path: join(tmpdir(), "om-gone-vault") } });
    const r = await om(["vaults", "--json"], { OM_OBSIDIAN_CONFIG: cfg });
    const res = JSON.parse(r.out).results;
    expect(res).toHaveLength(2);
    expect(res.find((x: { id: string }) => x.id === "aaa111")).toMatchObject({ open: true, exists: true });
    expect(res.find((x: { id: string }) => x.id === "bbb222")).toMatchObject({ exists: false });
  });

  it("resolves --vault by name or id, and refuses ambiguous names", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const a = await newVault();
    const cfg = await obsidianCfg({ aaa111: { path: a } });
    const name = a.split(/[\/]/).pop()!;
    const flags = ["--registry", reg, "--key", keys.publicSpkiB64];
    expect((await om(["install", "demo", ...flags, "--vault", name], { OM_OBSIDIAN_CONFIG: cfg })).code).toBe(0);
    expect(await exists(join(a, ".obsidian/plugins/demo/main.js"))).toBe(true);
    expect((await om(["install", "demo", ...flags, "--vault", "aaa111"], { OM_OBSIDIAN_CONFIG: cfg })).code).toBe(0);

    const dup1 = join(await mkdtemp(join(tmpdir(), "om-d1-")), "Notes"), dup2 = join(await mkdtemp(join(tmpdir(), "om-d2-")), "Notes");
    const cfg2 = await obsidianCfg({ x1: { path: dup1 }, x2: { path: dup2 } });
    const amb = await om(["install", "demo", ...flags, "--vault", "notes"], { OM_OBSIDIAN_CONFIG: cfg2 });
    expect(amb.code).toBe(1);
    expect(amb.err).toMatch(/matches several vaults/);
    const none = await om(["install", "demo", ...flags, "--vault", "nope"], { OM_OBSIDIAN_CONFIG: cfg2 });
    expect(none.err).toMatch(/no vault "nope"/);
  });

  it("uses OM_VAULT as an explicit default and never guesses one", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const a = await newVault();
    const flags = ["--registry", reg, "--key", keys.publicSpkiB64];
    const none = await om(["install", "demo", ...flags]);
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/no vault/);
    expect((await om(["install", "demo", ...flags], { OM_VAULT: a })).code).toBe(0);
  });
});

describe("om init (saved settings) and --all-vaults", () => {
  const userCfg = async () => join(await mkdtemp(join(tmpdir(), "om-ucfg-")), "om", "config.json");
  async function obsidianCfg(paths: string[]) {
    const f = join(await mkdtemp(join(tmpdir(), "om-obs-")), "obsidian.json");
    await writeFile(f, JSON.stringify({ vaults: Object.fromEntries(paths.map((p, i) => ["v" + i, { path: p }])) }));
    return f;
  }

  it("saves settings without touching any vault or the network, and later commands use them", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const vault = await newVault();
    const U = await userCfg();
    const keyFile = join(await mkdtemp(join(tmpdir(), "om-k-")), "public-key.txt");
    await writeFile(keyFile, keys.publicSpkiB64 + "\n");
    const r = await om(["init", "--registry", reg, "--key", keyFile, "--mode", "require-signed", "--vault", vault], { OM_USER_CONFIG: U });
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(U, "utf8"))).toEqual({ registry: reg, publicKey: keys.publicSpkiB64, trustMode: "require-signed", vault });
    expect(await exists(join(vault, ".obsidian/plugins"))).toBe(false);
    const i = await om(["install", "demo"], { OM_USER_CONFIG: U }); // no flags at all
    expect(i.code).toBe(0);
    expect(i.out).toContain(`[${basename(vault)}] installed demo@1.0.0`);
    expect(await exists(join(vault, ".obsidian/plugins/demo/main.js"))).toBe(true);
  });

  it("init fetches and pins the registry's public key when none is given, and never replaces a saved one", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const U = await userCfg();
    const vault = await newVault();
    // no key published yet: settings are saved, the failure is reported
    const none = await om(["init", "--registry", reg, "--vault", vault], { OM_USER_CONFIG: U });
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/could not fetch the public key/);
    expect(JSON.parse(await readFile(U, "utf8")).registry).toBe(reg);
    // a published key is pinned and its fingerprint shown
    await writeFile(join(reg, "public-key.txt"), keys.publicSpkiB64 + "\n");
    const ok = await om(["init", "--registry", reg], { OM_USER_CONFIG: U });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/fingerprint \(SHA-256\): [0-9a-f]{8}( [0-9a-f]{8}){7}/);
    expect(JSON.parse(await readFile(U, "utf8")).publicKey).toBe(keys.publicSpkiB64);
    expect((await om(["install", "demo"], { OM_USER_CONFIG: U })).code).toBe(0); // the pinned key is enough
    // the registry later offers a different key: an existing pin is not replaced...
    const other = generateKeys();
    await writeFile(join(reg, "public-key.txt"), other.publicSpkiB64);
    await om(["init", "--registry", reg], { OM_USER_CONFIG: U });
    expect(JSON.parse(await readFile(U, "utf8")).publicKey).toBe(keys.publicSpkiB64);
    // ...unless the user asks
    await om(["init", "--fetch-key"], { OM_USER_CONFIG: U });
    expect(JSON.parse(await readFile(U, "utf8")).publicKey).toBe(other.publicSpkiB64);
    // junk and oversized answers are refused
    await writeFile(join(reg, "public-key.txt"), "<html>not a key</html>");
    const bad = await om(["init", "--fetch-key"], { OM_USER_CONFIG: U });
    expect(bad.code).toBe(1);
    expect(JSON.parse(await readFile(U, "utf8")).publicKey).toBe(other.publicSpkiB64);
    await writeFile(join(reg, "public-key.txt"), "A".repeat(5000));
    expect((await om(["init", "--fetch-key"], { OM_USER_CONFIG: U })).err).toMatch(/too large/);
  });

  it("fingerprint prints a stable hash of a key", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "om-fp-")), "k.txt");
    await writeFile(f, keys.publicSpkiB64);
    const a = await om(["fingerprint", f, "--json"]);
    expect(JSON.parse(a.out).results[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await om(["fingerprint", f])).out).toBe(a.out ? (await om(["fingerprint", f])).out : "");
    await writeFile(f, "nope");
    expect((await om(["fingerprint", f])).code).toBe(1);
  });

  it("init needs something to save; flags beat saved settings; clear-vault removes the default", async () => {
    const U = await userCfg();
    const e = await om(["init"], { OM_USER_CONFIG: U });
    expect(e.code).toBe(1);
    expect(e.err).toMatch(/nothing to save/);
    expect((await om(["init", "--mode", "bogus"], { OM_USER_CONFIG: U })).code).toBe(1);
    const a = await newVault(), b = await newVault();
    await om(["init", "--vault", a], { OM_USER_CONFIG: U });
    await om(["init", "--registry", "x", "--mode", "off"], { OM_USER_CONFIG: U }); // merges, keeps vault
    expect(JSON.parse(await readFile(U, "utf8"))).toEqual({ vault: a, registry: "x", trustMode: "off" });
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    await om(["install", "demo", ...base(reg, b)], { OM_USER_CONFIG: U }); // --vault beats the saved one
    expect(await exists(join(b, ".obsidian/plugins/demo"))).toBe(true);
    expect(await exists(join(a, ".obsidian/plugins/demo"))).toBe(false);
    await om(["init", "--clear-vault"], { OM_USER_CONFIG: U });
    expect(JSON.parse(await readFile(U, "utf8")).vault).toBeUndefined();
  });

  it("--all-vaults runs on every known vault and keeps going when one fails", async () => {
    const reg = await makeRegistry("demo", ["1.0.0"], ["1.0.0"]);
    const a = await newVault(), b = await newVault();
    const gone = join(tmpdir(), "om-vanished-vault");
    const cfg = await obsidianCfg([a, b, gone]);
    const r = await om(["install", "demo", "--registry", reg, "--key", keys.publicSpkiB64, "--all-vaults"], { OM_OBSIDIAN_CONFIG: cfg });
    expect(r.code).toBe(0); // the vault that no longer exists is skipped, not an error
    for (const v of [a, b]) expect(await exists(join(v, ".obsidian/plugins/demo/main.js"))).toBe(true);
    const s = await om(["status", "--registry", reg, "--key", keys.publicSpkiB64, "--vault", "all", "--json"], { OM_OBSIDIAN_CONFIG: cfg });
    expect(JSON.parse(s.out).results.map((x: { vault: string }) => x.vault).sort()).toEqual([a, b].sort());
    // a bad vault among the targets fails that vault only
    await writeFile(join(b, ".obsidian/plugins/demo/main.js"), "tampered");
    const v = await om(["verify", "--registry", reg, "--key", keys.publicSpkiB64, "--all-vaults"], { OM_OBSIDIAN_CONFIG: cfg });
    expect(v.code).toBe(1);
    expect(v.out).toMatch(/ok/);
    expect(v.err).toMatch(/MODIFIED/);
  });

  it("settings reports saved and effective values", async () => {
    const U = await userCfg();
    await om(["init", "--registry", "http://r", "--mode", "off", "--all-vaults"], { OM_USER_CONFIG: U });
    const r = await om(["settings"], { OM_USER_CONFIG: U, OM_TRUST_MODE: "warn" });
    expect(r.out).toMatch(/default vault: all/);
    expect(r.out).toMatch(/mode: warn/);
  });
});
