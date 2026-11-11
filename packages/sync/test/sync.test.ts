import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncRegistry, type Fetcher } from "../src/sync";

const manifest = (v: string) =>
  JSON.stringify({ id: "demo", name: "Demo", version: v, minAppVersion: "1.5.0", description: "d", author: "a" });

function mock(tags: string[], manifestVer: (t: string) => string = (t) => t): Fetcher {
  return async (url) => {
    const base = "http://gh/api";
    if (url.startsWith(`${base}/repos/o/r/releases`))
      return new Response(JSON.stringify(tags.map((t) => ({
        tag_name: t, draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z",
        assets: ["main.js", "manifest.json"].map((n) => ({ name: n, url: `http://gh/asset/${t}/${n}` })),
      }))));
    const m = /asset\/(.+)\/(.+)$/.exec(url)!;
    return new Response(m[2] === "manifest.json" ? manifest(manifestVer(m[1])) : `code-${m[1]}`);
  };
}

describe("sync", () => {
  it("adds versions, is idempotent, builds index", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "reg-"));
    const cfg = { githubApiBase: "http://gh/api", outDir, repos: [{ repo: "o/r" }] };
    const r1 = await syncRegistry(cfg, mock(["1.0.0", "1.1.0"]));
    expect(r1.added).toHaveLength(2);
    const r2 = await syncRegistry(cfg, mock(["1.0.0", "1.1.0"]));
    expect(r2.added).toHaveLength(0);
    expect(r2.skipped).toHaveLength(2);
    const idx = JSON.parse(await readFile(join(outDir, "index.json"), "utf8"));
    expect(idx[0].latestVersion).toBe("1.1.0");
    expect(idx[0].repo).toBe("o/r");
  });

  it("rejects tag/manifest mismatch", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "reg-"));
    const r = await syncRegistry(
      { githubApiBase: "http://gh/api", outDir, repos: [{ repo: "o/r" }] },
      mock(["2.0.0"], () => "1.0.0"),
    );
    expect(r.errors[0]).toMatch(/!=/);
  });
});

import { isSafeVersion, isValidPluginId, validateManifest } from "@om/shared";

describe("shared path-safety validation", () => {
  it("rejects traversal-capable ids", () => {
    for (const id of ["../x", "a/b", "a\b", "..", ".hidden", "", "A"]) expect(isValidPluginId(id)).toBe(false);
    expect(isValidPluginId("my-plugin_2")).toBe(true);
  });
  it("rejects traversal-capable versions", () => {
    for (const v of ["1.0.0/../../x", "1.0.0-a/b", "../1.0.0", "1.0"]) expect(isSafeVersion(v)).toBe(false);
    expect(isSafeVersion("1.2.3")).toBe(true);
    expect(isSafeVersion("1.2.3-beta.1")).toBe(true);
  });
  it("validateManifest flags them", () => {
    const m = { id: "../x", name: "n", version: "1.0.0/..", minAppVersion: "1.0.0", description: "d", author: "a" };
    expect(validateManifest(m)).toEqual(expect.arrayContaining(["invalid id", "version not x.y.z"]));
  });
});

describe("sync limits", () => {
  it("maxVersions mirrors only the newest N releases", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "reg-"));
    const r = await syncRegistry({ githubApiBase: "http://gh/api", outDir, maxVersions: 1, repos: [{ repo: "o/r" }] },
      mock(["1.1.0", "1.0.0"]));
    expect(r.added).toEqual(["o/r@1.1.0"]);
  });
  it("stops the whole run on a rate limit instead of hammering", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "reg-"));
    let calls = 0;
    const f: Fetcher = async () => { calls++; return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }); };
    const r = await syncRegistry({ githubApiBase: "http://gh/api", outDir, repos: [{ repo: "a/a" }, { repo: "b/b" }] }, f);
    expect(calls).toBe(1);
    expect(r.errors[0]).toMatch(/rate limit/);
  });
});
