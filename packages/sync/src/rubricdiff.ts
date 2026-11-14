import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeVersion, isValidPluginId, type FileHashes } from "@om/shared";
import { readPublished, readStaged } from "./catalog";
import type { CompiledRule, Rubric } from "./rubric";
import { scanSource } from "./staticchecks";

/**
 * Answers "did the rubric change, and does it matter?" for admins.
 *
 * The rubric version is a hash of every rule's id, severity, pattern and flags plus the model instructions. A reworded title,
 * "why" text or example does NOT change it; a one-character edit to a pattern or to the prompt DOES. So a changed version only
 * says "something that can change a result changed". This module keeps a copy of each version it has seen (a snapshot), shows
 * what differs, and, for free and without calling a model, re-runs the deterministic checks over every mirrored version to show
 * whether the static result would actually move. Whether that justifies paid model reviews is the admin's decision.
 */
export interface RuleBrief { id: string; title: string; severity: "high" | "medium"; pattern: string; flags: string; why: string }
export interface RubricSnapshot { name: string; version: string; seenAt: string; rules: RuleBrief[]; prompt: string }

const VERSION_RE = /^[A-Za-z0-9._-]{1,40}@[0-9a-f]{10}$/;
export const isRubricVersion = (v: unknown): v is string => typeof v === "string" && VERSION_RE.test(v);
const fileOf = (dir: string, version: string) => join(dir, version.replace("@", "_") + ".json");

export const toSnapshot = (r: Rubric, now = new Date()): RubricSnapshot => ({
  name: r.name, version: r.version, seenAt: now.toISOString(), prompt: r.prompt,
  rules: r.rules.map((x) => ({ id: x.id, title: x.title, severity: x.severity, pattern: x.pattern, flags: x.re.flags, why: x.why })),
});

