export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly?: boolean;
  authorUrl?: string;
}

export interface IndexEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  latestVersion: string;
  minAppVersion: string;
  isDesktopOnly: boolean;
  updated: string;
}

export interface VersionEntry {
  version: string;
  minAppVersion: string;
  published: string;
  /** sha256 hex of each file (empty string if absent) */
  sha256: { main: string; manifest: string; styles: string };
  hasStyles: boolean;
}

export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Returns <0, 0, >0. Unparseable versions compare as 0.0.0. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function validateManifest(m: unknown): string[] {
  const errs: string[] = [];
  const o = (m ?? {}) as Record<string, unknown>;
  for (const k of ["id", "name", "version", "minAppVersion", "description", "author"])
    if (typeof o[k] !== "string" || !(o[k] as string).trim()) errs.push(`missing ${k}`);
  if (typeof o.id === "string" && !/^[a-z0-9][a-z0-9-_]*$/.test(o.id)) errs.push("invalid id");
  if (typeof o.version === "string" && !parseSemver(o.version)) errs.push("version not x.y.z");
  return errs;
}
