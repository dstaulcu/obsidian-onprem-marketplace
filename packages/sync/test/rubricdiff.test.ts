import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadRubric } from "../src/rubric";
import { diffSnapshots, isRubricVersion, listSnapshots, loadSnapshot, saveSnapshot, staleTargets, staticImpact, toSnapshot } from "../src/rubricdiff";

const rule = (id: string, pattern: string, severity: "high" | "medium" = "high", title = "A check", why = "Explains the risk of this pattern in code.") =>
  ({ id, title, severity, pattern, why, examples: { match: ["x"], noMatch: ["y"] } });

async function rubric(rules: object[], prompt = "Look for exfiltration.\nBe concise.\n") {
  const dir = await mkdtemp(join(tmpdir(), "rub-"));
  await writeFile(join(dir, "rules.json"), JSON.stringify({ name: "default", rules }));
  await writeFile(join(dir, "review-prompt.md"), prompt);
  return loadRubric(dir);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("rubric version and diff", () => {
  it("wording changes (title, why, examples) keep the version; pattern, severity, new rules and prompt edits change it", async () => {
    const base = await rubric([rule("eval", "eval\\(")]);
    expect((await rubric([rule("eval", "eval\\(", "high", "A better title", "A rewritten explanation of the same risk.")])).version).toBe(base.version);
    expect((await rubric([rule("eval", "eval\\(\\s")])).version).not.toBe(base.version);
    expect((await rubric([rule("eval", "eval\\(", "medium")])).version).not.toBe(base.version);
    expect((await rubric([rule("eval", "eval\\("), rule("net", "fetch\\(")])).version).not.toBe(base.version);
    expect((await rubric([rule("eval", "eval\\(")], "Look for exfiltration.\nBe very concise.\n")).version).not.toBe(base.version);
  });

  it("describes what changed in plain terms", async () => {
    const a = toSnapshot(await rubric([rule("eval", "eval\\("), rule("old", "old\\(", "medium")]));
    const b = toSnapshot(await rubric([rule("eval", "eval\\(\\s", "medium", "Renamed"), rule("net", "fetch\\(")], "Look for exfiltration.\nAlso check timers.\n"));
    const d = diffSnapshots(a, b);
    expect(d.added.map((r) => r.id)).toEqual(["net"]);
    expect(d.removed.map((r) => r.id)).toEqual(["old"]);
    expect(d.changed).toEqual([{ id: "eval", title: "Renamed", changes: ["severity high -> medium", "pattern changed"] }]);
    expect(d.promptChanged).toBe(true);
    expect(d.promptLines.added).toEqual(["Also check timers."]);
    expect(d.promptLines.removed).toEqual(["Be concise."]);
    expect(d.summary.join(" | ")).toMatch(/1 new check.*net: high.*removed.*old.*model instructions changed/);
  });

  it("a wording-only change is reported as unable to change results", async () => {
    const a = toSnapshot(await rubric([rule("eval", "eval\\(")]));
    const b = toSnapshot(await rubric([rule("eval", "eval\\(", "high", "Another title", "Another explanation of why this matters.")]));
    const d = diffSnapshots(a, b);
    expect(d.cosmetic).toEqual(["eval"]);
    expect(d.summary).toEqual(["only wording changed (titles, explanations or examples): results cannot differ"]);
  });
});

describe("snapshots", () => {
  it("keeps the first copy of each version, lists them, and refuses unsafe version strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-"));
    const r = await rubric([rule("eval", "eval\\(")]);
    expect(await saveSnapshot(dir, r, new Date("2026-01-01"))).toBe(true);
    expect(await saveSnapshot(dir, r, new Date("2026-02-02"))).toBe(false); // already have it
    const r2 = await rubric([rule("eval", "eval\\(\\s")]);
    await saveSnapshot(dir, r2, new Date("2026-03-03"));
    expect((await listSnapshots(dir)).map((s) => s.version)).toEqual([r.version, r2.version]);
    expect((await loadSnapshot(dir, r.version))?.rules[0].id).toBe("eval");
    for (const bad of ["../../etc/passwd", "default@zz", "x", "default@" + "0".repeat(10) + "/../x", ""]) expect(await loadSnapshot(dir, bad)).toBeNull();
    expect(isRubricVersion("default@038466eb4c")).toBe(true);
    expect(isRubricVersion("default@038466eb4cX")).toBe(false);
    expect((await readdir(dir)).every((n) => n.endsWith(".json"))).toBe(true);
  });
});

