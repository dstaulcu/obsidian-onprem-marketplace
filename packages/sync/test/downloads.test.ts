import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishDownload, readDownloads } from "../src/downloads";

describe("downloads", () => {
  it("copies a file in, records its size and hash, and replaces an older version of the same name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-dl-"));
    const reg = join(dir, "registry"); await mkdir(reg);
    const src = join(dir, "om.exe"); await writeFile(src, "binary-one");
    const e = await publishDownload(reg, src, { version: "0.2.0", note: "Windows x64" });
    expect(e).toMatchObject({ name: "om.exe", version: "0.2.0", size: 10, sha256: createHash("sha256").update("binary-one").digest("hex") });
    expect(await readFile(join(reg, "downloads", "om.exe"), "utf8")).toBe("binary-one");

    await writeFile(src, "binary-two!");
    await publishDownload(reg, src, { version: "0.3.0" });
    await publishDownload(reg, src, { version: "1", name: "other.zip" });
    const list = await readDownloads(reg);
    expect(list.files.map((f) => `${f.name}@${f.version}`)).toEqual(["om.exe@0.3.0", "other.zip@1"]);
    expect((await readdir(join(reg, "downloads"))).sort()).toEqual(["downloads.json", "om.exe", "other.zip"]); // no temp files left
  });

  it("refuses unsafe names and versions, and a missing source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-dl-"));
    const src = join(dir, "x.bin"); await writeFile(src, "x");
    for (const name of ["../evil", "a b", "downloads.json", ".hidden", "x/y", ""]) await expect(publishDownload(dir, src, { version: "1", name })).rejects.toThrow();
    for (const version of ["", "1 2", "<b>", "x".repeat(50)]) await expect(publishDownload(dir, src, { version })).rejects.toThrow();
    await expect(publishDownload(dir, join(dir, "missing"), { version: "1" })).rejects.toThrow();
    expect((await readDownloads(dir)).files).toEqual([]);
  });
});

describe("landing page script", () => {
  it("is valid JavaScript", async () => {
    const src = await readFile(join(__dirname, "..", "..", "..", "deploy", "landing", "landing.js"), "utf8");
    expect(() => new Function(src)).not.toThrow();
    const cfg = JSON.parse(await readFile(join(__dirname, "..", "..", "..", "deploy", "landing", "landing.json"), "utf8"));
    expect(cfg.pinned).toContain("onprem-marketplace");
  });
});
