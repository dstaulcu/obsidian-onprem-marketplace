import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addEntry, promoteStaged, type PublishPolicy } from "./catalog";
import type { ProviderConfig } from "./reviewers";
import { listReleases, RateLimitError, throwFor, type Fetcher, type NormalRelease } from "./providers";
import { parseRepoRef, resolveSources, sameRepo, type Source, type SourceConfig } from "./sources";
import {
  compareSemver, validateManifest, type IndexEntry, type PluginManifest, type VersionEntry,
} from "@om/shared";

export interface RepoConfig { /** owner/name on the default server, or a full web address / host/path for a configured source (see sources.ts). */ repo: string; pinVersions?: string[]; /** Mirror only the newest N eligible releases (overrides Config.maxVersions). */ maxVersions?: number; }
export interface ReviewConfig extends ProviderConfig {
  enabled?: boolean;
  /** provider "claude-code": full path to the Claude Code executable. */
  claudePath?: string;
  /** Folder holding rules.json and review-prompt.md (default "rubric"). An org can point this at its own rubric. */
  rubricDir?: string;
  /** Cap on reviews started per run, to bound spend. */
  maxReviewsPerRun?: number;
  /** Path to the signing private key; when set, review records are signed. Never put key material in config. */
  signingKeyPath?: string;
}
export interface Config {
  /** The default git server (GitHub or GitHub Enterprise). Other servers, including GitLab, go in `sources`. */
  githubApiBase: string;
  tokenEnv?: string;
  /** Extra git servers repositories may come from; only these hosts are ever contacted. */
  sources?: SourceConfig[];
  outDir: string;
  /** Default cap on newest releases mirrored per repo; omit for no cap. */
  maxVersions?: number;
  /** Which versions clients can see: all (default), reviewed-pass, or approved. Others are staged until they qualify. */
  publishPolicy?: PublishPolicy;
  /** Optional automated review of newly mirrored versions (needs ANTHROPIC_API_KEY in the environment). */
  review?: ReviewConfig;
  repos: RepoConfig[];
}
export type { Fetcher };
export { RateLimitError };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const exists = (p: string) => access(p).then(() => true, () => false);

