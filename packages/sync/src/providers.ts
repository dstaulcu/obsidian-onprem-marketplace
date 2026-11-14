import { readToken, type Source } from "./sources";

/**
 * Release listing for each kind of git server, reduced to one shape. Everything here is untrusted text from a remote server:
 * it is only ever parsed, size-checked and compared, never executed.
 */
export interface NormalAsset { name: string; url: string }
export interface NormalRelease { tag: string; draft: boolean; prerelease: boolean; published: string; assets: NormalAsset[] }
export type Fetcher = (url: string, accept?: string) => Promise<Response>;

export class RateLimitError extends Error {}

/** The request for a repository's releases (newest first, as the server returns them). */
export function releasesUrl(s: Source, path: string, perPage: number): string {
  return s.type === "gitlab"
    ? `${s.apiBase}/projects/${encodeURIComponent(path)}/releases?per_page=${perPage}`
    : `${s.apiBase}/repos/${path}/releases?per_page=${perPage}`;
}

interface GhRelease { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; assets?: unknown }
interface GlRelease { tag_name?: unknown; released_at?: unknown; upcoming_release?: unknown; assets?: { links?: unknown } }

const str = (v: unknown) => (typeof v === "string" ? v : "");
const assetList = (v: unknown, pick: (a: Record<string, unknown>) => string): NormalAsset[] =>
  (Array.isArray(v) ? v : []).filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as Record<string, unknown>).name === "string")
    .map((a) => ({ name: a.name as string, url: pick(a) })).filter((a) => a.url);

/** Maps a server's JSON answer to normalized releases. Anything that is not the expected shape throws. */
export function normalizeReleases(s: Source, json: unknown): NormalRelease[] {
  if (!Array.isArray(json)) throw new Error("unexpected answer from the server");
  if (s.type === "gitlab") {
    // GitLab has no drafts; an "upcoming" release plays the part of a pre-release. Asset links are set by the project's owner.
    return (json as GlRelease[]).filter((r) => r && typeof r.tag_name === "string").map((r) => ({
      tag: r.tag_name as string, draft: false, prerelease: r.upcoming_release === true, published: str(r.released_at),
      assets: assetList(r.assets && typeof r.assets === "object" ? (r.assets as { links?: unknown }).links : [], (a) => str(a.direct_asset_url) || str(a.url)),
    }));
  }
  return (json as GhRelease[]).filter((r) => r && typeof r.tag_name === "string").map((r) => ({
    tag: r.tag_name as string, draft: r.draft === true, prerelease: r.prerelease === true, published: str(r.published_at),
    assets: assetList(r.assets, (a) => str(a.url)),
  }));
}

export async function listReleases(f: Fetcher, s: Source, path: string, perPage: number): Promise<NormalRelease[]> {
  const url = releasesUrl(s, path, perPage);
  const r = await f(url);
  if (!r.ok) throwFor(s, url, r);
  return normalizeReleases(s, await r.json());
}

/** Turns a failed response into an error; a rate limit gets its own type so a run can stop early. */
export function throwFor(s: Source, url: string, r: Response): never {
  const remaining = r.headers.get("x-ratelimit-remaining") ?? r.headers.get("ratelimit-remaining");
  if (r.status === 429 || ((r.status === 403) && remaining === "0")) {
    const reset = Number(r.headers.get("x-ratelimit-reset") ?? r.headers.get("ratelimit-reset"));
    const when = reset ? ` (resets ${new Date(reset * 1000).toLocaleTimeString()})` : "";
    throw new RateLimitError(`${s.type === "gitlab" ? "GitLab" : "GitHub"} rate limit reached at ${s.host}${when}; set the token for that source or lower maxVersions, then re-run`);
  }
  throw new Error(`${url} -> ${r.status}`);
}

/**
 * One fetcher for every source. A source's token goes ONLY to that source's own addresses (its API and web origin): a request to
 * any other origin is refused outright, so a release whose asset link points elsewhere (GitLab owners can set any link) can
 * neither receive a token nor make this server fetch from an arbitrary place.
 */
export function makeSourceFetcher(sources: Source[], env: NodeJS.ProcessEnv = process.env): Fetcher {
  const origins = new Map<string, Source>();
  for (const s of sources) { origins.set(new URL(s.apiBase).origin, s); origins.set(new URL(s.webBase).origin, s); }
  return async (url, accept) => {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error(`refusing to fetch ${url}: not a web address`); }
    const s = origins.get(u.origin);
    if (!s) throw new Error(`refusing to fetch from ${u.host}: not a configured git server`);
    const token = await readToken(s, env);
    const base: Record<string, string> = { Accept: accept ?? (s.type === "gitlab" ? "application/json" : "application/vnd.github+json") };
    const withToken = { ...base, ...(token ? (s.type === "gitlab" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }) : {}) };
    // Downloads are often redirected to storage (pre-signed links). Redirects are followed by hand: the token only travels to
    // the source's own origins, and a redirect target must be https (or the source's own scheme).
    let cur = u, hops = 0;
    for (;;) {
      const r = await fetch(cur, { headers: origins.get(cur.origin) === s ? withToken : base, redirect: "manual" });
      if (r.status < 300 || r.status >= 400 || r.status === 304) return r;
      const loc = r.headers.get("location");
      if (!loc || ++hops > 4) throw new Error(`${url} -> too many redirects`);
      const next = new URL(loc, cur);
      if (next.protocol !== "https:" && next.origin !== u.origin) throw new Error(`refusing a redirect to ${next.protocol}//${next.host}`);
      cur = next;
    }
  };
}
