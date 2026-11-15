import { compareSemver, parseSemver } from "@om/shared";

/**
 * Which releases of a plugin are worth mirroring (and so reviewing and approving). Three independent keeps, combined as a union:
 *  - patches: the newest N releases of the newest minor line (the current line and its recent fixes);
 *  - minors:  the latest release of each of the newest N minor lines (a few known-good steps back);
 *  - majors:  the latest release of each of the newest N major lines (so an older major keeps getting its last release).
 * A version is kept when ANY rule keeps it. Tags that are not plain x.y.z are always kept here (the normal checks reject them).
 * This only decides what sync takes in; it never deletes anything that is already mirrored.
 */
export interface Retain { patches?: number; minors?: number; majors?: number }

export const DEFAULT_RETAIN: Required<Retain> = { patches: 3, minors: 3, majors: 2 };

const count = (n: unknown, d: number) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : d);

/** The versions to keep out of `versions`, as a set. Order of the input does not matter. */
export function retainedVersions(versions: string[], retain: Retain = {}): Set<string> {
  const want = { patches: count(retain.patches, DEFAULT_RETAIN.patches), minors: count(retain.minors, DEFAULT_RETAIN.minors), majors: count(retain.majors, DEFAULT_RETAIN.majors) };
  const keep = new Set<string>();
  const parsed: { v: string; p: [number, number, number] }[] = [];
  for (const v of versions) { const p = parseSemver(v); if (p) parsed.push({ v, p }); else keep.add(v); }
  parsed.sort((a, b) => compareSemver(b.v, a.v));
  if (!parsed.length) return keep;
  const newestLine = `${parsed[0].p[0]}.${parsed[0].p[1]}`;
  let n = 0;
  for (const x of parsed) if (`${x.p[0]}.${x.p[1]}` === newestLine && n++ < want.patches) keep.add(x.v);
  const firstOf = (lineOf: (p: [number, number, number]) => string, limit: number) => {
    const seen = new Set<string>();
    for (const x of parsed) { const k = lineOf(x.p); if (seen.has(k)) continue; if (seen.size >= limit) break; seen.add(k); keep.add(x.v); }
  };
  firstOf((p) => `${p[0]}.${p[1]}`, want.minors);
  firstOf((p) => `${p[0]}`, want.majors);
  return keep;
}
