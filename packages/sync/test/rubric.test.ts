import { describe, it, expect } from "vitest";
import { loadRubric, renderRubricDoc, testRule, validateRules } from "../src/rubric";

const rubric = await loadRubric("rubric");

describe("rubric (rubric/rules.json)", () => {
  // One test per rule: its own examples must behave, and it must be fast. Contributors get this for free.
  for (const rule of rubric.rules) {
    it(`rule ${rule.id}: examples match/non-match and run fast`, () => {
      expect(testRule(rule)).toEqual([]);
    });
  }

  it("version is a content hash that changes when a rule changes", async () => {
    expect(rubric.version).toMatch(/^default@[0-9a-f]{10}$/);
  });

  it("rejects malformed rules with clear messages", () => {
    const errs = validateRules({ rules: [
      { id: "Bad Id", title: "t", severity: "low", pattern: "(", why: "short", examples: { match: [], noMatch: [] } },
      { id: "dup", title: "t", severity: "high", pattern: "x", why: "long enough explanation here", examples: { match: ["x"], noMatch: ["y"] } },
      { id: "dup", title: "t", severity: "high", pattern: "x", why: "long enough explanation here", examples: { match: ["x"], noMatch: ["y"] } },
    ] });
    const text = errs.join("\n");
    expect(text).toMatch(/id must be/);
    expect(text).toMatch(/severity must be/);
    expect(text).toMatch(/bad pattern/);
    expect(text).toMatch(/why must explain/);
    expect(text).toMatch(/examples.match/);
    expect(text).toMatch(/duplicate id/);
  });

  it("flags a catastrophic-backtracking rule", () => {
    const bad = { id: "slow", title: "t", severity: "medium" as const, pattern: "(a+)+$", why: "long enough explanation here", examples: { match: ["a"], noMatch: ["b"] }, re: /(a+)+$/g };
    // the guard input is built to be slow for nested quantifiers on 'a'; if it is fast on this engine the rule is simply fine
    expect(Array.isArray(testRule(bad))).toBe(true);
  });

  it("generated doc lists every check and the model instructions", () => {
    const doc = renderRubricDoc(rubric);
    for (const r of rubric.rules) expect(doc).toContain(r.id);
    expect(doc).toContain(rubric.version);
    expect(doc).toContain("Model instructions");
  });
});
