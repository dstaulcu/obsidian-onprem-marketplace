import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest, type PluginManifest } from "@om/shared";
import type { Fetcher } from "./sync";

/**
 * Checking a nominated repository BEFORE it is added to the sync list: does it exist, does it have a usable release, and would
 * sync accept it? This is the same test sync applies (release assets main.js and manifest.json, valid manifest, tag equals the
 * manifest version), run on the newest few releases. It reads only the small manifest; main.js is never downloaded here.
 *
 * Everything that comes back from GitHub is untrusted text, so results are short, plain strings.
 */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;
export const MAX_MANIFEST_BYTES = 100_000;
const CHECKED_RELEASES = 3;

export function isValidRepo(s: unknown): s is string {
  return typeof s === "string" && REPO_RE.test(s) && !s.split("/").some((p) => p === "." || p === "..");
}

export interface ReleaseCheck { tag: string; ok: boolean; pluginId?: string; name?: string; version?: string; problems: string[] }
export interface RepoCheck {
  repo: string;
  ok: boolean;
  /** One line a person can act on. */
  summary: string;
  releases: ReleaseCheck[];
  /** Plugin ids found, and for each whether another repository already provides it (which would be refused). */
  conflicts: string[];
}

interface Asset { name: string; url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] }

const short = (s: unknown, n = 120) => String(s ?? "").replace(/[^\n -~ -￿]/g, "").replace(/\s+/g, " ").slice(0, n);

/** repo of each already-mirrored plugin id, from index.json ({} when there is none). */
export async function mirroredRepos(outDir: string): Promise<Record<string, string>> {
  try {
    const idx = JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as { id?: string; repo?: string }[];
    return Object.fromEntries(idx.filter((e) => typeof e.id === "string" && typeof e.repo === "string" && e.repo).map((e) => [e.id!, e.repo!]));
  } catch { return {}; }
}

export async function checkRepo(apiBase: string, f: Fetcher, repo: string, existing: Record<string, string> = {}): Promise<RepoCheck> {
  const out: RepoCheck = { repo, ok: false, summary: "", releases: [], conflicts: [] };
  if (!isValidRepo(repo)) { out.summary = "That is not a repository name. Use owner/name, for example acme/my-plugin."; return out; }
  let rels: Release[];
  try {
    const r = await f(`${apiBase}/repos/${repo}/releases?per_page=10`);
    if (r.status === 404) { out.summary = "GitHub does not know this repository, or the registry's token cannot see it."; return out; }
    if ((r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0") { out.summary = "GitHub's rate limit is reached; try again later."; return out; }
    if (!r.ok) { out.summary = `GitHub answered HTTP ${r.status}.`; return out; }
    rels = (await r.json()) as Release[];
    if (!Array.isArray(rels)) throw new Error("unexpected answer");
  } catch (e) { out.summary = "Could not reach GitHub: " + short((e as Error).message); return out; }

  const usable = rels.filter((r) => r && !r.draft && !r.prerelease && typeof r.tag_name === "string");
  if (!usable.length) { out.summary = "The repository has no published release (drafts and pre-releases are ignored)."; return out; }

  const ids = new Set<string>();
  for (const rel of usable.slice(0, CHECKED_RELEASES)) {
    const c: ReleaseCheck = { tag: short(rel.tag_name, 60), ok: false, problems: [] };
    out.releases.push(c);
    const byName = new Map((Array.isArray(rel.assets) ? rel.assets : []).map((a) => [a.name, a]));
    const m = byName.get("manifest.json");
    if (!byName.get("main.js")) c.problems.push("no main.js in the release assets");
    if (!m) c.problems.push("no manifest.json in the release assets");
    if (m) {
      try {
        const r = await f(m.url, "application/octet-stream");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("manifest.json is unreasonably large");
        const mf = JSON.parse(Buffer.from(bytes).toString("utf8")) as PluginManifest;
        const errs = validateManifest(mf);
        if (errs.length) c.problems.push(...errs.map((e) => "manifest: " + short(e)));
        else {
          c.pluginId = mf.id; c.name = short(mf.name, 80); c.version = mf.version;
          if (mf.version !== rel.tag_name.replace(/^v/, "")) c.problems.push(`tag ${c.tag} does not match the manifest version ${short(mf.version, 40)}`);
          ids.add(mf.id);
        }
      } catch (e) { c.problems.push("could not read manifest.json: " + short((e as Error).message)); }
    }
    c.ok = c.problems.length === 0;
  }

  // A plugin id belongs to the repository that first provided it. Without this a second repo declaring the same id would
  // add its own versions under that plugin's name.
  for (const id of ids) { const other = existing[id]; if (other && other.toLowerCase() !== repo.toLowerCase()) out.conflicts.push(`${id} is already provided by ${short(other)}`); }

  const good = out.releases.filter((r) => r.ok);
  if (out.conflicts.length) out.summary = "Refused: " + out.conflicts.join("; ") + ".";
  else if (!good.length) out.summary = "No recent release would be accepted by sync: " + short(out.releases[0]?.problems[0] ?? "unknown problem", 160) + ".";
  else {
    out.ok = true;
    const bad = out.releases.length - good.length;
    out.summary = `Looks good: ${good[0].name || good[0].pluginId} (${good[0].pluginId}), latest ${good[0].version}.` + (bad ? ` ${bad} of the ${out.releases.length} newest releases would be skipped by sync.` : "");
  }
  return out;
}
