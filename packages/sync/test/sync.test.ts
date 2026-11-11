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