export function makeFetcher(token?: string): Fetcher {
  return (url, accept = "application/vnd.github+json") =>
    fetch(url, { headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

async function getBytes(f: Fetcher, url: string, src: Source): Promise<Uint8Array> {
  const r = await f(url, "application/octet-stream");
  if (!r.ok) throwFor(src, url, r);
  return new Uint8Array(await r.arrayBuffer());
}

export interface SyncResult { added: string[]; skipped: string[]; errors: string[]; addedVersions: { id: string; version: string }[]; }

/** `log` receives a human-readable trace (what was checked, added, already present, left out) for the admin job view. */
export async function syncRegistry(cfg: Config, f: Fetcher, log: (line: string) => void = () => {}): Promise<SyncResult> {
  const res: SyncResult = { added: [], skipped: [], errors: [], addedVersions: [] };
  const pluginsDir = join(cfg.outDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  const repoOfPlugin: Record<string, string> = {};
  // A plugin id belongs to the repository that first provided it. Another repository declaring the same id is refused, so it cannot
  // add its own versions under that plugin's name.
  let owners: Record<string, string> = {};
  try { owners = Object.fromEntries((JSON.parse(await readFile(join(cfg.outDir, "index.json"), "utf8")) as IndexEntry[]).filter((e) => e.repo).map((e) => [e.id, e.repo])); } catch { /* no index yet */ }

  const sources = resolveSources(cfg);
  for (const rc0 of cfg.repos) {
    const parsed = parseRepoRef(rc0.repo, sources);
    if (!parsed.ok) { res.errors.push(`${rc0.repo}: ${parsed.reason}`); continue; }
    const rc = { ...rc0, repo: parsed.ref.canonical }, src = parsed.ref.source;
    try {
      const releases: NormalRelease[] = await listReleases(f, src, parsed.ref.path, 100);
      const max = rc.maxVersions ?? cfg.maxVersions;
      let taken = 0;
      const ignored = releases.filter((r) => r.draft || r.prerelease).length;
      log(`${rc.repo}: ${releases.length} release(s) on ${src.type === "gitlab" ? "GitLab" : "GitHub"}` + (ignored ? `, ${ignored} pre-release/draft ignored` : "") + (max ? `, newest ${max} considered` : ""));
      for (const rel of releases) {
        if (rel.draft || rel.prerelease) continue;
        const tagVer = rel.tag.replace(/^v/, "");
        if (rc.pinVersions && !rc.pinVersions.includes(tagVer)) { log(`  - ${rel.tag}: not in pinVersions, left out`); continue; }
        if (max && taken++ >= max) { log(`  - older releases from ${rel.tag} on are beyond maxVersions (${max}), left out`); break; }
        const label = `${rc.repo}@${rel.tag}`;
        try {
          const byName = new Map(rel.assets.map((a) => [a.name, a]));
          const mAsset = byName.get("manifest.json");
          const jsAsset = byName.get("main.js");
          if (!mAsset || !jsAsset) throw new Error("release lacks main.js/manifest.json");
          const manifestBytes = await getBytes(f, mAsset.url, src);
          const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as PluginManifest;
          const errs = validateManifest(manifest);
          if (errs.length) throw new Error(errs.join(", "));
          if (manifest.version !== tagVer) throw new Error(`tag ${rel.tag} != manifest version ${manifest.version}`);
          const owner = repoOfPlugin[manifest.id] ?? owners[manifest.id];
          if (owner && !sameRepo(owner, rc.repo)) throw new Error(`plugin id "${manifest.id}" is already provided by ${owner}; not mixing in versions from ${rc.repo}`);
          repoOfPlugin[manifest.id] = rc.repo;
          const vdir = join(pluginsDir, manifest.id, manifest.version);
          if (await exists(join(vdir, "manifest.json"))) { res.skipped.push(label); log(`  = ${manifest.id}@${manifest.version}: already mirrored`); continue; }
          const mainBytes = await getBytes(f, jsAsset.url, src);
          const sAsset = byName.get("styles.css");
          const stylesBytes = sAsset ? await getBytes(f, sAsset.url, src) : undefined;
          await mkdir(vdir, { recursive: true });
          await writeFile(join(vdir, "main.js"), mainBytes);
          if (stylesBytes) await writeFile(join(vdir, "styles.css"), stylesBytes);
          // manifest written last: its presence marks the version as complete
          await writeFile(join(vdir, "manifest.json"), manifestBytes);
          const entry: VersionEntry = {
            version: manifest.version, minAppVersion: manifest.minAppVersion, published: rel.published,
            sha256: { main: sha(mainBytes), manifest: sha(manifestBytes), styles: stylesBytes ? sha(stylesBytes) : "" },
            hasStyles: !!stylesBytes,
          };
          await addEntry(join(pluginsDir, manifest.id), entry, cfg.publishPolicy ?? "all");
          res.added.push(label);
          log(`  + ${manifest.id}@${manifest.version}: downloaded main.js (${(mainBytes.length / 1024).toFixed(1)} KB)` + (stylesBytes ? ", styles.css" : "") + ", manifest.json; hashes recorded");
          res.addedVersions.push({ id: manifest.id, version: manifest.version });
        } catch (e) { if (e instanceof RateLimitError) throw e; res.errors.push(`${label}: ${(e as Error).message}`); log(`  ! ${label}: ${(e as Error).message}`); }
      }
    } catch (e) {
      res.errors.push(`${rc.repo}: ${(e as Error).message}`);
      if (e instanceof RateLimitError) break; // every later call would fail too
    }
  }
  await rebuildIndex(cfg.outDir, repoOfPlugin);
  try { log(`index.json rebuilt: ${(JSON.parse(await readFile(join(cfg.outDir, "index.json"), "utf8")) as unknown[]).length} plugin(s) listed`); } catch { /* summary only */ }
  return res;
}

/** Rebuilds index.json from everything on disk so unchanged plugins persist across runs. */
export async function rebuildIndex(outDir: string, repoHints: Record<string, string>) {
  const pluginsDir = join(outDir, "plugins");
  const idxPath = join(outDir, "index.json");
  const old: IndexEntry[] = (await exists(idxPath)) ? JSON.parse(await readFile(idxPath, "utf8")) : [];
  const oldRepo = Object.fromEntries(old.map((e) => [e.id, e.repo]));
  const entries: IndexEntry[] = [];
  for (const id of await readdir(pluginsDir)) {
    const vpath = join(pluginsDir, id, "versions.json");
    if (!(await exists(vpath))) continue;
    const versions: VersionEntry[] = JSON.parse(await readFile(vpath, "utf8"));
    const latest = versions[0];
    if (!latest) continue; // every version is held back: the plugin is not listed
    const m: PluginManifest = JSON.parse(await readFile(join(pluginsDir, id, latest.version, "manifest.json"), "utf8"));
    entries.push({
      id, name: m.name, author: m.author, description: m.description,
      repo: repoHints[id] ?? oldRepo[id] ?? "", latestVersion: latest.version,
      minAppVersion: latest.minAppVersion, isDesktopOnly: !!m.isDesktopOnly, updated: latest.published,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(idxPath, JSON.stringify(entries, null, 2));
}
