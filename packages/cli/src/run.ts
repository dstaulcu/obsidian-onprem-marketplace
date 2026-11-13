import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compareSemver, createRegistryClient, isSafeVersion, isValidPluginId, sha256Hex, type RegistryClient, type Trust, type TrustMode } from "@om/shared";
import { transport } from "./transport";
import { addEnabled, discoverVaults, ensureVault, installFiles, listInstalled, mergeDataJson, readInstalledFile, readUserConfig, resolveVault, userConfigPath, writeUserConfig } from "./vault";

export interface Io { log(s: string): void; err(s: string): void }
export interface Env { env: Record<string, string | undefined>; configDir: string }

const HELP = `om - install and verify Obsidian plugins from the on-prem marketplace registry

usage: om <command> [options]
  init         save settings so later commands need fewer flags (no network, no vault changes):
               [--registry <url>] [--key <file|base64>] [--mode <mode>]
               [--vault <path|name> | --all-vaults | --clear-vault]
  settings     show the saved settings and what they resolve to
  vaults       list the vaults Obsidian knows (use a name or id as --vault)
  list         [--registry <url>] [--key <file|base64>]
  install      <id[@version]>... [--vault <path|name> | --all-vaults] [--create]
  marketplace  install the marketplace plugin and point it at this registry, key and mode
  config       <id> --file <preset.json> [--force]
  status | update [id...] | verify [id...]
  (marketplace, config, status, update and verify take the same vault options as install)

<path>   a vault: its folder (the one containing .obsidian), or a name/id shown by "om vaults"
--all-vaults (or --vault all) runs the command on every vault Obsidian knows and keeps going if one fails.
Which vault: --vault/--all-vaults, else env OM_VAULT, else "vault" in om.config.json beside the program,
else the one saved by "om init". Never guessed; every result is prefixed with the vault it ran on.
Settings resolve the same way (flag, env, om.config.json, then the file saved by "om init", shown by
"om settings"; %APPDATA%\om\config.json on Windows).
<url>    registry base URL, or a local registry folder
<key>    pinned public key: a file such as public-key.txt, or the base64 key itself

common: --registry <url> (env OM_REGISTRY)  --key <file|base64> (env OM_PUBLIC_KEY)
        --mode (env OM_TRUST_MODE, default require-signed) - how far to trust the registry:
            require-signed  install only a version whose signed approval verifies against the pinned
                            key and matches the file hashes; installs the newest such version, or fails.
                            Needs --key.
            warn            install the newest version; if it is not approved (or no key is given) still
                            install it but report "NOT approved"
            off             no approval check at all (newest version, reported "NOT approved")
            In every mode the downloaded files must match the sha256 in the registry's versions.json,
            but in warn/off that only detects corruption, not a tampered registry.
        --require-review-pass  also require a passing signed review (with require-signed)
        --json  --config <file> (default om.config.json beside the program)
exit status is non-zero if any step failed.`;

const BOOL = new Set(["json", "force", "create", "require-review-pass", "help", "all-vaults", "clear-vault"]);
interface Args { cmd: string; pos: string[]; flags: Record<string, string | true> }

export function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) flags[k] = true;
    else { const v = rest[++i]; if (v === undefined) throw new Error(`--${k} needs a value`); flags[k] = v; }
  }
  return { cmd, pos, flags };
}

interface Result { id?: string; ok: boolean; message: string; [k: string]: unknown }

