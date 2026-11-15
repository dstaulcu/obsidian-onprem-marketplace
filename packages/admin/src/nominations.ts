import { readFile } from "node:fs/promises";

/**
 * Plugin nominations are issues on a tracker (the one the landing page's "Nominate a plugin" link opens). This reads the open ones
 * labelled "nomination", and after an admin acts on one it posts a fixed comment and closes it. It never adds a repository by itself:
 * the admin clicks, and the repository still has to pass the same checks as one typed into the Repositories tab.
 *
 * Everything that comes back from the tracker was written by whoever filed the issue, so it is untrusted text: shortened, stripped
 * of control characters, shown as text only. The only thing taken from it is the repository address, which is re-parsed and
 * re-checked before it is used. The token is a dedicated one (Issues: read and write on the tracker repository only) and comes from an
 * environment variable or a file, never from the config.
 */
export interface NominationsConfig {
  /** owner/name of the tracker repository, e.g. dstaulcu/obsidian-onprem-marketplace. */
  repo: string;
  /** API address of the server hosting it. Default https://api.github.com. */
  apiBase?: string;
  /** Label that marks a nomination. Default "nomination". */
  label?: string;
  /** Exactly one of these names where the token comes from. A public tracker can be READ without one, but closing needs it. */
  tokenEnv?: string;
  tokenFile?: string;
}
export interface Nomination {
  number: number;
  title: string;
  by: string;
  createdAt: string;
  /** The repository address the issue form carries ("Plugin repository"), as written. Not trusted. */
  candidate: string;
  why: string;
}
export type IssueFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

const REPO = /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/;
export const NOMINATION_LABEL = "nomination";

export function validateNominations(c: NominationsConfig | undefined): string[] {
  if (c === undefined) return [];
  const e: string[] = [];
  if (!c || typeof c.repo !== "string" || !REPO.test(c.repo)) e.push("nominations.repo must look like owner/name");
  if (c.apiBase !== undefined && !/^https?:[/][/][^\s?#]+$/.test(c.apiBase)) e.push("nominations.apiBase must be an http(s) address");
  if (c.label !== undefined && !/^[A-Za-z0-9 _.-]{1,50}$/.test(c.label)) e.push("nominations.label is not a plain label name");
  if ((c.tokenEnv ? 1 : 0) + (c.tokenFile ? 1 : 0) !== 1) e.push("set exactly one of nominations.tokenEnv or nominations.tokenFile (the token itself never goes in this file)");
  return e;
}

const clean = (v: unknown, n: number) => String(v ?? "").replace(/[^\n -~ -￿]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, n);
export const oneLine = (v: unknown, n: number) => clean(v, n * 2).replace(/\s+/g, " ").slice(0, n);

/** The value under a "### Heading" in a GitHub issue-form body (the forms render each field that way). */
export function formField(body: string, heading: string): string {
  const parts = body.replace(/\r\n/g, "\n").split(/^### /m);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    if (nl < 0) continue;
    if (p.slice(0, nl).trim().toLowerCase() === heading.toLowerCase()) return p.slice(nl + 1).trim();
  }
  return "";
}

export class NominationError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export class Nominations {
  constructor(private readonly cfg: NominationsConfig, private readonly env: NodeJS.ProcessEnv = process.env, private readonly doFetch: IssueFetch = (u, i) => fetch(u, i)) {}

  get label() { return this.cfg.label ?? NOMINATION_LABEL; }
  get repo() { return this.cfg.repo; }
  private get api() { return (this.cfg.apiBase ?? "https://api.github.com").replace(/\/+$/, ""); }

  private async token(): Promise<string | undefined> {
    if (this.cfg.tokenEnv) return this.env[this.cfg.tokenEnv] || undefined;
    if (this.cfg.tokenFile) { try { return (await readFile(this.cfg.tokenFile, "utf8")).trim() || undefined; } catch { return undefined; } }
    return undefined;
  }

  private async call(path: string, method = "GET", body?: unknown, needToken = false): Promise<Response> {
    const t = await this.token();
    if (needToken && !t) throw new NominationError(503, "no token is configured for the nominations tracker (nominations.tokenEnv / tokenFile)");
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    return this.doFetch(`${this.api}/repos/${this.cfg.repo}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  private static fail(r: Response, what: string): never {
    if (r.status === 401 || r.status === 403) throw new NominationError(502, `${what}: the tracker refused the token (HTTP ${r.status}); it needs Issues read and write on the tracker repository`);
    if (r.status === 404) throw new NominationError(502, `${what}: the tracker repository or issue was not found (or the token cannot see it)`);
    throw new NominationError(502, `${what}: the tracker answered HTTP ${r.status}`);
  }

  private static toNomination(i: Record<string, unknown>, label: string): Nomination | null {
    if (!i || typeof i.number !== "number" || !Number.isInteger(i.number) || i.number < 1 || i.pull_request) return null;
    if (i.state !== "open") return null;
    const labels = Array.isArray(i.labels) ? i.labels.map((l) => (typeof l === "string" ? l : (l as { name?: unknown })?.name)) : [];
    if (!labels.includes(label)) return null;
    const body = typeof i.body === "string" ? i.body.slice(0, 20_000) : "";
    return {
      number: i.number, title: oneLine(i.title, 200), by: oneLine((i.user as { login?: unknown } | null)?.login, 60), createdAt: oneLine(i.created_at, 40),
      candidate: oneLine(formField(body, "Plugin repository"), 300), why: clean(formField(body, "What do you need it for?"), 1000),
    };
  }

  /** Open nominations, oldest first. */
  async list(): Promise<Nomination[]> {
    const r = await this.call(`/issues?state=open&labels=${encodeURIComponent(this.label)}&per_page=50&sort=created&direction=asc`);
    if (!r.ok) Nominations.fail(r, "could not list nominations");
    const items = (await r.json()) as unknown;
    if (!Array.isArray(items)) throw new NominationError(502, "could not list nominations: unexpected answer from the tracker");
    return items.map((i) => Nominations.toNomination(i as Record<string, unknown>, this.label)).filter((n): n is Nomination => !!n);
  }

  /** The issue as it is NOW, or null when it is not an open nomination. Acting never relies on what the page showed earlier. */
  async get(n: number): Promise<Nomination | null> {
    if (!Number.isInteger(n) || n < 1) return null;
    const r = await this.call(`/issues/${n}`);
    if (r.status === 404) return null;
    if (!r.ok) Nominations.fail(r, "could not read the nomination");
    return Nominations.toNomination((await r.json()) as Record<string, unknown>, this.label);
  }

  /** Posts a comment (the text is composed by the caller from fixed wording and the admin's own words, never from the issue) and closes the issue. */
  async close(n: number, comment: string, reason: "completed" | "not_planned"): Promise<void> {
    const c = await this.call(`/issues/${n}/comments`, "POST", { body: comment }, true);
    if (!c.ok) Nominations.fail(c, "could not comment on the issue");
    const x = await this.call(`/issues/${n}`, "PATCH", { state: "closed", state_reason: reason }, true);
    if (!x.ok) Nominations.fail(x, "commented, but could not close the issue");
  }
}
