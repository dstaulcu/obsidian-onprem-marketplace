import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncRegistry, type Fetcher } from "../src/sync";
import { promoteStaged } from "../src/catalog";

const manifest = (v: string) => JSON.stringify({ id: "demo", name: "Demo", version: v, minAppVersion: "1.5.0", description: "d", author: "a" });
const fetcher: Fetcher = async (url) => {
  if (url.includes("/releases")) return new Response(JSON.stringify([{ tag_name: "1.0.0", draft: false, prerelease: false, published_at: "x",
    assets: ["main.js", "manifest.json"].map((n) => ({ name: n, url: `http://gh/asset/1.0.0/${n}` })) }]));
  return new Response(url.endsWith("manifest.json") ? manifest("1.0.0") : "code");
};

describe("publishPolicy", () => {
  it("holds a version back until it has a passing review, then publishes it", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "reg-"));
    const cfg = { githubApiBase: "http://gh", outDir, publishPolicy: "reviewed-pass" as const, repos: [{ repo: "o/r" }] };
    await syncRegistry(cfg, fetcher);
    const pdir = join(outDir, "plugins", "demo");
    expect(JSON.parse(await readFile(join(outDir, "index.json"), "utf8"))).toEqual([]);   // not visible yet
    expect(JSON.parse(await readFile(join(pdir, "staged.json"), "utf8"))).toHaveLength(1);

    const e = JSON.parse(await readFile(join(pdir, "staged.json"), "utf8"))[0];
    const writeRev = (verdict: string, sha = e.sha256) => writeFile(join(pdir, "1.0.0", "review.json"), JSON.stringify({ sha256: sha, review: { verdict } }));
    await writeRev("findings");
    expect(await promoteStaged(join(outDir, "plugins"), ["demo"], "reviewed-pass")).toEqual([]);
    await writeRev("pass", { ...e.sha256, main: "other" });
    expect(await promoteStaged(join(outDir, "plugins"), ["demo"], "reviewed-pass")).toEqual([]);
    await writeRev("pass");
    expect(await promoteStaged(join(outDir, "plugins"), ["demo"], "reviewed-pass")).toEqual(["demo@1.0.0"]);
    expect(JSON.parse(await readFile(join(pdir, "versions.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(await readFile(join(pdir, "staged.json"), "utf8"))).toHaveLength(0);
  });

  it("default policy publishes immediately", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "reg-"));
    await syncRegistry({ githubApiBase: "http://gh", outDir, repos: [{ repo: "o/r" }] }, fetcher);
    expect(JSON.parse(await readFile(join(outDir, "index.json"), "utf8"))).toHaveLength(1);
  });
});
