import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareSemver, isSafeVersion, isValidPluginId, type VersionEntry } from "@om/shared";
import { qualifies, readPublished, readStaged, type PublishPolicy } from "./catalog";
import { rebuildIndex } from "./sync";

/**
 * Admin actions on a mirrored version. Every one of them only makes clients' view STRICTER or restores a version the
 * publish policy already allows; none of them can create an approval or sign anything.
 *   revoke    remove the approval (approval.json and its signature)
 *   hold      move a published version to staged.json, so clients no longer see it listed
 *   release   move a held-back version back to versions.json, only if the publish policy allows it
 *   withdraw  revoke + hold
 * Already-installed copies on clients are not touched: clients cannot be told to uninstall, and there is no signed
 * revocation list yet (see docs/concepts/security.md).
 */
export type ManageAction = "revoke" | "hold" | "release" | "withdraw";
export const MANAGE_ACTIONS: ManageAction[] = ["revoke", "hold", "release", "withdraw"];

const byNewest = (a: VersionEntry, b: VersionEntry) => compareSemver(b.version, a.version);
const write = (p: string, v: unknown) => writeFile(p, JSON.stringify(v, null, 2));

export async function manageVersion(outDir: string, id: string, version: string, action: ManageAction, policy: PublishPolicy = "all"): Promise<string> {
  if (!isValidPluginId(id) || !isSafeVersion(version)) throw new Error("invalid plugin id or version");
  if (!MANAGE_ACTIONS.includes(action)) throw new Error("unknown action");
  const pdir = join(outDir, "plugins", id), vdir = join(pdir, version);
  const published = await readPublished(pdir), staged = await readStaged(pdir);
  const inPub = published.find((v) => v.version === version), inStaged = staged.find((v) => v.version === version);
  if (!inPub && !inStaged) throw new Error(`${id}@${version} is not in the registry`);
  const done: string[] = [];

  if (action === "revoke" || action === "withdraw") {
    const had = await readFile(join(vdir, "approval.json")).then(() => true, () => false);
    await rm(join(vdir, "approval.json"), { force: true });
    await rm(join(vdir, "approval.json.sig"), { force: true });
    if (had) done.push("approval removed");
    else if (action === "revoke") throw new Error(`${id}@${version} has no approval to revoke`);
  }
  if (action === "hold" || action === "withdraw") {
    if (inPub) {
      await write(join(pdir, "versions.json"), published.filter((v) => v.version !== version));
      await write(join(pdir, "staged.json"), [...staged.filter((v) => v.version !== version), inPub].sort(byNewest));
      done.push("held back from clients");
    } else if (action === "hold") throw new Error(`${id}@${version} is already held back`);
  }
  if (action === "release") {
    if (!inStaged) throw new Error(`${id}@${version} is not held back`);
    if (!(await qualifies(vdir, inStaged, policy))) throw new Error(`${id}@${version} does not satisfy the publish policy "${policy}" (it needs ${policy === "approved" ? "a valid approval" : "a passing review"} first)`);
    await write(join(pdir, "staged.json"), staged.filter((v) => v.version !== version));
    await write(join(pdir, "versions.json"), [...published.filter((v) => v.version !== version), inStaged].sort(byNewest));
    done.push("published to clients");
  }
  await rebuildIndex(outDir, {});
  return `${id}@${version}: ${done.join(", ") || "nothing to change"}`;
}
