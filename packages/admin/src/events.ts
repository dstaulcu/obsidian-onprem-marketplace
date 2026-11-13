import { isSafeVersion, isValidPluginId } from "@om/shared";

/**
 * One versioned event shape for everything the admin service derives from the registry web server's access log.
 * Field names are a contract (Splunk searches and dashboards will depend on them): add fields, do not rename them.
 *
 * Every input here is attacker-controlled: any host on the network can send any path and user agent to the
 * registry. Parsing is strict, lengths are capped, and a malformed line yields null instead of throwing.
 */
export interface ClientInfo { kind: "obsidian" | "om" | "other"; version?: string; os?: string; ua: string }

export interface RegistryEvent {
  schema: 1;
  /** Stable per source line (source name + byte offset), so a downstream indexer can de-duplicate re-sent batches. */
  id: string;
  /** Original request time (ISO 8601), not the processing time. */
  time: string;
  type: "plugin.download" | "catalog.check";
  plugin?: string;
  version?: string;
  file?: string;
  status: number;
  bytes: number;
  /** True when this request is the indicator of an install or update: a successful download of main.js. */
  install: boolean;
  client: ClientInfo;
  addr: string;
  zone?: string;
}

const MAX_UA = 200;
const MAX_LINE = 4096;
// index.json, plugins/<id>/versions.json, plugins/<id>/<version>/<file>. Ids and versions are re-validated below.
const PATH_RE = /^\/(?:(index\.json)|plugins\/([^/]+)\/(?:(versions\.json)|([^/]+)\/(main\.js|manifest\.json|styles\.css)))$/;

const clean = (s: unknown, max: number): string =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";

export function classifyClient(uaRaw: string): ClientInfo {
  const ua = clean(uaRaw, MAX_UA);
  let os: string | undefined;
  if (/Windows NT/i.test(ua)) os = "windows";
  else if (/Android/i.test(ua)) os = "android";
  else if (/iPhone|iPad|iOS/i.test(ua)) os = "ios";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "macos";
  else if (/Linux|X11/i.test(ua)) os = "linux";
  const om = /^om\/([0-9A-Za-z.+-]{1,20})(?:\s|$)/.exec(ua);
  if (om) return { kind: "om", version: om[1], os, ua };
  const ob = /\bobsidian\/(\d{1,3}\.\d{1,3}\.\d{1,3})\b/i.exec(ua);
  if (ob) return { kind: "obsidian", version: ob[1], os, ua };
  return { kind: "other", os, ua };
}

/** "10.0.0.0/8"-style IPv4 table; the first matching entry wins. IPv4-mapped IPv6 addresses are unwrapped. */
export interface Network { cidr: string; name: string }
const ipv4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.replace(/^::ffff:/i, ""));
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((n) => n > 255) ? null : ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};
export function validNetwork(n: Network): boolean {
  const [ip, bits] = n.cidr.split("/");
  return ipv4(ip) !== null && /^\d{1,2}$/.test(bits ?? "") && Number(bits) <= 32 && typeof n.name === "string" && n.name.length > 0 && n.name.length <= 64;
}
export function zoneOf(addr: string, nets: Network[]): string | undefined {
  const a = ipv4(addr);
  if (a === null) return undefined;
  for (const n of nets) {
    const [base, bits] = n.cidr.split("/");
    const b = ipv4(base), len = Number(bits);
    if (b === null || !(len >= 0 && len <= 32)) continue;
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return n.name;
  }
  return undefined;
}

export interface ParseContext { source: string; offset: number; networks: Network[]; basePath?: string }

/**
 * Parses one line of the nginx `om` JSON log format (see deploy/nginx-om.conf). Returns null for anything that is not a
 * well-formed GET/HEAD of a registry file, including every request for an id/version that is not valid.
 */
export function parseAccessLine(line: string, ctx: ParseContext): RegistryEvent | null {
  if (!line || line.length > MAX_LINE) return null;
  let o: Record<string, unknown>;
  try { const v = JSON.parse(line); if (!v || typeof v !== "object" || Array.isArray(v)) return null; o = v as Record<string, unknown>; } catch { return null; }
  const method = clean(o.m, 8).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const status = Number(o.s), bytes = Number(o.b);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  const t = Date.parse(clean(o.t, 40));
  if (Number.isNaN(t)) return null;
  let path = clean(o.u, 300);
  if (ctx.basePath) { if (!path.startsWith(ctx.basePath)) return null; path = path.slice(ctx.basePath.length); }
  const m = PATH_RE.exec(path);
  if (!m) return null;
  const addr = clean(o.ip, 64);
  const client = classifyClient(clean(o.ua, MAX_UA));
  const base = { schema: 1 as const, id: `${ctx.source}:${ctx.offset}`, time: new Date(t).toISOString(), status, bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0, client, addr, zone: zoneOf(addr, ctx.networks) };
  if (m[1] || m[3]) {
    const plugin = m[3] ? m[2] : undefined;
    if (plugin !== undefined && !isValidPluginId(plugin)) return null;
    return { ...base, type: "catalog.check", plugin, file: m[1] ?? m[3], install: false };
  }
  const [plugin, version, file] = [m[2], m[4], m[5]];
  if (!isValidPluginId(plugin) || !isSafeVersion(version)) return null;
  const ok = (status === 200 || status === 206) && method === "GET";
  return { ...base, type: "plugin.download", plugin, version, file, install: ok && file === "main.js" };
}

/** Admin audit lines (already JSON) wrapped in the same envelope so one sink handles both streams. */
export function normalizeAudit(line: string, source: string, offset: number): Record<string, unknown> | null {
  if (!line || line.length > MAX_LINE) return null;
  try {
    const a = JSON.parse(line) as Record<string, unknown>;
    if (!a || typeof a !== "object" || typeof a.action !== "string" || typeof a.ts !== "string") return null;
    const { ts, action, ...rest } = a;
    return { schema: 1, id: `${source}:${offset}`, time: ts, type: `admin.${action.slice(0, 40)}`, ...rest };
  } catch { return null; }
}
