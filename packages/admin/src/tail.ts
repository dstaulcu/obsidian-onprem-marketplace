import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * `head` is the first bytes of the file (base64, up to 64) as of the last read. It catches what inode and size cannot:
 * a log truncated in place that has regrown past the old offset, or replaced by a new file reusing the inode.
 */
export interface Cursor { ino: number; offset: number; head?: string }
export interface Line { text: string; /** byte offset of the start of this line in the file */ offset: number }

const HEAD = 64;
async function headOf(fh: FileHandle, n: number): Promise<Buffer> {
  const b = Buffer.alloc(n);
  const { bytesRead } = n > 0 ? await fh.read(b, 0, n, 0) : { bytesRead: 0 };
  return b.subarray(0, bytesRead);
}

/**
 * Reads complete lines appended to a file since a cursor. Only whole lines are returned: a partial trailing line
 * (the writer is mid-append) stays unread until its newline arrives. A changed inode (rotation), a file smaller than
 * the cursor (truncate/copytruncate) or different leading bytes restarts from the beginning of the new content.
 * Lines left in a rotated-away file after the last read are lost; rotate with a short delay or use copytruncate to keep
 * that window small.
 */
export async function readNewLines(file: string, cur: Cursor | null, opts: { maxBytes?: number; startAtEnd?: boolean } = {}): Promise<{ lines: Line[]; next: Cursor } | null> {
  let fh: FileHandle;
  try { fh = await open(file, "r"); } catch { return null; }
  try {
    const st = await fh.stat();
    const ino = Number(st.ino);
    let offset = cur?.offset ?? 0;
    if (!cur) offset = opts.startAtEnd ? st.size : 0;
    else if (cur.ino !== ino || st.size < cur.offset) offset = 0;
    else if (cur.head) {
      const want = Buffer.from(cur.head, "base64");
      if (!(await headOf(fh, want.length)).equals(want)) offset = 0;
    }
    const finish = async (lines: Line[], end: number) => ({ lines, next: { ino, offset: end, head: (await headOf(fh, Math.min(HEAD, end))).toString("base64") } as Cursor });
    if (st.size <= offset) return finish([], offset);
    const len = Math.min(st.size - offset, opts.maxBytes ?? 1_000_000);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    const chunk = buf.subarray(0, bytesRead);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) return finish([], offset);
    const lines: Line[] = [];
    let start = 0;
    for (let i = 0; i <= lastNl; i++) {
      if (chunk[i] !== 0x0a) continue;
      const text = chunk.subarray(start, i).toString("utf8").replace(/\r$/, "");
      if (text) lines.push({ text, offset: offset + start });
      start = i + 1;
    }
    return finish(lines, offset + lastNl + 1);
  } finally { await fh.close(); }
}

/** JSON state file written atomically (temp + rename), so a crash never leaves a torn file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}
export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}