/** Keeps the first copy it sees of each rubric version (idempotent), so later changes can be compared with it. */
export async function saveSnapshot(dir: string, r: Rubric, now = new Date()): Promise<boolean> {
  if (!isRubricVersion(r.version)) return false;
  const file = fileOf(dir, r.version);
  if (await stat(file).then(() => true, () => false)) return false;
  await mkdir(dir, { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(toSnapshot(r, now), null, 2));
  await rename(file + ".tmp", file);
  return true;
}

export async function loadSnapshot(dir: string, version: string): Promise<RubricSnapshot | null> {
  if (!isRubricVersion(version)) return null; // the version becomes part of a file name: shape-checked first
  try {
    const s = JSON.parse(await readFile(fileOf(dir, version), "utf8")) as RubricSnapshot;
    return s && s.version === version && Array.isArray(s.rules) && typeof s.prompt === "string" ? s : null;
  } catch { return null; }
}

export async function listSnapshots(dir: string): Promise<{ version: string; seenAt: string }[]> {
  const out: { version: string; seenAt: string }[] = [];
  try {
    for (const n of await readdir(dir)) {
      if (!n.endsWith(".json")) continue;
      try { const s = JSON.parse(await readFile(join(dir, n), "utf8")) as RubricSnapshot; if (isRubricVersion(s.version)) out.push({ version: s.version, seenAt: String(s.seenAt) }); } catch { /* skip damaged */ }
    }
  } catch { /* none yet */ }
  return out.sort((a, b) => a.seenAt.localeCompare(b.seenAt));
}

export interface RubricDiff {
  from: string; to: string;
  added: RuleBrief[]; removed: RuleBrief[];
  changed: { id: string; title: string; changes: string[] }[];
  /** Title, "why" or example edits only: they do not change the version, so they never make a review stale. */
  cosmetic: string[];
  promptChanged: boolean;
  promptLines: { added: string[]; removed: string[]; addedCount: number; removedCount: number };
  /** One plain sentence per effect, for people deciding whether to re-review. */
  summary: string[];
}

const lineBag = (t: string) => { const m = new Map<string, number>(); for (const l of t.split("\n").map((x) => x.trim()).filter(Boolean)) m.set(l, (m.get(l) ?? 0) + 1); return m; };
const clipLine = (s: string) => s.replace(/[^ -~]/g, " ").slice(0, 200);

export function diffSnapshots(a: RubricSnapshot, b: RubricSnapshot): RubricDiff {
  const am = new Map(a.rules.map((r) => [r.id, r])), bm = new Map(b.rules.map((r) => [r.id, r]));
  const added = b.rules.filter((r) => !am.has(r.id)), removed = a.rules.filter((r) => !bm.has(r.id));
  const changed: RubricDiff["changed"] = [], cosmetic: string[] = [];
  for (const [id, y] of bm) {
    const x = am.get(id); if (!x) continue;
    const c: string[] = [];
    if (x.severity !== y.severity) c.push(`severity ${x.severity} -> ${y.severity}`);
    if (x.pattern !== y.pattern) c.push("pattern changed");
    if (x.flags !== y.flags) c.push(`flags ${x.flags} -> ${y.flags}`);
    if (c.length) changed.push({ id, title: y.title, changes: c });
    else if (x.title !== y.title || x.why !== y.why) cosmetic.push(id);
  }
  const ab = lineBag(a.prompt), bb = lineBag(b.prompt);
  const gone: string[] = [], came: string[] = [];
  for (const [l, n] of ab) if ((bb.get(l) ?? 0) < n) gone.push(l);
  for (const [l, n] of bb) if ((ab.get(l) ?? 0) < n) came.push(l);
  const promptChanged = a.prompt !== b.prompt;
  const summary: string[] = [];
  if (added.length) summary.push(`${added.length} new check${added.length > 1 ? "s" : ""} (${added.map((r) => `${r.id}: ${r.severity}`).join(", ")}): versions that trip them will now show findings`);
  if (removed.length) summary.push(`${removed.length} check${removed.length > 1 ? "s" : ""} removed (${removed.map((r) => r.id).join(", ")}): earlier findings from them no longer apply`);
  for (const c of changed) summary.push(`${c.id}: ${c.changes.join(", ")}`);
  if (promptChanged) summary.push(`model instructions changed (${came.length} line${came.length === 1 ? "" : "s"} added, ${gone.length} removed): a model review may judge differently`);
  if (!summary.length) summary.push(cosmetic.length ? "only wording changed (titles, explanations or examples): results cannot differ" : "no differences");
  return {
    from: a.version, to: b.version, added, removed, changed, cosmetic, promptChanged,
    promptLines: { added: came.slice(0, 30).map(clipLine), removed: gone.slice(0, 30).map(clipLine), addedCount: came.length, removedCount: gone.length },
    summary,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Static impact: does the deterministic result move for versions that were reviewed under an older rubric?

const compileBrief = (r: RuleBrief): CompiledRule => ({
  ...r, examples: { match: [], noMatch: [] },
  re: new RegExp(r.pattern, r.flags.includes("g") ? r.flags : r.flags + "g"),
});
const hitMap = (src: string, rules: CompiledRule[]) => new Map(scanSource(src, rules).checked.map((c) => [c.rule, c]));
export const MAX_SCAN_BYTES = 10_000_000;
export const MAX_IMPACT_VERSIONS = 500;

export interface ReviewMeta { verdict: string; rubricVersion: string | null; model: string | null }
export interface ImpactRow {
  id: string; version: string;
  reviewVerdict: string | null; reviewedUnder: string | null; model: string | null;
  /** current: reviewed under this rubric; unreviewed: no review yet; unchanged / changed: stale and compared; unknown: stale, no snapshot of its rubric. */
  status: "current" | "unreviewed" | "unchanged" | "changed" | "unknown";
  newHits: { rule: string; severity: string; count: number }[];
  goneHits: { rule: string; severity: string; count: number }[];
  /** Findings under the CURRENT rubric (high severity count and total rules that hit). */
  highNow: number; rulesHit: number;
}

async function readReview(vdir: string): Promise<ReviewMeta | null> {
  try {
    const j = JSON.parse(await readFile(join(vdir, "review.json"), "utf8")) as { review?: { verdict?: unknown; rubricVersion?: unknown; model?: unknown } };
    const r = j.review; if (!r) return null;
    return { verdict: String(r.verdict ?? "unknown").slice(0, 20), rubricVersion: typeof r.rubricVersion === "string" ? r.rubricVersion.slice(0, 60) : null, model: typeof r.model === "string" ? r.model.slice(0, 60) : null };
  } catch { return null; }
}

/** Free (no model call): compares the deterministic result of every stale version under its own old rubric and the current one. */
export async function staticImpact(outDir: string, current: Rubric, snapshotDir: string): Promise<ImpactRow[]> {
  const rows: ImpactRow[] = [];
  const cache = new Map<string, CompiledRule[] | null>();
  let ids: string[] = [];
  try { ids = (await readdir(join(outDir, "plugins"))).filter(isValidPluginId).sort(); } catch { return rows; }
  for (const id of ids) {
    const pdir = join(outDir, "plugins", id);
    const entries: { version: string; sha256: FileHashes }[] = [...(await readPublished(pdir)), ...(await readStaged(pdir))];
    for (const e of entries) {
      if (rows.length >= MAX_IMPACT_VERSIONS) return rows;
      if (!isSafeVersion(e.version)) continue;
      const vdir = join(pdir, e.version);
      const rev = await readReview(vdir);
      const row: ImpactRow = { id, version: e.version, reviewVerdict: rev?.verdict ?? null, reviewedUnder: rev?.rubricVersion ?? null, model: rev?.model ?? null, status: "unreviewed", newHits: [], goneHits: [], highNow: 0, rulesHit: 0 };
      let src: string | null = null;
      try { const p = join(vdir, "main.js"); src = (await stat(p)).size <= MAX_SCAN_BYTES ? await readFile(p, "utf8") : null; } catch { src = null; }
      if (!rev) { rows.push(row); continue; }
      const nowHits = src === null ? null : hitMap(src, current.rules);
      if (nowHits) { row.highNow = [...nowHits.values()].filter((c) => c.count > 0 && c.severity === "high").length; row.rulesHit = [...nowHits.values()].filter((c) => c.count > 0).length; }
      if (rev.rubricVersion === current.version) { row.status = "current"; rows.push(row); continue; }
      let oldRules = rev.rubricVersion ? cache.get(rev.rubricVersion) : null;
      if (rev.rubricVersion && oldRules === undefined) {
        const snap = await loadSnapshot(snapshotDir, rev.rubricVersion);
        try { oldRules = snap ? snap.rules.map(compileBrief) : null; } catch { oldRules = null; }
        cache.set(rev.rubricVersion, oldRules);
      }
      if (!oldRules || !nowHits || src === null) { row.status = "unknown"; rows.push(row); continue; }
      const before = hitMap(src, oldRules);
      for (const [rule, c] of nowHits) if (c.count > 0 && !((before.get(rule)?.count ?? 0) > 0)) row.newHits.push({ rule, severity: c.severity, count: c.count });
      for (const [rule, c] of before) if (c.count > 0 && !((nowHits.get(rule)?.count ?? 0) > 0)) row.goneHits.push({ rule, severity: c.severity, count: c.count });
      row.status = row.newHits.length || row.goneHits.length ? "changed" : "unchanged";
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Which versions to re-review after a rubric change.
 *   all      every reviewed version whose review is not current: made under another rubric version, or by another model
 *   changed  only those whose deterministic result would move (a new or vanished check hit)
 * Unreviewed versions and errored reviews are picked up by a plain "review all", not here.
 */
export async function staleTargets(outDir: string, current: Rubric, snapshotDir: string, mode: "all" | "changed", model?: string): Promise<{ id: string; version: string }[]> {
  const rows = await staticImpact(outDir, current, snapshotDir);
  return rows
    .filter((r) => (mode === "changed" ? r.status === "changed" : r.status === "changed" || r.status === "unchanged" || r.status === "unknown" || (r.status === "current" && !!model && !!r.model && r.model !== model)))
    .map((r) => ({ id: r.id, version: r.version }));
}
