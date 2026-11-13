import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isValidPluginId } from "@om/shared";

/** The only module that touches a vault on disk. */
const exists = (p: string) => access(p).then(() => true, () => false);
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const cfgDir = (vault: string) => join(vault, ".obsidian");
export const pluginDir = (vault: string, id: string) => {
  if (!isValidPluginId(id)) throw new Error(`Invalid plugin id: ${id}`);
  return join(cfgDir(vault), "plugins", id);
};

export async function ensureVault(vault: string, create: boolean): Promise<void> {
  if (await exists(cfgDir(vault))) return;
  if (!create) throw new Error(`${vault} does not look like an Obsidian vault (no .obsidian folder); pass --create to initialise it`);
  await mkdir(cfgDir(vault), { recursive: true });
}

/**
 * Writes verified plugin files. Files are staged next to the plugin folder first so a failed write never leaves a
 * half-installed plugin; manifest.json is moved in last. data.json is never touched. A styles.css the new version
 * does not ship is removed.
 */
export async function installFiles(vault: string, id: string, files: { name: string; bytes: Uint8Array }[]): Promise<void> {
  const dir = pluginDir(vault, id);
  const stage = join(cfgDir(vault), "plugins", `.om-stage-${id}-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    for (const f of files) await writeFile(join(stage, f.name), f.bytes);
    await mkdir(dir, { recursive: true });
    const order = files.map((f) => f.name).sort((a, b) => Number(a === "manifest.json") - Number(b === "manifest.json"));
    for (const n of order) await rename(join(stage, n), join(dir, n)).catch(async () => { await rm(join(dir, n), { force: true }); await rename(join(stage, n), join(dir, n)); });
    if (!files.some((f) => f.name === "styles.css")) await rm(join(dir, "styles.css"), { force: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Adds the id to community-plugins.json, keeping existing entries and their order. Returns true if it changed. */
export async function addEnabled(vault: string, id: string): Promise<boolean> {
  const p = join(cfgDir(vault), "community-plugins.json");
  const list: unknown = (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : [];
  if (!Array.isArray(list)) throw new Error(`${p} is not a JSON array`);
  if (list.includes(id)) return false;
  await writeFile(p, JSON.stringify([...list, id], null, 2));
  return true;
}

/** Deep merge. Existing keys win unless `force`, in which case the preset wins. Returns the merged object and the changed key paths. */
export function mergeJson(existing: Json, preset: Json, force: boolean, path = ""): { merged: Json; changed: string[] } {
  const merged: Json = { ...existing };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(preset)) {
    const here = path ? `${path}.${k}` : k;
    if (!(k in existing)) { merged[k] = v; changed.push(here); }
    else if (isObj(existing[k]) && isObj(v)) { const r = mergeJson(existing[k] as Json, v, force, here); merged[k] = r.merged; changed.push(...r.changed); }
    else if (force && JSON.stringify(existing[k]) !== JSON.stringify(v)) { merged[k] = v; changed.push(here); }
  }
  return { merged, changed };
}

export async function mergeDataJson(vault: string, id: string, preset: Json, force: boolean): Promise<string[]> {
  const p = join(pluginDir(vault, id), "data.json");
  const existing: unknown = (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : {};
  if (!isObj(existing)) throw new Error(`${p} is not a JSON object`);
  const { merged, changed } = mergeJson(existing, preset, force);
  await mkdir(pluginDir(vault, id), { recursive: true });
  await writeFile(p, JSON.stringify(merged, null, 2));
  return changed;
}

export async function listInstalled(vault: string): Promise<{ id: string; version: string }[]> {
  const root = join(cfgDir(vault), "plugins");
  if (!(await exists(root))) return [];
  const out: { id: string; version: string }[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !isValidPluginId(e.name)) continue;
    try {
      const m = JSON.parse(await readFile(join(root, e.name, "manifest.json"), "utf8"));
      if (typeof m?.version === "string") out.push({ id: e.name, version: m.version });
    } catch { /* not a plugin folder */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readInstalledFile(vault: string, id: string, name: string): Promise<Uint8Array | null> {
  try { return new Uint8Array(await readFile(join(pluginDir(vault, id), name))); } catch { return null; }
}

export interface KnownVault { id: string; name: string; path: string; open: boolean; exists: boolean }

/** Where Obsidian keeps its list of vaults (obsidian.json). OM_OBSIDIAN_CONFIG overrides, mainly for tests. */
export function obsidianConfigPath(env: Record<string, string | undefined>): string {
  if (env.OM_OBSIDIAN_CONFIG) return env.OM_OBSIDIAN_CONFIG;
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (process.platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "obsidian", "obsidian.json");
}

/** Vaults Obsidian has registered (those opened at least once in the desktop app). Empty if Obsidian is not installed. */
export async function discoverVaults(env: Record<string, string | undefined>): Promise<KnownVault[]> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(obsidianConfigPath(env), "utf8")); } catch { return []; }
  const vaults = isObj(raw) && isObj(raw.vaults) ? raw.vaults : {};
  const out: KnownVault[] = [];
  for (const [id, v] of Object.entries(vaults)) {
    if (!isObj(v) || typeof v.path !== "string") continue;
    out.push({ id, name: basename(v.path), path: v.path, open: v.open === true, exists: await exists(v.path) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A vault spec is a path, or the name / id of a vault Obsidian knows. Names must be unambiguous. */
export async function resolveVault(spec: string, env: Record<string, string | undefined>): Promise<string> {
  if (/[\/]/.test(spec) || spec === "." || spec === "..") return resolve(spec);
  const known = await discoverVaults(env);
  const byId = known.filter((v) => v.id === spec);
  const byName = known.filter((v) => v.name.toLowerCase() === spec.toLowerCase());
  const hits = byId.length ? byId : byName;
  if (hits.length === 1) return hits[0].path;
  if (hits.length > 1) throw new Error(`"${spec}" matches several vaults; use the full path or an id:\n${hits.map((v) => `  ${v.id}  ${v.path}`).join("\n")}`);
  if (await exists(spec)) return resolve(spec);
  throw new Error(`no vault "${spec}": pass a path, or run \`om vaults\` to see the vaults Obsidian knows`);
}

/** Per-user saved settings written by `om init` (registry, public key, mode, default vault). OM_USER_CONFIG overrides the location. */
export function userConfigPath(env: Record<string, string | undefined>): string {
  if (env.OM_USER_CONFIG) return env.OM_USER_CONFIG;
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (process.platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "om", "config.json");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "om", "config.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "om", "config.json");
}

export async function readUserConfig(env: Record<string, string | undefined>): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(userConfigPath(env), "utf8"));
    return isObj(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
  } catch { return {}; }
}

export async function writeUserConfig(env: Record<string, string | undefined>, cfg: Record<string, string>): Promise<string> {
  const p = userConfigPath(env);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cfg, null, 2));
  return p;
}