async function registryWith(versions: { v: string; code: string; reviewedUnder?: string; verdict?: string; model?: string }[]) {
  const out = await mkdtemp(join(tmpdir(), "reg-"));
  const pdir = join(out, "plugins", "demo");
  const list: object[] = [];
  for (const x of versions) {
    const vdir = join(pdir, x.v);
    await mkdir(vdir, { recursive: true });
    await writeFile(join(vdir, "main.js"), x.code);
    await writeFile(join(vdir, "manifest.json"), "{}");
    list.push({ version: x.v, minAppVersion: "1.5.0", published: "x", hasStyles: false, sha256: { main: sha(x.code), manifest: sha("{}"), styles: "" } });
    if (x.reviewedUnder) await writeFile(join(vdir, "review.json"), JSON.stringify({ schema: 1, review: { verdict: x.verdict ?? "pass", rubricVersion: x.reviewedUnder, model: x.model ?? "m" } }));
  }
  await writeFile(join(pdir, "versions.json"), JSON.stringify(list));
  return out;
}

describe("static impact (free, no model call)", () => {
  it("shows which versions would gain or lose findings under the new rubric, and which stay the same", async () => {
    const oldR = await rubric([rule("eval", "eval\\(")]);
    const newR = await rubric([rule("eval", "eval\\("), rule("net", "fetch\\(")]);
    const snaps = await mkdtemp(join(tmpdir(), "snap-"));
    await saveSnapshot(snaps, oldR);
    const out = await registryWith([
      { v: "1.0.0", code: "console.log(1)", reviewedUnder: oldR.version },                    // nothing in it: same under both
      { v: "1.1.0", code: "fetch('https://x.example')", reviewedUnder: oldR.version },       // the new check now hits
      { v: "1.2.0", code: "eval('1')", reviewedUnder: newR.version },                        // already current
      { v: "1.3.0", code: "console.log(2)" },                                                // never reviewed
      { v: "1.4.0", code: "fetch('x')", reviewedUnder: "default@aaaaaaaaaa" },               // reviewed under a rubric we never saved
    ]);
    const rows = Object.fromEntries((await staticImpact(out, newR, snaps)).map((r) => [r.version, r]));
    expect(rows["1.0.0"].status).toBe("unchanged");
    expect(rows["1.1.0"].status).toBe("changed");
    expect(rows["1.1.0"].newHits).toEqual([{ rule: "net", severity: "high", count: 1 }]);
    expect(rows["1.1.0"].highNow).toBe(1);
    expect(rows["1.2.0"].status).toBe("current");
    expect(rows["1.3.0"].status).toBe("unreviewed");
    expect(rows["1.4.0"].status).toBe("unknown");
  });

  it("a check that no longer hits is reported as gone", async () => {
    const oldR = await rubric([rule("eval", "eval\\("), rule("timer", "setInterval")]);
    const newR = await rubric([rule("eval", "eval\\(")]);
    const snaps = await mkdtemp(join(tmpdir(), "snap-"));
    await saveSnapshot(snaps, oldR);
    const out = await registryWith([{ v: "1.0.0", code: "setInterval(f, 5)", reviewedUnder: oldR.version, verdict: "findings" }]);
    const [row] = await staticImpact(out, newR, snaps);
    expect(row.status).toBe("changed");
    expect(row.goneHits).toEqual([{ rule: "timer", severity: "high", count: 1 }]);
  });

  it("picks re-review targets: only those whose static result moved, or every stale one", async () => {
    const oldR = await rubric([rule("eval", "eval\\(")]);
    const newR = await rubric([rule("eval", "eval\\("), rule("net", "fetch\\(")]);
    const snaps = await mkdtemp(join(tmpdir(), "snap-"));
    await saveSnapshot(snaps, oldR);
    const out = await registryWith([
      { v: "1.0.0", code: "1", reviewedUnder: oldR.version },
      { v: "1.1.0", code: "fetch('x')", reviewedUnder: oldR.version },
      { v: "1.2.0", code: "2", reviewedUnder: newR.version, model: "old-model" },
      { v: "1.3.0", code: "3" },
    ]);
    expect(await staleTargets(out, newR, snaps, "changed")).toEqual([{ id: "demo", version: "1.1.0" }]);
    expect((await staleTargets(out, newR, snaps, "all")).map((t) => t.version).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect((await staleTargets(out, newR, snaps, "all", "new-model")).map((t) => t.version).sort()).toEqual(["1.0.0", "1.1.0", "1.2.0"]); // a model change counts too
  });
});
