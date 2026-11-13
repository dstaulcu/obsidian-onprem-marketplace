import type { ClientRow } from "./activity";
import type { PluginState } from "./state";

/**
 * Joins what clients last downloaded with what the registry says about those versions. The state is INFERRED from
 * downloads (the server cannot see what is installed or enabled), so the labels say "last fetched", never "installed".
 */
export type FetchStatus = "latest" | "behind" | "unapproved" | "not in registry";

export interface ClientView {
  key: string; first: string; last: string; kind: string; version?: string; os?: string; ua: string; addr: string; zone?: string; checks: number;
  plugins: { id: string; version: string; time: string; status: FetchStatus; latest?: string }[];
}

export function clientViews(rows: ClientRow[], state: PluginState[]): ClientView[] {
  const byId = new Map(state.map((p) => [p.id, p]));
  return rows.map((r) => ({
    key: r.key, first: r.first, last: r.last, kind: r.kind, version: r.version, os: r.os, ua: r.ua, addr: r.addr, zone: r.zone, checks: r.checks,
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