export async function run(argv: string[], io: Io, ctx: Env): Promise<number> {
  let args: Args;
  try { args = parseArgs(argv); } catch (e) { io.err((e as Error).message); return 2; }
  const { cmd, pos, flags } = args;
  if (cmd === "help" || flags.help) { io.log(HELP); return 0; }
  const json = flags.json === true;
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

  try {
    const cfgFile = str("config") ?? join(ctx.configDir, "om.config.json");
    let fileCfg: Record<string, string> = {};
    try { fileCfg = JSON.parse(await readFile(cfgFile, "utf8")); } catch (e) { if (str("config")) throw new Error(`cannot read ${cfgFile}: ${(e as Error).message}`); }
    const saved = await readUserConfig(ctx.env); // written by `om init`; om.config.json beside the program overrides it
    const cfg: Record<string, string> = { ...saved, ...fileCfg };

    const registryUrl = str("registry") ?? ctx.env.OM_REGISTRY ?? cfg.registry;
    const keyArg = str("key") ?? ctx.env.OM_PUBLIC_KEY ?? cfg.publicKey ?? "";
    const modeArg = str("mode") ?? ctx.env.OM_TRUST_MODE ?? cfg.trustMode ?? "require-signed";
    if (!["off", "warn", "require-signed"].includes(modeArg)) throw new Error("mode must be off, warn or require-signed");
    const publicKey = await readKey(keyArg);
    const trust: Trust = { mode: modeArg as TrustMode, publicKey, requireReviewPass: flags["require-review-pass"] === true };
    const vaultSpec = flags["all-vaults"] === true ? "all" : (str("vault") ?? ctx.env.OM_VAULT ?? cfg.vault);
    const needVaults = async (): Promise<string[]> => {
      if (!vaultSpec) throw new Error("no vault: pass --vault <path|name> or --all-vaults (see `om vaults`), or save a default with `om init --vault ...`");
      if (vaultSpec.toLowerCase() !== "all") return [await resolveVault(vaultSpec, ctx.env)];
      const all = (await discoverVaults(ctx.env)).filter((k) => k.exists);
      if (!all.length) throw new Error("--all-vaults: Obsidian knows no vaults (open a vault in Obsidian once)");
      return all.map((k) => k.path);
    };
    const client = (): RegistryClient => {
      if (!registryUrl) throw new Error("no registry: pass --registry, set OM_REGISTRY, or add \"registry\" to om.config.json");
      return createRegistryClient(registryUrl, transport);
    };

    const results: Result[] = [];
    const installOne = async (c: RegistryClient, v: string, id: string, version?: string): Promise<Result> => {
      try {
        const pick = await c.resolveVersion(id, trust, version);
        const files = await c.fetchVerified(id, pick.entry);
        await installFiles(v, id, files);
        const added = await addEnabled(v, id);
        return { id, ok: true, message: `installed ${id}@${pick.entry.version}${pick.approved ? " (approved)" : " (NOT approved)"}${added ? ", enabled" : ""}`, version: pick.entry.version, approved: pick.approved };
      } catch (e) { return { id, ok: false, message: `${id}: ${(e as Error).message}` }; }
    };

    /** Runs fn for each target vault (one, or all with --all-vaults). A failure in one vault does not stop the others. */
    const eachVault = async (fn: (v: string) => Promise<void>) => {
      for (const v of await needVaults()) {
        const start = results.length;
        try { await fn(v); } catch (e) { results.push({ ok: false, message: (e as Error).message }); }
        for (let i = start; i < results.length; i++) results[i] = { ...results[i], vault: v, message: `[${basename(v)}] ${results[i].message}` };
      }
    };

    switch (cmd) {
      case "init": {
        // Persists settings only: no network, no vault changes. Values come from flags alone (not env), so nothing ambient is saved.
        const next = { ...saved };
        if (str("registry")) next.registry = str("registry")!;
        if (str("key")) next.publicKey = await readKey(str("key")!);
        if (str("mode")) { if (!["off", "warn", "require-signed"].includes(str("mode")!)) throw new Error("mode must be off, warn or require-signed"); next.trustMode = str("mode")!; }
        if (flags["clear-vault"] === true) delete next.vault;
        else if (flags["all-vaults"] === true || str("vault")?.toLowerCase() === "all") next.vault = "all";
        else if (str("vault")) next.vault = await resolveVault(str("vault")!, ctx.env);
        if (JSON.stringify(next) === JSON.stringify(saved) && !flags["clear-vault"]) throw new Error("nothing to save: pass --registry, --key, --mode and/or --vault <path|name> | --all-vaults (see `om help`)");
        const file = await writeUserConfig(ctx.env, next);
        results.push({ ok: true, message: `saved to ${file}` });
        results.push(...describeSettings(next));
        break;
      }
      case "settings": {
        results.push({ ok: true, message: `saved settings (${userConfigPath(ctx.env)}):` });
        results.push(...describeSettings(saved));
        const eff = [`registry: ${registryUrl ?? "(none)"}`, `mode: ${trust.mode}`, `key: ${publicKey ? "pinned" : "(none)"}`, `vault: ${vaultSpec ?? "(none)"}`];
        results.push({ ok: true, message: `in effect now (flags, env and om.config.json applied): ${eff.join(", ")}` });
        break;
      }
      case "marketplace": {
        const c = client();
        await eachVault(async (v) => {
          await ensureVault(v, flags.create === true);
          const r = await installOne(c, v, "onprem-marketplace");
          if (!r.ok && /404|not in the registry|no such version/i.test(r.message))
            r.message += `\n  This registry does not appear to carry the marketplace plugin. Add "dstaulcu/obsidian-onprem-marketplace" (id onprem-marketplace) to its sync config, then re-run sync (and approve it for require-signed).`;
          results.push(r);
          if (r.ok) {
            await mergeDataJson(v, "onprem-marketplace", { checkIntervalMinutes: 240, hideUnapproved: false, requireReviewPass: trust.requireReviewPass === true }, false);
            await mergeDataJson(v, "onprem-marketplace", { registryUrl: c.base, trustMode: trust.mode, publicKey }, true);
            results.push({ ok: true, message: `configured marketplace: ${c.base}, trust ${trust.mode}${publicKey ? ", key pinned" : ", NO key pinned"}` });
          }
        });
        break;
      }
      case "vaults": {
        const known = await discoverVaults(ctx.env);
        if (!known.length) results.push({ ok: true, message: "no vaults found in the list Obsidian keeps (open a vault in Obsidian once, or pass a path)" });
        for (const k of known) results.push({ ...k, ok: true, message: `${k.name}  ${k.path}${k.open ? "  (open)" : ""}${k.exists ? "" : "  (missing)"}` });
        break;
      }
      case "list": {
        const c = client();
        for (const e of await c.fetchIndex()) {
          let approved: boolean | null = null, review: string | null = null;
          if (trust.mode !== "off") {
            approved = await c.resolveVersion(e.id, trust, e.latestVersion).then((p) => p.approved, () => false);
            const entry = (await c.fetchVersions(e.id).catch(() => [])).find((x) => x.version === e.latestVersion);
            review = entry ? await c.reviewStatus(e.id, entry, trust) : null;
          }
          results.push({ id: e.id, ok: true, message: `${e.id}@${e.latestVersion}${approved === null ? "" : approved ? " approved" : " NOT approved"}${review ? ` review:${review}` : ""} - ${e.name}`, version: e.latestVersion, approved, review });
        }
        break;
      }
      case "install": {
        const c = client();
        if (!pos.length) throw new Error("usage: om install <id[@version]>... [--vault <path|name> | --all-vaults]");
        await eachVault(async (v) => {
          await ensureVault(v, flags.create === true);
          for (const spec of pos) {
            const [id, version] = spec.split("@");
            if (!isValidPluginId(id) || (version !== undefined && !isSafeVersion(version))) { results.push({ ok: false, message: `invalid spec: ${spec}` }); continue; }
            results.push(await installOne(c, v, id, version));
          }
        });
        break;
      }
      case "config": {
        const [id] = pos, file = str("file");
        if (!id || !file) throw new Error("usage: om config <id> --file preset.json [--vault <path|name> | --all-vaults] [--force]");
        const preset = JSON.parse(await readFile(file, "utf8"));
        if (typeof preset !== "object" || preset === null || Array.isArray(preset)) throw new Error(`${file} must contain a JSON object`);
        await eachVault(async (v) => {
          const changed = await mergeDataJson(v, id, preset, flags.force === true);
          results.push({ id, ok: true, message: `${id}: ${changed.length ? `set ${changed.join(", ")}` : "no changes"}`, changed });
        });
        break;
      }
      case "status": {
        const c = client();
        const idx = new Map((await c.fetchIndex()).map((e) => [e.id, e.latestVersion]));
        await eachVault(async (v) => {
          for (const p of await listInstalled(v)) {
            const latest = idx.get(p.id);
            const state = latest === undefined ? "not in registry" : compareSemver(latest, p.version) > 0 ? `update available (${latest})` : "up to date";
            results.push({ id: p.id, ok: true, message: `${p.id}@${p.version}: ${state}`, version: p.version, latest: latest ?? null, state });
          }
        });
        break;
      }
      case "update": {
        const c = client();
        const idx = new Map((await c.fetchIndex()).map((e) => [e.id, e.latestVersion]));
        await eachVault(async (v) => {
          for (const p of (await listInstalled(v)).filter((x) => !pos.length || pos.includes(x.id))) {
            const latest = idx.get(p.id);
            if (latest === undefined || compareSemver(latest, p.version) <= 0) { results.push({ id: p.id, ok: true, message: `${p.id}@${p.version}: up to date` }); continue; }
            // resolve the newest *eligible* version; only install it if it is actually newer than what is installed
            try {
              const pick = await c.resolveVersion(p.id, trust);
              if (compareSemver(pick.entry.version, p.version) <= 0) { results.push({ id: p.id, ok: true, message: `${p.id}@${p.version}: no newer eligible version` }); continue; }
            } catch (e) { results.push({ id: p.id, ok: false, message: `${p.id}: ${(e as Error).message}` }); continue; }
            results.push(await installOne(c, v, p.id));
          }
        });
        break;
      }
      case "verify": {
        const c = client();
        await eachVault(async (v) => {
          for (const p of (await listInstalled(v)).filter((x) => !pos.length || pos.includes(x.id))) {
            const entry = (await c.fetchVersions(p.id).catch(() => [])).find((x) => x.version === p.version);
            if (!entry) { results.push({ id: p.id, ok: false, message: `${p.id}@${p.version}: version not in registry` }); continue; }
            const bad: string[] = [];
            for (const [name, want] of [["main.js", entry.sha256.main], ["manifest.json", entry.sha256.manifest], ["styles.css", entry.hasStyles ? entry.sha256.styles : ""]] as const) {
              const bytes = await readInstalledFile(v, p.id, name);
              const got = bytes ? await sha256Hex(bytes as BufferSource) : "";
              if (got !== want) bad.push(name);
            }
            results.push(bad.length ? { id: p.id, ok: false, message: `${p.id}@${p.version}: MODIFIED (${bad.join(", ")})`, modified: bad } : { id: p.id, ok: true, message: `${p.id}@${p.version}: ok` });
          }
        });
        break;
      }
      default:
        io.err(`unknown command: ${cmd}`);
        io.log(HELP);
        return 2;
    }

    const ok = results.every((r) => r.ok);
    if (json) io.log(JSON.stringify({ ok, results }, null, 2));
    else for (const r of results) (r.ok ? io.log : io.err)((r.ok ? "" : "FAILED ") + r.message);
    return ok ? 0 : 1;
  } catch (e) {
    if (json) io.log(JSON.stringify({ ok: false, results: [{ ok: false, message: (e as Error).message }] }, null, 2));
    else io.err((e as Error).message);
    return 1;
  }
}

function describeSettings(c: Record<string, string>): Result[] {
  const rows = [`registry: ${c.registry ?? "(not set)"}`, `mode: ${c.trustMode ?? "(not set; default require-signed)"}`,
    `key: ${c.publicKey ? `pinned (${c.publicKey.slice(0, 12)}...)` : "(not set)"}`, `default vault: ${c.vault ?? "(not set)"}`];
  return rows.map((message) => ({ ok: true, message: `  ${message}` }));
}

/** A key argument is a path to a file holding the base64 SPKI key, or the key itself. */
async function readKey(arg: string): Promise<string> {
  if (!arg) return "";
  try { return (await readFile(arg, "utf8")).trim(); } catch { return arg.trim(); }
}
