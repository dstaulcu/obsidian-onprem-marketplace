import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addEntry, promoteStaged, type PublishPolicy } from "./catalog";
import {
  compareSemver, validateManifest, type IndexEntry, type PluginManifest, type VersionEntry,
} from "@om/shared";

export interface RepoConfig { repo: string; pinVersions?: string[]; /** Mirror only the newest N eligible releases (overrides Config.maxVersions). */ maxVersions?: number; }
export interface ReviewConfig {
  enabled?: boolean;
  /** Full path to the Claude Code executable. */
  claudePath: string;
  model?: string;
  maxBudgetUsd?: number;
  /** Cap on reviews started per run, to bound spend. */
  maxReviewsPerRun?: number;
  /** Path to the signing private key; when set, review records are signed. Never put key material in config. */
  signingKeyPath?: string;
}
export interface Config {
  githubApiBase: string;
  tokenEnv?: string;
  outDir: string;
  /** Default cap on newest releases mirrored per repo; omit for no cap. */
  maxVersions?: number;
  /** Which versions clients can see: all (default), reviewed-pass, or approved. Others are staged until they qualify. */
  publishPolicy?: PublishPolicy;
  /** Optional automated review of newly mirrored versions (needs ANTHROPIC_API_KEY in the environment). */
  review?: ReviewConfig;
  repos: RepoConfig[];
}
interface Asset { name: string; url: string; }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; published_at: string; assets: Asset[]; }

export type Fetcher = (url: string, accept?: string) => Promise<Response>;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const exists = (p: string) => access(p).then(() => true, () => false);

export function makeFetcher(token?: string): Fetcher {
  return (url, accept = "application/vnd.github+json") =>
    fetch(url, { headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

export class RateLimitError extends Error {}
function fail(url: string, r: Response): never {
  if ((r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(r.headers.get("x-ratelimit-reset"));
    const when = reset ? ` (resets ${new Date(reset * 1000).toLocaleTimeString()})` : "";
    throw new RateLimitError(`GitHub rate limit reached${when}; set the token env var or lower maxVersions, then re-run`);
  }
  throw new Error(`${url} -> ${r.status}`);
}

async function getJson<T>(f: Fetcher, url: string): Promise<T> {
  const r = await f(url);
  if (!r.ok) fail(url, r);
  return (await r.json()) as T;
}
async function getBytes(f: Fetcher, url: string): Promise<Uint8Array> {
  const r = await f(url, "application/octet-stream");
  if (!r.ok) fail(url, r);
  return new Uint8Array(await r.arrayBuffer());
}

export interface SyncResult { added: string[]; skipped: string[]; errors: string[]; addedVersions: { id: string; version: string }[]; }

export async function syncRegistry(cfg: Config, f: Fetcher): Promise<SyncResult> {
  const res: SyncResult = { added: [], skipped: [], errors: [], addedVersions: [] };
  const pluginsDir = join(cfg.outDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  const repoOfPlugin: Record<string, string> = {};

  for (const rc of cfg.repos) {
    try {
      const releases = await getJson<Release[]>(f, `${cfg.githubApiBase}/repos/${rc.repo}/releases?per_page=100`);
      const max = rc.maxVersions ?? cfg.maxVersions;
      let taken = 0;
      for (const rel of releases) {
        if (rel.draft || rel.prerelease) continue;
        const tagVer = rel.tag_name.replace(/^v/, "");
        if (rc.pinVersions && !rc.pinVersions.includes(tagVer)) continue;
        if (max && taken++ >= max) break;
        const label = `${rc.repo}@${rel.tag_name}`;
        try {
          const byName = new Map(rel.assets.map((a) => [a.name, a]));
          const mAsset = byName.get("manifest.json");
          const jsAsset = byName.get("main.js");
          if (!mAsset || !jsAsset) throw new Error("release lacks main.js/manifest.json");
          const manifestBytes = await getBytes(f, mAsset.url);
          const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as PluginManifest;
          const errs = validateManifest(manifest);
          if (errs.length) throw new Error(errs.join(", "));
          if (manifest.version !== tagVer) throw new Error(`tag ${rel.tag_name} != manifest version ${manifest.version}`);
          repoOfPlugin[manifest.id] = rc.repo;
          const vdir = join(pluginsDir, manifest.id, manifest.version);
          if (await exists(join(vdir, "manifest.json"))) { res.skipped.push(label); continue; }
          const mainBytes = await getBytes(f, jsAsset.url);
          const sAsset = byName.get("styles.css");
          const stylesBytes = sAsset ? await getBytes(f, sAsset.url) : undefined;
          await mkdir(vdir, { recursive: true });
          await writeFile(join(vdir, "main.js"), mainBytes);
          if (stylesBytes) await writeFile(join(vdir, "styles.css"), stylesBytes);
          // manifest written last: its presence marks the version as complete
          await writeFile(join(vdir, "manifest.json"), manifestBytes);
          const entry: VersionEntry = {
            version: manifest.version, minAppVersion: manifest.minAppVersion, published: rel.published_at,
            sha256: { main: sha(mainBytes), manifest: sha(manifestBytes), styles: stylesBytes ? sha(stylesBytes) : "" },
            hasStyles: !!stylesBytes,
          };
          await addEntry(join(pluginsDir, manifest.id), entry, cfg.publishPolicy ?? "all");
          res.added.push(label);
          res.addedVersions.push({ id: manifest.id, version: manifest.version });
        } catch (e) { if (e instanceof RateLimitError) throw e; res.errors.push(`${label}: ${(e as Error).message}`); }
      }
    } catch (e) {
      res.errors.push(`${rc.repo}: ${(e as Error).message}`);
      if (e instanceof RateLimitError) break; // every later call would fail too
    }
  }
  await rebuildIndex(cfg.outDir, repoOfPlugin);
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
