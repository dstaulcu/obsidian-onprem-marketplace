import { readFile } from "node:fs/promises";

/**
 * Where plugin repositories live. The admin lists the git servers it is willing to talk to (a "source": host, type, API address,
 * token); a repository is only ever fetched from one of those. The old single-server config (githubApiBase + tokenEnv) is the
 * default source, so existing configs keep working.
 *
 * A repository is identified by ONE canonical string, produced only by parseRepoRef:
 *   default source      owner/name                       (the form already stored in index.json and repos.json)
 *   any other source    host/owner/name  or  host/group/subgroup/name
 * Every comparison (ownership of a plugin id, duplicates, conflicts) uses key(canonical), so the same repo written two ways, or
 * a/b on two servers, can never be confused.
 */
export type SourceType = "github" | "gitlab";
export interface SourceConfig {
  /** Web address of the server (https://gitlab.example.internal); its host (and port) is the source's name. */
  webBase: string;
  type: SourceType;
  /** API address; default: github https://<web host>/api/v3 (api.github.com for github.com), gitlab https://<web host>/api/v4. */
  apiBase?: string;
  /** Exactly one of these names where the token comes from. Never put the token itself in the config. */
  tokenEnv?: string;
  tokenFile?: string;
}
export interface Source {
  /** host[:port], lowercase: how repositories name this server. */
  host: string;
  type: SourceType;
  apiBase: string;
  webBase: string;
  tokenEnv?: string;
  tokenFile?: string;
  isDefault: boolean;
}
export interface SourcesConfig { githubApiBase: string; tokenEnv?: string; sources?: SourceConfig[] }

const hostOf = (u: URL) => u.host.toLowerCase();

/** The default source from the old fields, followed by any extra ones. Throws on a config that cannot work. */
export function resolveSources(cfg: SourcesConfig, webBaseOverride?: string): Source[] {
  const out: Source[] = [];
  const api = new URL(cfg.githubApiBase);
  const web = webBaseOverride ? new URL(webBaseOverride) : api.hostname === "api.github.com" ? new URL("https://github.com") : new URL(api.origin);
  out.push({ host: hostOf(web), type: "github", apiBase: cfg.githubApiBase.replace(/\/+$/, ""), webBase: web.origin, tokenEnv: cfg.tokenEnv, isDefault: true });
  for (const s of cfg.sources ?? []) {
    const w = new URL(s.webBase);
    if (w.pathname !== "/" || w.username || w.password) throw new Error(`source ${s.webBase}: webBase must be just the server address, like https://git.example.internal`);
    if (s.type !== "github" && s.type !== "gitlab") throw new Error(`source ${s.webBase}: type must be github or gitlab`);
    if ((s.tokenEnv ? 1 : 0) + (s.tokenFile ? 1 : 0) > 1) throw new Error(`source ${s.webBase}: set only one of tokenEnv and tokenFile (never the token itself)`);
    const api = (s.apiBase ?? (s.type === "gitlab" ? `${w.origin}/api/v4` : `${w.origin}/api/v3`)).replace(/\/+$/, "");
    new URL(api);
    if (out.some((o) => o.host === hostOf(w))) throw new Error(`source ${hostOf(w)} is listed twice`);
    out.push({ host: hostOf(w), type: s.type, apiBase: api, webBase: w.origin, tokenEnv: s.tokenEnv, tokenFile: s.tokenFile, isDefault: false });
  }
  return out;
}

export async function readToken(s: Source, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (s.tokenEnv) return env[s.tokenEnv] || undefined;
  if (s.tokenFile) { try { return (await readFile(s.tokenFile, "utf8")).trim() || undefined; } catch { return undefined; } }
  return undefined;
}

export interface RepoRef { source: Source; /** path on that server, original case: owner/name or group/sub/name */ path: string; canonical: string }
export type RepoParse = { ok: true; ref: RepoRef } | { ok: false; reason: string };

