import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config, RepoConfig } from "@om/sync/src/sync";
import { isCanonical, parseRepoRef, resolveSources, sameRepo } from "@om/sync/src/sources";

/**
 * Repositories added from the dashboard. They live in the admin's own state folder and are merged with the hand-edited
 * `repos` list in registry.config.json when a sync runs; the admin never writes to registry.config.json. Adding a repository
 * only lets sync MIRROR its releases. Nothing becomes installable until a version is reviewed and approved.
 */
export interface NominatedRepo { repo: string; addedBy: string; addedAt: string; note?: string }
export const MAX_REPOS = 200;
export class RepoError extends Error {}

const clean = (s: string) => s.replace(/[^\n -~ -￿]/g, "").replace(/\s+/g, " ").trim();

export class RepoStore {
  constructor(private readonly file: string) {}

  async list(): Promise<NominatedRepo[]> {
    try {
      const v = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(v)) return [];
      return v.filter((e): e is NominatedRepo => e && isCanonical(e.repo) && typeof e.addedBy === "string" && typeof e.addedAt === "string").slice(0, MAX_REPOS);
    } catch { return []; }
  }

  private async save(items: NominatedRepo[]) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /**
   * `repo` is the CANONICAL name (from parseRepoRef: owner/name, or host/path for another server); the caller has already
   * checked it against the configured servers. `configured` are the repositories already in registry.config.json.
   */
  async add(by: string, repo: unknown, configured: string[], note?: unknown): Promise<NominatedRepo> {
    if (!isCanonical(repo)) throw new RepoError("that is not a repository name");
    const items = await this.list();
    const same = (a: string) => sameRepo(a, repo as string);
    if (configured.some(same) || items.some((i) => same(i.repo))) throw new RepoError("that repository is already on the sync list");
    if (items.length >= MAX_REPOS) throw new RepoError("too many repositories were added from the dashboard; edit registry.config.json instead");
    let n: string | undefined;
    if (note !== undefined && note !== null && note !== "") { if (typeof note !== "string") throw new RepoError("the note must be text"); n = clean(note).slice(0, 200) || undefined; }
    const e: NominatedRepo = { repo, addedBy: clean(by).slice(0, 64), addedAt: new Date().toISOString(), ...(n ? { note: n } : {}) };
    await this.save([...items, e]);
    return e;
  }

  async remove(repo: unknown): Promise<boolean> {
    if (!isCanonical(repo)) throw new RepoError("that is not a repository name");
    const items = await this.list();
    const rest = items.filter((i) => !sameRepo(i.repo, repo));
    if (rest.length === items.length) return false;
    await this.save(rest);
    return true;
  }
}

/** The configured repositories plus the ones added from the dashboard (config wins on duplicates). */
export async function withNominated(rc: Config, store: RepoStore | undefined): Promise<Config> {
  if (!store) return rc;
  // Compare by canonical name, so a hand-written web address in the config and the same repository added from the dashboard are one.
  const sources = resolveSources(rc);
  const canon = (r: string) => { const p = parseRepoRef(r, sources); return p.ok ? p.ref.canonical : r; };
  const have = rc.repos.map((r) => canon(r.repo));
  const extra: RepoConfig[] = (await store.list()).filter((n) => !have.some((h) => sameRepo(h, n.repo))).map((n) => ({ repo: n.repo }));
  return extra.length ? { ...rc, repos: [...rc.repos, ...extra] } : rc;
}
