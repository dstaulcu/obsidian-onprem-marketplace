import { describe, it, expect } from "vitest";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncRegistry, type Fetcher } from "../src/sync";
import { approveVersion, generateKeys } from "../src/signing";
import { manageVersion } from "../src/manage";

const manifest = (v: string) => JSON.stringify({ id: "demo", name: "Demo", version: v, minAppVersion: "1.5.0", description: "d", author: "a" });
const fetcher: Fetcher = async (url) => {
  if (url.includes("/releases"))
    return new Response(JSON.stringify(["1.1.0", "1.0.0"].map((t) => ({ tag_name: t, draft: false, prerelease: false, published_at: "x",
      assets: ["main.js", "manifest.json"].map((n) => ({ name: n, url: `http://gh/asset/${t}/${n}` })) }))));
  const m = /asset\/(.+)\/(.+)$/.exec(url)!;
  return new Response(m[2] === "manifest.json" ? manifest(m[1]) : `code-${m[1]}`);
};
const exists = (p: string) => access(p).then(() => true, () => false);
const json = async (p: string) => JSON.parse(await readFile(p, "utf8"));

async function setup() {
  const outDir = await mkdtemp(join(tmpdir(), "reg-"));
  await syncRegistry({ githubApiBase: "http://gh", outDir, repos: [{ repo: "o/r" }] }, fetcher);
  const keys = generateKeys();
  await approveVersion(outDir, "demo", "1.1.0", keys.privatePem, "tester", "test");
  const p = (...s: string[]) => join(outDir, "plugins", "demo", ...s);
  return { outDir, keys, p };
}

describe("manageVersion", () => {
  it("withdraw removes the approval, holds the version back and moves the listed latest version down", async () => {
    const { outDir, p } = await setup();
    expect((await json(join(outDir, "index.json")))[0].latestVersion).toBe("1.1.0");
    const msg = await manageVersion(outDir, "demo", "1.1.0", "withdraw");
    expect(msg).toMatch(/approval removed, held back/);
    expect(await exists(p("1.1.0", "approval.json"))).toBe(false);
    expect(await exists(p("1.1.0", "approval.json.sig"))).toBe(false);
    expect((await json(p("versions.json"))).map((v: any) => v.version)).toEqual(["1.0.0"]);
    expect((await json(p("staged.json"))).map((v: any) => v.version)).toEqual(["1.1.0"]);
    expect((await json(join(outDir, "index.json")))[0].latestVersion).toBe("1.0.0");
    expect(await exists(p("1.1.0", "main.js"))).toBe(true); // files stay; only visibility and approval change
  });

  it("withdrawing every version unlists the plugin instead of breaking the index", async () => {
    const { outDir } = await setup();
    await manageVersion(outDir, "demo", "1.1.0", "withdraw");
    await manageVersion(outDir, "demo", "1.0.0", "hold");
    expect(await json(join(outDir, "index.json"))).toEqual([]);
  });

  it("release honours the publish policy: not without an approval when approvals are required, yes once approved", async () => {
    const { outDir, keys, p } = await setup();
    await manageVersion(outDir, "demo", "1.1.0", "withdraw");
    await expect(manageVersion(outDir, "demo", "1.1.0", "release", "approved")).rejects.toThrow(/needs a valid approval/);
    await approveVersion(outDir, "demo", "1.1.0", keys.privatePem, "tester", "again");
    expect(await manageVersion(outDir, "demo", "1.1.0", "release", "approved")).toMatch(/published to clients/);
    expect((await json(p("versions.json"))).map((v: any) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(await json(p("staged.json"))).toEqual([]);
  });

  it("with the default policy a held-back version can be released again", async () => {
    const { outDir, p } = await setup();
    await manageVersion(outDir, "demo", "1.0.0", "hold");
    expect(await manageVersion(outDir, "demo", "1.0.0", "release")).toMatch(/published/);
    expect((await json(p("versions.json"))).map((v: any) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("refuses nonsense: unknown version, bad ids, wrong state, nothing to revoke", async () => {
    const { outDir } = await setup();
    await expect(manageVersion(outDir, "demo", "9.9.9", "hold")).rejects.toThrow(/not in the registry/);
    await expect(manageVersion(outDir, "../demo", "1.0.0", "hold")).rejects.toThrow(/invalid/);
    await expect(manageVersion(outDir, "demo", "../1.0.0", "hold")).rejects.toThrow(/invalid/);
    await expect(manageVersion(outDir, "demo", "1.0.0", "bogus" as any)).rejects.toThrow(/unknown action/);
    await expect(manageVersion(outDir, "demo", "1.0.0", "revoke")).rejects.toThrow(/no approval to revoke/);
    await expect(manageVersion(outDir, "demo", "1.0.0", "release")).rejects.toThrow(/not held back/);
    await manageVersion(outDir, "demo", "1.0.0", "hold");
    await expect(manageVersion(outDir, "demo", "1.0.0", "hold")).rejects.toThrow(/already held back/);
  });

  it("revoke alone removes only the approval", async () => {
    const { outDir, p } = await setup();
    expect(await manageVersion(outDir, "demo", "1.1.0", "revoke")).toMatch(/approval removed/);
    expect(await exists(p("1.1.0", "approval.json"))).toBe(false);
    expect((await json(p("versions.json"))).map((v: any) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });
});
