import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest, type PluginManifest } from "@om/shared";
import type { Fetcher, NormalRelease } from "./providers";
import { listReleases, throwFor, RateLimitError } from "./providers";
import { parseRepoRef, sameRepo, type Source } from "./sources";

/**
 * Checking a nominated repository BEFORE it is added to the sync list: does it exist, does it have a usable release, and would
 * sync accept it? This is the same test sync applies (release assets main.js and manifest.json, valid manifest, tag equals the
 * manifest version), run on the newest few releases. It reads only the small manifest; main.js is never downloaded here.
 *
 * Everything that comes back from GitHub is untrusted text, so results are short, plain strings.
 */
export const MAX_MANIFEST_BYTES = 100_000;
const CHECKED_RELEASES = 3;

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


const short = (s: unknown, n = 120) => String(s ?? "").replace(/[^\n -~ -￿]/g, "").replace(/\s+/g, " ").slice(0, n);

/** repo of each already-mirrored plugin id, from index.json ({} when there is none). */
export async function mirroredRepos(outDir: string): Promise<Record<string, string>> {
  try {
    const idx = JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as { id?: string; repo?: string }[];
    return Object.fromEntries(idx.filter((e) => typeof e.id === "string" && typeof e.repo === "string" && e.repo).map((e) => [e.id!, e.repo!]));
  } catch { return {}; }
}

export async function checkRepo(sources: Source[], f: Fetcher, input: string, existing: Record<string, string> = {}): Promise<RepoCheck> {
  const out: RepoCheck = { repo: String(input ?? "").slice(0, 200), ok: false, summary: "", releases: [], conflicts: [] };
  const parsed = parseRepoRef(input, sources);
  if (!parsed.ok) { out.summary = parsed.reason; return out; }
  const { source, path, canonical: repo } = parsed.ref;
  out.repo = repo;
  let rels: NormalRelease[];
  try { rels = await listReleases(f, source, path, 10); }
  catch (e) {
    if (e instanceof RateLimitError) { out.summary = "The git server's rate limit is reached; try again later."; return out; }
    const m = /-> ([0-9]{3})$/.exec((e as Error).message);
    out.summary = m ? (m[1] === "404" ? `${source.host} does not know this repository, or the marketplace's token for it cannot see it.` : `${source.host} answered HTTP ${m[1]}.`) : `Could not read the releases from ${source.host}: ` + short((e as Error).message);
    return out;
  }

  const usable = rels.filter((r) => !r.draft && !r.prerelease);
  if (!usable.length) { out.summary = "The repository has no published release (drafts and pre-releases are ignored)."; return out; }

  const ids = new Set<string>();
  for (const rel of usable.slice(0, CHECKED_RELEASES)) {
    const c: ReleaseCheck = { tag: short(rel.tag, 60), ok: false, problems: [] };
    out.releases.push(c);
    const byName = new Map(rel.assets.map((a) => [a.name, a]));
    const m = byName.get("manifest.json");
    if (!byName.get("main.js")) c.problems.push("no main.js in the release assets");
    if (!m) c.problems.push("no manifest.json in the release assets");
    if (m) {
      try {
        const r = await f(m.url, "application/octet-stream");
        if (!r.ok) throwFor(source, m.url, r);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("manifest.json is unreasonably large");
        const mf = JSON.parse(Buffer.from(bytes).toString("utf8")) as PluginManifest;
        const errs = validateManifest(mf);
        if (errs.length) c.problems.push(...errs.map((e) => "manifest: " + short(e)));
        else {
          c.pluginId = mf.id; c.name = short(mf.name, 80); c.version = mf.version;
          if (mf.version !== rel.tag.replace(/^v/, "")) c.problems.push(`tag ${c.tag} does not match the manifest version ${short(mf.version, 40)}`);
          ids.add(mf.id);
        }
      } catch (e) { c.problems.push("could not read manifest.json: " + short((e as Error).message)); }
    }
    c.ok = c.problems.length === 0;
  }

  // A plugin id belongs to the repository that first provided it. Without this a second repo declaring the same id would
  // add its own versions under that plugin's name.
  for (const id of ids) { const other = existing[id]; if (other && !sameRepo(other, repo)) out.conflicts.push(`${id} is already provided by ${short(other)}`); }

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
