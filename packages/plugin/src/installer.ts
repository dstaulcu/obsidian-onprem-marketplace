import type { App, PluginManifest } from "obsidian";
import { compareSemver, isValidPluginId, type IndexEntry, type Trust, type VersionEntry } from "@om/shared";
import { registry } from "./registry";

export type { Trust };

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

/** Picks the version to install under the trust policy (newest approved in require-signed mode). */
export const resolveVersion = (base: string, id: string, trust: Trust, version?: string): Promise<{ entry: VersionEntry; approved: boolean }> =>
  registry(base).resolveVersion(id, trust, version);

/** Verdict of the signed review for one version (see RegistryClient.reviewStatus). */
export const reviewStatus = (base: string, id: string, entry: VersionEntry, trust: Trust): Promise<string | null> =>
  registry(base).reviewStatus(id, entry, trust);

export async function install(app: App, base: string, id: string, trust: Trust, version?: string): Promise<{ version: string; approved: boolean }> {
  const { entry: v, approved } = await resolveVersion(base, id, trust, version);

  const files = await registry(base).fetchVerified(id, v);

  const adapter = app.vault.adapter;
  const dir = `${app.vault.configDir}/plugins/${id}`;
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  const wasEnabled = !!mgr(app).plugins[id];
  if (wasEnabled) await mgr(app).disablePluginAndSave(id);
  for (const f of files) await adapter.writeBinary(`${dir}/${f.name}`, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer);
  if (!v.hasStyles && (await adapter.exists(`${dir}/styles.css`))) await adapter.remove(`${dir}/styles.css`);

  await mgr(app).loadManifests();
  await mgr(app).enablePluginAndSave(id);
  return { version: v.version, approved };
}

export async function uninstall(app: App, id: string): Promise<void> {
  if (!isValidPluginId(id)) throw new Error(`Invalid plugin id: ${id}`);
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
