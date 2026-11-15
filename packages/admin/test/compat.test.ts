import { describe, it, expect } from "vitest";
import { compatibility } from "../src/views";

const now = Date.parse("2026-11-15T12:00:00Z");
const client = (version: string | undefined, last = "2026-11-14T00:00:00Z", kind = "obsidian") => ({ key: version + last, first: last, last, kind, version, ua: "u", addr: "a", checks: 0, plugins: {} });
const ok = { ok: true, by: "t" };
const state = [{ id: "demo", repo: "", versions: [
  { version: "2.0.0", published: "x", staged: false, minAppVersion: "1.8.0", review: null, approval: ok },
  { version: "1.5.0", published: "x", staged: false, minAppVersion: "1.5.0", review: null, approval: ok },
  { version: "1.4.0", published: "x", staged: false, minAppVersion: "1.2.0", review: null, approval: ok }] }];

describe("compatibility with Obsidian versions", () => {
  it("counts clients that cannot run the newest release and names the newest release they can run", () => {
    const r = compatibility([client("1.9.0"), client("1.6.2"), client("1.4.0")] as never, state as never, now);
    expect(r.compat).toEqual([{ id: "demo", latest: "2.0.0", needs: "1.8.0", obsidianClients: 3, stranded: 2, oldest: "1.4.0", fallback: "1.4.0" }]);
    expect(r.obsidianVersions.map((o) => o.version)).toEqual(["1.9.0", "1.6.2", "1.4.0"]);
  });

  it("has no fallback when no approved release runs on the oldest client, and needs approval to count", () => {
    const unapproved = [{ id: "demo", repo: "", versions: [
      { version: "2.0.0", published: "x", staged: false, minAppVersion: "1.8.0", review: null, approval: ok },
      { version: "1.5.0", published: "x", staged: false, minAppVersion: "1.5.0", review: null, approval: null }] }];
    expect(compatibility([client("1.4.0")] as never, unapproved as never, now).compat[0].fallback).toBeNull();
  });

  it("is quiet when everyone can run it, and ignores held-back releases, old sightings, om and unparseable versions", () => {
    const held = [{ id: "demo", repo: "", versions: [{ version: "3.0.0", published: "x", staged: true, minAppVersion: "9.0.0", review: null, approval: null }, ...state[0].versions] }];
    const rows = [client("1.9.0"), client("1.0.0", "2026-01-01T00:00:00Z"), client("1.0.0", "2026-11-14T00:00:00Z", "om"), client("garbage"), client(undefined)];
    const r = compatibility(rows as never, held as never, now);
    expect(r.compat[0]).toMatchObject({ latest: "2.0.0", stranded: 0, obsidianClients: 1, fallback: "2.0.0" });
  });

  it("returns nothing when no Obsidian client with a known version has been seen", () => {
    expect(compatibility([client(undefined)] as never, state as never, now)).toEqual({ compat: [], obsidianVersions: [] });
  });
});
