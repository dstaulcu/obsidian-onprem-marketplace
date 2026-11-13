import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseAccessLine, type Network, type RegistryEvent } from "./events";
import { readJson, readNewLines, writeJsonAtomic, type Cursor } from "./tail";

/**
 * Server-side client activity derived from the registry web server's access log. Nothing here is reported by clients,
 * and nothing is proof of installed state: "plugins" per client means "the last version this client downloaded".
 *
 * Memory is bounded on purpose: any host can send any user agent, so every collection is capped.
 */
const MAX_CLIENTS = 5000;
const MAX_KEYS_PER_SET = 20_000;
const RETENTION_DAYS = 90;
const RECENT = 200;

export interface ClientRow {
  key: string; first: string; last: string; kind: string; version?: string; os?: string; ua: string;
  addr: string; zone?: string; checks: number; plugins: Record<string, { version: string; time: string }>;
}
interface PluginDay { all: Set<string>; ver: Map<string, Set<string>> }
interface Persisted {
  v: 1; salt: string; cursor: Cursor | null;
  days: Record<string, Record<string, { all: string[]; ver: Record<string, string[]> }>>;
  clients: Record<string, ClientRow>;
}

export class ActivityStore {
  salt = randomBytes(16).toString("hex");
  cursor: Cursor | null = null;
  private days = new Map<string, Map<string, PluginDay>>();
  private clients = new Map<string, ClientRow>();
  readonly recent: RegistryEvent[] = [];

  clientKey(addr: string, ua: string): string {
    return createHash("sha256").update(`${this.salt}|${addr}|${ua}`).digest("hex").slice(0, 16);
  }

  apply(ev: RegistryEvent): void {
    if (ev.status >= 400) return; // failed/hostile requests do not create clients or counts
    this.recent.push(ev);
    if (this.recent.length > RECENT) this.recent.shift();
    const key = this.clientKey(ev.addr, ev.client.ua);
    let row = this.clients.get(key);
    if (!row) {
      if (this.clients.size >= MAX_CLIENTS) this.evictOldest();
      row = { key, first: ev.time, last: ev.time, kind: ev.client.kind, version: ev.client.version, os: ev.client.os, ua: ev.client.ua, addr: ev.addr, zone: ev.zone, checks: 0, plugins: {} };
      this.clients.set(key, row);
    }
    if (ev.time > row.last) row.last = ev.time;
    if (ev.type === "catalog.check") row.checks++;
    if (!ev.install || !ev.plugin || !ev.version) return;
    const prev = row.plugins[ev.plugin];
    if (!prev || ev.time >= prev.time) row.plugins[ev.plugin] = { version: ev.version, time: ev.time };

    const day = ev.time.slice(0, 10);
    let d = this.days.get(day);
    if (!d) { d = new Map(); this.days.set(day, d); }
    let p = d.get(ev.plugin);
    if (!p) { p = { all: new Set(), ver: new Map() }; d.set(ev.plugin, p); }
    if (p.all.size < MAX_KEYS_PER_SET) p.all.add(key);
    let vs = p.ver.get(ev.version);
    if (!vs) { vs = new Set(); p.ver.set(ev.version, vs); }
    if (vs.size < MAX_KEYS_PER_SET) vs.add(key);
  }

  private evictOldest(): void {
    let oldest: ClientRow | undefined;
    for (const r of this.clients.values()) if (!oldest || r.last < oldest.last) oldest = r;
    if (oldest) this.clients.delete(oldest.key);
  }

  prune(now: Date): void {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    for (const day of this.days.keys()) if (day < cutoff.slice(0, 10)) this.days.delete(day);
    for (const [k, r] of this.clients) if (r.last < cutoff) this.clients.delete(k);
  }

  clientRows(): ClientRow[] { return [...this.clients.values()].sort((a, b) => (a.last < b.last ? 1 : -1)); }

