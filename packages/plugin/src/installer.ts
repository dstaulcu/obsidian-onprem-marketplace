import type { App, PluginManifest } from "obsidian";
import { checkReview, compareSemver, isValidPluginId, selectVersion, type IndexEntry, type TrustMode, type VersionEntry } from "@om/shared";
import { fetchFile, fetchSigned, fetchVersions, sha256Hex } from "./registry";

export interface Trust { mode: TrustMode; publicKey: string; requireReviewPass?: boolean }

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
export async function resolveVersion(base: string, id: string, trust: Trust, version?: string): Promise<{ entry: VersionEntry; approved: boolean }> {
  if (!isValidPluginId(id)) throw new Error(`Invalid plugin id: ${id}`);
  const versions = (await fetchVersions(base, id)).sort((a, b) => compareSemver(b.version, a.version));
  const { pick, reason } = await selectVersion(id, versions, trust.mode, trust.publicKey, (ver) => fetchSigned(base, id, ver, "approval.json"), version,
    { requireReviewPass: trust.requireReviewPass, getReview: (ver) => fetchSigned(base, id, ver, "review.json") });
  if (!pick) throw new Error(`No installable version of ${id}: ${reason ?? "none"}`);
  return pick;
}

/** Verdict of the signed review for one version: "pass" | "findings" | "fail" | "error", "invalid" if the record does not verify, null if none. */
export async function reviewStatus(base: string, id: string, entry: VersionEntry, trust: Trust): Promise<string | null> {
  const s = await fetchSigned(base, id, entry.version, "review.json");
  if (!s) return null;
  if (!trust.publicKey) return "unverified";
  const r = await checkReview(s.bytes, s.sig, trust.publicKey, { id, version: entry.version, actual: entry.sha256 });
  return r.ok ? r.record.review.verdict : "invalid";
}

export async function install(app: App, base: string, id: string, trust: Trust, version?: string): Promise<{ version: string; approved: boolean }> {
  const { entry: v, approved } = await resolveVersion(base, id, trust, version);

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
