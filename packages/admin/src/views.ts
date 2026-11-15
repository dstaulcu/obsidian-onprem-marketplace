import type { ClientRow } from "./activity";
import { compareSemver, parseSemver } from "@om/shared";
import type { PluginState } from "./state";

/**
 * Joins what clients last downloaded with what the registry says about those versions. The state is INFERRED from
 * downloads (the server cannot see what is installed or enabled), so the labels say "last fetched", never "installed".
 */
export type FetchStatus = "latest" | "behind" | "unapproved" | "not in registry";

export interface ClientView {
  key: string; first: string; last: string; kind: string; version?: string; os?: string; ua: string; addr: string; checks: number;
  plugins: { id: string; version: string; time: string; status: FetchStatus; latest?: string }[];
}

export function clientViews(rows: ClientRow[], state: PluginState[]): ClientView[] {
  const byId = new Map(state.map((p) => [p.id, p]));
  return rows.map((r) => ({
    key: r.key, first: r.first, last: r.last, kind: r.kind, version: r.version, os: r.os, ua: r.ua, addr: r.addr, checks: r.checks,
    plugins: Object.entries(r.plugins).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, p]) => {
      const reg = byId.get(id);
      const cur = reg?.versions.find((v) => v.version === p.version);
      const published = reg?.versions.filter((v) => !v.staged) ?? [];
      const latest = published[0]?.version; // versions.json is newest first
      let status: FetchStatus;
      if (!cur) status = "not in registry";
      else if (!cur.approval?.ok) status = "unapproved";
      else status = latest && latest !== p.version ? "behind" : "latest";
      return { id, version: p.version, time: p.time, status, latest };
    }),
  }));
}

/** Plugin × version → how many known clients last fetched that version. */
export function adoption(views: ClientView[]): { id: string; version: string; clients: number; status: FetchStatus }[] {
  const m = new Map<string, { id: string; version: string; clients: number; status: FetchStatus }>();
  for (const v of views) for (const p of v.plugins) {
    const k = `${p.id}@${p.version}`;
    const e = m.get(k) ?? { id: p.id, version: p.version, clients: 0, status: p.status };
    e.clients++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => (a.id === b.id ? (a.version < b.version ? 1 : -1) : a.id < b.id ? -1 : 1));
}

/**
 * Which known Obsidian clients cannot run a plugin's newest version. Obsidian reports its own version in its user agent; om does not, so
 * om clients are left out. Inferred from user agents (which anyone can fake), so it is a planning aid for the admin, never a decision input.
 * "fallback" is the newest published, approved version whose minAppVersion the oldest known Obsidian still satisfies: the release to keep
 * available so those clients still have an upgrade path.
 */
export interface Compat {
  id: string; latest: string; needs: string; obsidianClients: number; stranded: number; oldest: string; fallback: string | null;
}
export function compatibility(rows: ClientRow[], state: PluginState[], now = Date.now(), windowDays = 30): { compat: Compat[]; obsidianVersions: { version: string; clients: number }[] } {
  const cutoff = now - windowDays * 86_400_000;
  const vers = rows.filter((r) => r.kind === "obsidian" && r.version && parseSemver(r.version) && Date.parse(r.last) >= cutoff).map((r) => r.version as string);
  const counts = new Map<string, number>();
  for (const v of vers) counts.set(v, (counts.get(v) ?? 0) + 1);
  const obsidianVersions = [...counts].map(([version, clients]) => ({ version, clients })).sort((a, b) => compareSemver(b.version, a.version));
  if (!vers.length) return { compat: [], obsidianVersions };
  const oldest = vers.reduce((a, b) => (compareSemver(a, b) <= 0 ? a : b));
  const compat: Compat[] = [];
  for (const p of state) {
    const published = p.versions.filter((v) => !v.staged); // newest first
    const latest = published[0];
    if (!latest || !latest.minAppVersion || !parseSemver(latest.minAppVersion)) continue;
    const stranded = vers.filter((v) => compareSemver(v, latest.minAppVersion!) < 0).length;
    const fb = published.find((v) => v.approval?.ok && v.minAppVersion && parseSemver(v.minAppVersion) && compareSemver(oldest, v.minAppVersion) >= 0);
    compat.push({ id: p.id, latest: latest.version, needs: latest.minAppVersion, obsidianClients: vers.length, stranded, oldest, fallback: stranded ? (fb?.version ?? null) : latest.version });
  }
  compat.sort((a, b) => b.stranded - a.stranded || (a.id < b.id ? -1 : 1));
  return { compat, obsidianVersions };
}