  /** Distinct clients that downloaded main.js in the window, per plugin and per version. Small counts are withheld. */
  publicStats(now: Date, windowDays: number, minCount: number) {
    const from = new Date(now.getTime() - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
    const perPlugin = new Map<string, { all: Set<string>; ver: Map<string, Set<string>> }>();
    for (const [day, plugins] of this.days) {
      if (day < from) continue;
      for (const [id, p] of plugins) {
        let agg = perPlugin.get(id);
        if (!agg) { agg = { all: new Set(), ver: new Map() }; perPlugin.set(id, agg); }
        p.all.forEach((k) => agg!.all.add(k));
        for (const [v, ks] of p.ver) { let s = agg.ver.get(v); if (!s) { s = new Set(); agg.ver.set(v, s); } ks.forEach((k) => s!.add(k)); }
      }
    }
    const plugins: Record<string, { installs: number; versions: Record<string, number> }> = {};
    for (const [id, a] of [...perPlugin].sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (a.all.size < minCount) continue;
      const versions: Record<string, number> = {};
      for (const [v, ks] of a.ver) if (ks.size >= minCount) versions[v] = ks.size;
      plugins[id] = { installs: a.all.size, versions };
    }
    return { schema: 1 as const, generated: now.toISOString(), windowDays, minCount, plugins };
  }

  toJSON(): Persisted {
    const days: Persisted["days"] = {};
    for (const [day, plugins] of this.days) {
      days[day] = {};
      for (const [id, p] of plugins) days[day][id] = { all: [...p.all], ver: Object.fromEntries([...p.ver].map(([v, s]) => [v, [...s]])) };
    }
    return { v: 1, salt: this.salt, cursor: this.cursor, days, clients: Object.fromEntries(this.clients) };
  }
  static fromJSON(p: Persisted | null): ActivityStore {
    const s = new ActivityStore();
    if (!p || p.v !== 1) return s;
    s.salt = p.salt; s.cursor = p.cursor;
    for (const [day, plugins] of Object.entries(p.days ?? {})) {
      const d = new Map<string, PluginDay>();
      for (const [id, v] of Object.entries(plugins)) d.set(id, { all: new Set(v.all), ver: new Map(Object.entries(v.ver).map(([k, a]) => [k, new Set(a)])) });
      s.days.set(day, d);
    }
    for (const [k, r] of Object.entries(p.clients ?? {})) s.clients.set(k, r);
    return s;
  }
}

export interface AccessOptions { logFile: string; stateFile: string; networks: Network[]; basePath?: string }

/**
 * Tails the access log into an ActivityStore. Aggregates and the read cursor are saved in ONE atomic file, so a crash
 * or restart can neither reset the counts nor count the same lines twice.
 */
export class AccessProcessor {
  store = new ActivityStore();
  private loaded = false;
  lastError: string | null = null;
  constructor(private o: AccessOptions) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.store = ActivityStore.fromJSON(await readJson(this.o.stateFile));
    this.loaded = true;
  }

  /** Reads everything new, applies it, saves. Returns the number of events applied. */
  async step(now = new Date()): Promise<number> {
    await this.load();
    try {
      const r = await readNewLines(this.o.logFile, this.store.cursor);
      if (!r) { this.lastError = `cannot read ${this.o.logFile}`; return 0; }
      this.lastError = null;
      let n = 0;
      for (const l of r.lines) {
        const ev = parseAccessLine(l.text, { source: "access", offset: l.offset, networks: this.o.networks, basePath: this.o.basePath });
        if (ev) { this.store.apply(ev); n++; }
      }
      const moved = !this.store.cursor || this.store.cursor.offset !== r.next.offset || this.store.cursor.ino !== r.next.ino || this.store.cursor.head !== r.next.head;
      this.store.cursor = r.next;
      if (moved) { this.store.prune(now); await writeJsonAtomic(this.o.stateFile, this.store.toJSON()); }
      return n;
    } catch (e) { this.lastError = (e as Error).message; return 0; }
  }
}

/** Writes stats.json into the public registry tree via a temp file + rename, so nginx never serves a half-written file. */
export async function publishStats(registryDir: string, store: ActivityStore, windowDays: number, minCount: number, now = new Date()): Promise<void> {
  const file = join(registryDir, "stats.json");
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store.publicStats(now, windowDays, minCount)));
  await rename(tmp, file);
}
