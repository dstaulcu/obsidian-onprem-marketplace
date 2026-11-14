import { describe, it, expect } from "vitest";
import { checkRepo, isValidRepo } from "../src/nominate";
import type { Fetcher } from "../src/sync";

const mf = (o: Record<string, unknown> = {}) => JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0", minAppVersion: "1.5.0", description: "d", author: "a", ...o });

/** Mock GitHub: one repo with the given releases ({tag, assets, manifest}). */
function gh(releases: { tag: string; assets?: string[]; manifest?: string; draft?: boolean; pre?: boolean }[], status = 200): Fetcher {
  return async (url) => {
    if (url.includes("/releases")) {
      if (status !== 200) return new Response("{}", { status });
      return new Response(JSON.stringify(releases.map((r) => ({
        tag_name: r.tag, draft: !!r.draft, prerelease: !!r.pre,
        assets: (r.assets ?? ["main.js", "manifest.json"]).map((n) => ({ name: n, url: `http://gh/a/${r.tag}/${n}` })),
      }))));
    }
    const m = /a\/([^/]+)\/manifest[.]json$/.exec(url);
    const rel = releases.find((r) => r.tag === m?.[1]);
    return new Response(rel?.manifest ?? mf({ version: rel?.tag.replace(/^v/, "") }));
  };
}

describe("repository names", () => {
  it("accepts owner/name and refuses anything else", () => {
    for (const ok of ["acme/plugin", "a/b", "Acme-Co/my_plugin.v2"]) expect(isValidRepo(ok)).toBe(true);
    for (const bad of ["", "acme", "acme/", "/x", "a/b/c", "a b/c", "a/../b", "../x", "a/..", "a/b?x=1", "https://github.com/a/b", "a/b#c", 5, null]) expect(isValidRepo(bad as any)).toBe(false);
  });
});

describe("checkRepo", () => {
  it("accepts a repo whose release sync would take", async () => {
    const c = await checkRepo("http://gh/api", gh([{ tag: "1.0.0" }]), "o/r");
    expect(c.ok).toBe(true);
    expect(c.summary).toMatch(/Looks good: Demo \(demo\), latest 1.0.0/);
  });
  it("explains each way a release would be refused", async () => {
    expect((await checkRepo("http://gh/api", gh([{ tag: "1.0.0", assets: ["manifest.json"] }]), "o/r")).summary).toMatch(/no main.js/);
    expect((await checkRepo("http://gh/api", gh([{ tag: "2.0.0", manifest: mf({ version: "1.0.0" }) }]), "o/r")).summary).toMatch(/does not match the manifest version/);
    expect((await checkRepo("http://gh/api", gh([{ tag: "1.0.0", manifest: "not json" }]), "o/r")).ok).toBe(false);
    expect((await checkRepo("http://gh/api", gh([{ tag: "1.0.0", manifest: mf({ id: "../evil" }) }]), "o/r")).ok).toBe(false);
    expect((await checkRepo("http://gh/api", gh([{ tag: "1.0.0", draft: true }, { tag: "1.1.0", pre: true }]), "o/r")).summary).toMatch(/no published release/);
  });
  it("reports GitHub problems plainly", async () => {
    expect((await checkRepo("http://gh/api", gh([], 404), "o/r")).summary).toMatch(/does not know this repository/);
    expect((await checkRepo("http://gh/api", gh([], 500), "o/r")).summary).toMatch(/HTTP 500/);
    expect((await checkRepo("http://gh/api", async () => { throw new Error("offline"); }, "o/r")).summary).toMatch(/Could not reach GitHub: offline/);
    expect((await checkRepo("http://gh/api", gh([]), "not a repo")).ok).toBe(false);
  });
  it("refuses a plugin id that another repository already provides", async () => {
    const c = await checkRepo("http://gh/api", gh([{ tag: "1.0.0" }]), "evil/fork", { demo: "acme/demo" });
    expect(c.ok).toBe(false);
    expect(c.conflicts).toEqual(["demo is already provided by acme/demo"]);
    expect((await checkRepo("http://gh/api", gh([{ tag: "1.0.0" }]), "ACME/demo", { demo: "acme/demo" })).ok).toBe(true); // the same repository
  });
  it("does not read an oversized manifest", async () => {
    const c = await checkRepo("http://gh/api", gh([{ tag: "1.0.0", manifest: mf({ description: "x".repeat(200_000) }) }]), "o/r");
    expect(c.ok).toBe(false); expect(c.summary).toMatch(/unreasonably large/);
  });
});
