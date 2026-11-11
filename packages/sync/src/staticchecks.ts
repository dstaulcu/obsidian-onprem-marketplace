/**
 * Deterministic checks run in code, outside any LLM. They set a floor on the review verdict that a model
 * "pass" can never lower, so text planted in a plugin cannot talk its way past them.
 */
export interface StaticFinding {
  rule: string;
  severity: "high" | "medium";
  count: number;
  samples: { line: number; snippet: string }[];
}
export interface StaticReport { findings: StaticFinding[]; hosts: string[]; bytes: number }

const RULES: { rule: string; severity: "high" | "medium"; re: RegExp }[] = [
  { rule: "eval", severity: "high", re: /\beval\s*\(/g },
  { rule: "new Function", severity: "high", re: /\bnew\s+Function\s*\(/g },
  { rule: "child_process", severity: "high", re: /child_process/g },
  { rule: "dynamic require/import", severity: "high", re: /\b(?:require|import)\s*\(\s*[^"'`\s)]/g },
  { rule: "electron/remote", severity: "high", re: /require\(\s*["']electron["']\s*\)|@electron\/remote/g },
  { rule: "process.binding / native addon", severity: "high", re: /process\.binding|\.node["']\s*\)/g },
  { rule: "fs outside vault (node fs)", severity: "medium", re: /require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g },
  { rule: "network call", severity: "medium", re: /\bfetch\s*\(|XMLHttpRequest|WebSocket|\brequestUrl\s*\(|\bnavigator\.sendBeacon/g },
  { rule: "cookie/credential access", severity: "medium", re: /document\.cookie|\bkeytar\b|safeStorage/g },
  { rule: "obfuscation hint", severity: "medium", re: /String\.fromCharCode\s*\([^)]{80,}\)|atob\s*\(\s*["'][A-Za-z0-9+/=]{200,}/g },
];

const snippet = (src: string, idx: number, len: number) =>
  src.slice(Math.max(0, idx - 50), Math.min(src.length, idx + len + 50)).replace(/\s+/g, " ").trim().slice(0, 160);

export function scanSource(src: string): StaticReport {
  const findings: StaticFinding[] = [];
  const lineAt = (idx: number) => src.slice(0, idx).split("\n").length;
  for (const { rule, severity, re } of RULES) {
    const f: StaticFinding = { rule, severity, count: 0, samples: [] };
    for (const m of src.matchAll(re)) {
      f.count++;
      if (f.samples.length < 3) f.samples.push({ line: lineAt(m.index ?? 0), snippet: snippet(src, m.index ?? 0, m[0].length) });
    }
    if (f.count) findings.push(f);
  }
  const hosts = [...new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi)].map((m) => m[1].toLowerCase()))].sort();
  return { findings, hosts, bytes: src.length };
}

/** What changed in risk surface since the previous version (new rules, new hosts). */
export function diffReports(prev: StaticReport | null, cur: StaticReport): string[] {
  if (!prev) return ["first reviewed version: no previous version to compare"];
  const out: string[] = [];
  const prevRules = new Set(prev.findings.map((f) => f.rule));
  for (const f of cur.findings) if (!prevRules.has(f.rule)) out.push(`new rule hit: ${f.rule} (${f.count})`);
  const prevHosts = new Set(prev.hosts);
  for (const h of cur.hosts) if (!prevHosts.has(h)) out.push(`new host referenced: ${h}`);
  out.push(`size ${prev.bytes} -> ${cur.bytes} bytes`);
  return out;
}

export const hasHigh = (r: StaticReport) => r.findings.some((f) => f.severity === "high");
