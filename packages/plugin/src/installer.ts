import type { App, PluginManifest } from "obsidian";
import { compareSemver, type IndexEntry } from "@om/shared";
import { fetchFile, fetchVersions, sha256Hex } from "./registry";

/**
 * All use of Obsidian's undocumented plugin-manager internals (app.plugins) is confined here,
 * so a change in a future Obsidian version only needs fixing in one file.
 */
interface PluginManager {
  manifests: Record<string, PluginManifest>;
  plugins: Record<string, unknown>;
  loadManifests(): Promise<void>;
  enablePluginAndSave(id: string): Promise<boolean>;
  disablePluginAndSave(id: string): Promise<boolean>;
}
const mgr = (app: App) => (app as unknown as { plugins: PluginManager }).plugins;

export function installedVersion(app: App, id: string): string | null {
  return mgr(app).manifests[id]?.version ?? null;
}

export function isCompatible(entry: IndexEntry, appVersion: string, isMobile: boolean): string | null {
  if (compareSemver(appVersion, entry.minAppVersion) < 0) return `requires Obsidian ${entry.minAppVersion}+`;
  if (entry.isDesktopOnly && isMobile) return "desktop only";
  return null;
}

export async function install(app: App, base: string, id: string, version?: string): Promise<string> {
  const versions = await fetchVersions(base, id);
  const v = version ? versions.find((x) => x.version === version) : versions[0];
  if (!v) throw new Error(`No such version for ${id}`);

  const files: [string, string, ArrayBuffer][] = [];
  const names: [string, string, string][] = [["main.js", "main", v.sha256.main], ["manifest.json", "manifest", v.sha256.manifest]];
  if (v.hasStyles) names.push(["styles.css", "styles", v.sha256.styles]);
  for (const [file, , expected] of names) {
    const buf = await fetchFile(base, id, v.version, file);
    if ((await sha256Hex(buf)) !== expected) throw new Error(`Checksum mismatch for ${id}/${file}; refusing to install`);
    files.push([file, expected, buf]);
  }

  const adapter = app.vault.adapter;
  const dir = `${app.vault.configDir}/plugins/${id}`;
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  const wasEnabled = !!mgr(app).plugins[id];
  if (wasEnabled) await mgr(app).disablePluginAndSave(id);
  for (const [file, , buf] of files) await adapter.writeBinary(`${dir}/${file}`, buf);
  if (!v.hasStyles && (await adapter.exists(`${dir}/styles.css`))) await adapter.remove(`${dir}/styles.css`);

  await mgr(app).loadManifests();
  await mgr(app).enablePluginAndSave(id);
  return v.version;
}

export async function uninstall(app: App, id: string): Promise<void> {
  await mgr(app).disablePluginAndSave(id);
  await app.vault.adapter.rmdir(`${app.vault.configDir}/plugins/${id}`, true);
  await mgr(app).loadManifests();
}

export function updatesAvailable(app: App, index: IndexEntry[]): IndexEntry[] {
  return index.filter((e) => {
    const cur = installedVersion(app, e.id);
    return cur !== null && compareSemver(e.latestVersion, cur) > 0;
  });
}
