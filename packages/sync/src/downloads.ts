import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Tools offered for download from the registry's landing page (for example om.exe). They sit in `<registry>/downloads/` next to a
 * `downloads.json` that lists each file with its size and SHA-256, so a person can check what they fetched. This is not a signed
 * channel: a client that has not been bootstrapped cannot verify anything yet, so give people the SHA-256 by a second route too.
 */
export interface Download { name: string; version: string; size: number; sha256: string; published: string; note?: string }
export interface DownloadsFile { schema: 1; files: Download[] }

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

export async function readDownloads(registryDir: string): Promise<DownloadsFile> {
  try {
    const v = JSON.parse(await readFile(join(registryDir, "downloads", "downloads.json"), "utf8")) as DownloadsFile;
    if (v && v.schema === 1 && Array.isArray(v.files)) return v;
  } catch { /* none yet */ }
  return { schema: 1, files: [] };
}

/** Copies `source` into the registry's downloads folder (temp file then rename) and records its hash. */
export async function publishDownload(registryDir: string, source: string, opts: { version: string; name?: string; note?: string; now?: Date }): Promise<Download> {
  const name = opts.name ?? basename(source);
  if (!NAME_RE.test(name) || name === "downloads.json") throw new Error("file name must be letters, digits, dot, dash or underscore (and not downloads.json)");
  if (!VERSION_RE.test(opts.version)) throw new Error("version must be short plain text such as 0.3.0");
  const st = await stat(source);
  if (!st.isFile()) throw new Error(`${source} is not a file`);
  const dir = join(registryDir, "downloads");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  await copyFile(source, tmp);
  const bytes = await readFile(tmp);
  const entry: Download = { name, version: opts.version, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), published: (opts.now ?? new Date()).toISOString(), ...(opts.note ? { note: opts.note.slice(0, 200) } : {}) };
  await rename(tmp, join(dir, name));
  const cur = await readDownloads(registryDir);
  const files = [...cur.files.filter((f) => f.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name));
  const list = join(dir, "downloads.json.tmp");
  await writeFile(list, JSON.stringify({ schema: 1, files }, null, 2));
  await rename(list, join(dir, "downloads.json"));
  return entry;
}