/** Identity used for every comparison. */
export const repoKey = (canonical: string) => canonical.toLowerCase();
export const sameRepo = (a: string, b: string) => repoKey(a) === repoKey(b);

const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const MAX_SEGMENTS = 8;
const bad = (reason: string): RepoParse => ({ ok: false, reason });

function build(source: Source, segs: string[]): RepoParse {
  if (segs.length > MAX_SEGMENTS) return bad("that path is too deep to be a repository");
  if (source.type === "github" && segs.length !== 2) return bad("a GitHub repository is owner/name");
  if (segs.length < 2) return bad("a repository is owner/name (GitLab: group/name)");
  if (segs.some((s) => !SEG.test(s) || s === "." || s === ".." || s.endsWith(".lock"))) return bad("that is not a repository name");
  const path = segs.join("/");
  return { ok: true, ref: { source, path, canonical: source.isDefault ? path : `${source.host}/${path}` } };
}

/**
 * Accepts: a bare owner/name (default source); a full URL (https://host/owner/name, with .git, trailing slash, or a page tail like
 * /releases, /tree/main, /-/releases); or host/path. Refuses: credentials in the URL, a host that is not a configured source, a
 * scheme other than the source's own, encoded or dot segments.
 */
export function parseRepoRef(input: unknown, sources: Source[]): RepoParse {
  if (typeof input !== "string") return bad("give the repository as a web address or owner/name");
  let s = input.trim();
  if (!s || s.length > 300) return bad("give the repository as a web address or owner/name");
  if (/[\s\\%]/.test(s) || /[\u0000-\u001f]/.test(s)) return bad("that is not a repository address");
  const def = sources.find((x) => x.isDefault)!;

  const m = /^([A-Za-z][A-Za-z0-9+.-]*):[/][/](.*)$/.exec(s);
  let source: Source | undefined, rest: string, urlish = true;
  if (m) {
    let u: URL;
    try { u = new URL(s); } catch { return bad("that is not a valid web address"); }
    if (u.username || u.password) return bad("the address must not contain a user name or password");
    source = sources.find((x) => x.host === hostOf(u));
    if (!source) return bad(`${hostOf(u)} is not a git server this marketplace is set up to use. Ask the admins to add it.`);
    if (u.protocol !== new URL(source.webBase).protocol) return bad(`use ${new URL(source.webBase).protocol}// for ${source.host}`);
    rest = u.pathname; // query and fragment are dropped
  } else {
    s = s.replace(/[?#].*$/, "");
    const first = s.split("/")[0].toLowerCase();
    const byHost = first.includes(".") || first.includes(":") ? sources.find((x) => x.host === first) : undefined;
    if (byHost) { source = byHost; rest = s.slice(first.length); } else { if (s.split("/").some((x) => x === "")) return bad("that is not a repository name"); source = def; rest = "/" + s; urlish = false; }
  }
  let segs = rest.split("/").filter((x) => x !== "");
  if (source.type === "gitlab") {
    const dash = segs.indexOf("-");
    if (dash >= 0) segs = segs.slice(0, dash); // /-/releases, /-/tree/... are page tails
  } else if (urlish && segs.length > 2) segs = segs.slice(0, 2); // /releases, /tree/main, /issues ...
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/i, "");
  return build(source, segs);
}

/** Canonical strings are what is stored; this is the shape check for reading them back (full validation needs the sources). */
export function isCanonical(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 400) return false;
  const segs = v.split("/");
  if (segs.length < 2 || segs.length > MAX_SEGMENTS + 1) return false;
  return segs.every((x, i) => (i === 0 && x.includes(".") ? /^[A-Za-z0-9.:-]+$/.test(x) : SEG.test(x)) && x !== "." && x !== "..");
}

/** Parse a stored or configured value (bare = default source, host/... = that source). */
export function canonicalOf(stored: string, sources: Source[]): RepoParse { return parseRepoRef(stored, sources); }
