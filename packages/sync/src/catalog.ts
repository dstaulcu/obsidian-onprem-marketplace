import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareSemver, type ReviewRecord, type Approval, type VersionEntry } from "@om/shared";

/**
 * Which mirrored versions clients can see.
 *   all           every mirrored version is published immediately (default)
 *   reviewed-pass held back (staged) until a review record with verdict "pass" matches its hashes
 *   approved      held back until an admin approval matches its hashes
 * Published entries live in plugins/<id>/versions.json (what clients fetch); held-back entries live in
 * plugins/<id>/staged.json, which is never served to clients that only read versions.json.
 */
export type PublishPolicy = "all" | "reviewed-pass" | "approved";

const exists = (p: string) => access(p).then(() => true, () => false);
const readList = async (p: string): Promise<VersionEntry[]> => ((await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : []);
const byNewest = (a: VersionEntry, b: VersionEntry) => compareSemver(b.version, a.version);

export async function readPublished(pdir: string) { return readList(join(pdir, "versions.json")); }
export async function readStaged(pdir: string) { return readList(join(pdir, "staged.json")); }

/** Looks in both lists: reviews and approvals apply to staged versions too. */
export async function findEntry(pdir: string, version: string): Promise<VersionEntry | undefined> {
  return [...(await readPublished(pdir)), ...(await readStaged(pdir))].find((v) => v.version === version);
}

export async function addEntry(pdir: string, entry: VersionEntry, policy: PublishPolicy): Promise<void> {
  const file = join(pdir, policy === "all" ? "versions.json" : "staged.json");
  const list = (await readList(file)).filter((v) => v.version !== entry.version);
  list.push(entry);
  list.sort(byNewest);
  await writeFile(file, JSON.stringify(list, null, 2));
}

async function qualifies(vdir: string, e: VersionEntry, policy: PublishPolicy): Promise<boolean> {
  const same = (h: { main: string; manifest: string; styles: string }) =>
    h.main === e.sha256.main && h.manifest === e.sha256.manifest && h.styles === e.sha256.styles;
  try {
    if (policy === "approved") return same((JSON.parse(await readFile(join(vdir, "approval.json"), "utf8")) as Approval).sha256);
    if (policy === "reviewed-pass") {
      const r = JSON.parse(await readFile(join(vdir, "review.json"), "utf8")) as ReviewRecord;
      return same(r.sha256) && r.review.verdict === "pass";
    }
  } catch { return false; }
  return true;
}

/** Moves staged versions that now satisfy the policy into versions.json. Returns "id@version" labels. */
export async function promoteStaged(pluginsDir: string, ids: string[], policy: PublishPolicy): Promise<string[]> {
  if (policy === "all") return [];
  const promoted: string[] = [];
  for (const id of ids) {
    const pdir = join(pluginsDir, id);
    const staged = await readStaged(pdir);
    if (!staged.length) continue;
    const keep: VersionEntry[] = [];
    const published = await readPublished(pdir);
    for (const e of staged) {
      if (await qualifies(join(pdir, e.version), e, policy)) { published.push(e); promoted.push(`${id}@${e.version}`); }
      else keep.push(e);
    }
    if (keep.length !== staged.length) {
      published.sort(byNewest);
      await writeFile(join(pdir, "versions.json"), JSON.stringify(published, null, 2));
      await writeFile(join(pdir, "staged.json"), JSON.stringify(keep, null, 2));
    }
  }
  return promoted;
}
