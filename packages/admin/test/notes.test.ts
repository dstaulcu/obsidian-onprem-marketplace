import { describe, it, expect } from "vitest";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES, MAX_REF, MAX_TEXT, NoteError, NoteStore } from "../src/notes";

const store = async () => { const dir = await mkdtemp(join(tmpdir(), "notes-")); const file = join(dir, "state", "notes.jsonl"); return { file, s: new NoteStore(file) }; };

describe("triage notes", () => {
  it("appends plain-text notes with author and time, and lists them in order", async () => {
    const { s, file } = await store();
    const a = await s.add("alice", "demo", "1.0.0", "waiting on the maintainer", "SEC-123");
    await s.add("bob", "demo", "1.0.0", "asked security");
    const all = await s.list();
    expect(all.map((n) => n.text)).toEqual(["waiting on the maintainer", "asked security"]);
    expect(a).toMatchObject({ plugin: "demo", version: "1.0.0", by: "alice", ref: "SEC-123" });
    expect(Date.parse(a.at)).not.toBeNaN();
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2); // one JSON object per line, easy to read from outside
  });

  it("rejects bad targets and bad text, and cleans control characters", async () => {
    const { s } = await store();
    await expect(s.add("a", "../x", "1.0.0", "t")).rejects.toBeInstanceOf(NoteError);
    await expect(s.add("a", "demo", "../1", "t")).rejects.toBeInstanceOf(NoteError);
    await expect(s.add("a", "demo", "1.0.0", "   ")).rejects.toThrow(/needs text/);
    await expect(s.add("a", "demo", "1.0.0", 42)).rejects.toThrow(/needs text/);
    await expect(s.add("a", "demo", "1.0.0", "x".repeat(MAX_TEXT + 1))).rejects.toThrow(/at most/);
    const n = await s.add("a", "demo", "1.0.0", "ok\u0000\u001b[31m text\r\nline two", "ref\nwith\tbreaks" + "z".repeat(300));
    expect(n.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(n.text).toContain("line two");
    expect(n.ref!.length).toBeLessThanOrEqual(MAX_REF);
    expect(n.ref).not.toMatch(/[\n\t]/);
  });

  it("a damaged line does not hide the others, and a full file stops accepting notes", async () => {
    const { s, file } = await store();
    await s.add("a", "demo", "1.0.0", "first");
    await appendFile(file, "this is not json\n");
    await s.add("a", "demo", "1.0.0", "second");
    expect((await s.list()).map((n) => n.text)).toEqual(["first", "second"]);
    await writeFile(file, "x".repeat(MAX_FILE_BYTES + 1));
    await expect(s.add("a", "demo", "1.0.0", "more")).rejects.toThrow(/full/);
  });

  it("an empty store lists nothing", async () => {
    const { s } = await store();
    expect(await s.list()).toEqual([]);
  });
});
