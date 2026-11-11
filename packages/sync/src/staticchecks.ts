import type { CompiledRule } from "./rubric";

/**
 * Deterministic checks run in code, outside any LLM. The rules come from the rubric (rubric/rules.json). They set
 * a floor on the review verdict that a model "pass" can never lower, so text planted in a plugin cannot talk its
 * way past them.
 */
export interface StaticFinding {
  rule: string;
  title: string;
  severity: "high" | "medium";
  count: number;
  samples: { line: number; snippet: string }[];
}
export interface CheckedRule { rule: string; title: string; severity: "high" | "medium"; count: number }
export interface StaticReport {
  findings: StaticFinding[];
  /** Every rule that was applied, with its hit count, so a report can show what was tested and passed. */
  checked: CheckedRule[];
  hosts: string[];
  bytes: number;
}

const snippet = (src: string, idx: number, len: number) =>
  src.slice(Math.max(0, idx - 50), Math.min(src.length, idx + len + 50)).replace(/\s+/g, " ").trim().slice(0, 160);

export function scanSource(src: string, rules: CompiledRule[]): StaticReport {
  const findings: StaticFinding[] = [];
  const checked: CheckedRule[] = [];
  const lineAt = (idx: number) => src.slice(0, idx).split("\n").length;
  for (const { id, title, severity, re } of rules) {
    const f: StaticFinding = { rule: id, title, severity, count: 0, samples: [] };
    for (const m of src.matchAll(new RegExp(re.source, re.flags))) {
      f.count++;
      if (f.samples.length < 3) f.samples.push({ line: lineAt(m.index ?? 0), snippet: snippet(src, m.index ?? 0, m[0].length) });
    }
    checked.push({ rule: id, title, severity, count: f.count });
    if (f.count) findings.push(f);
  }
  const hosts = [...new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi)].map((m) => m[1].toLowerCase()))].sort();
  return { findings, checked, hosts, bytes: src.length };
}

/** What changed in risk surface since the previous version (new rules, new hosts). */
export function diffReports(prev: StaticReport | null, cur: StaticReport): string[] {
  if (!prev) return ["first reviewed version: no previous version to compare"];
  const out: string[] = [];
  const prevRules = new Set(prev.findings.map((f) => f.rule));
  for (const f of cur.findings) if (!prevRules.has(f.rule)) out.push(`new rule hit: ${f.title} (${f.count})`);
  const prevHosts = new Set(prev.hosts);
  for (const h of cur.hosts) if (!prevHosts.has(h)) out.push(`new host referenced: ${h}`);
  out.push(`size ${prev.bytes} -> ${cur.bytes} bytes`);
  return out;
}

export const hasHigh = (r: StaticReport) => r.findings.some((f) => f.severity === "high");
