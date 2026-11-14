import { isCanonical } from "@om/sync/src/sources";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkApproval, checkReview, isValidPluginId, isSafeVersion, type VersionEntry } from "@om/shared";
import { readPublished, readStaged } from "@om/sync/src/catalog";
import { readdir } from "node:fs/promises";

export interface VersionState {
  version: string; published: string; staged: boolean;
  review: { verdict: string; signed: boolean; valid: boolean | null; /** which rubric version the review was made under */ rubricVersion: string | null; model: string | null } | null;
  approval: { ok: boolean; reason?: string; by?: string; override?: string } | null;
}
export interface PluginState { id: string; /** owner/repo the plugin was mirrored from, shape-checked; empty if unknown */ repo: string; versions: VersionState[] }

const read = (p: string) => readFile(p).then((b) => new Uint8Array(b) as Uint8Array<ArrayBuffer>, () => null);

/**
 * Read-only view of the registry folder. Approval and review signatures are verified with the PUBLIC key only;
 * without one, signed records are reported as unverified rather than trusted. The folder holds data mirrored from
 * third-party repos, so every string here is untrusted and the UI must render it as text.
 */
/** id -> owner/repo from index.json. It is data from the registry folder, so it is shape-checked before anyone builds a link from it. */
async function readRepos(outDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (const e of JSON.parse(await readFile(join(outDir, "index.json"), "utf8")) as { id?: unknown; repo?: unknown }[])
      if (typeof e.id === "string" && typeof e.repo === "string" && isCanonical(e.repo)) out[e.id] = e.repo;
  } catch { /* no index yet */ }
  return out;
}

export async function registryState(outDir: string, publicKey: string): Promise<PluginState[]> {
  let ids: string[] = [];
  try { ids = await readdir(join(outDir, "plugins")); } catch { return []; }
  const out: PluginState[] = [];
  const repos = await readRepos(outDir);
  for (const id of ids.filter(isValidPluginId).sort()) {
    const pdir = join(outDir, "plugins", id);
    const entries: [VersionEntry, boolean][] = [...(await readPublished(pdir)).map((v) => [v, false] as [VersionEntry, boolean]), ...(await readStaged(pdir)).map((v) => [v, true] as [VersionEntry, boolean])];
    const versions: VersionState[] = [];
    for (const [v, staged] of entries) {
      if (!isSafeVersion(v.version)) continue;
      const vdir = join(pdir, v.version);
      const ctx = { id, version: v.version, actual: v.sha256 };

      let review: VersionState["review"] = null;
      const rb = await read(join(vdir, "review.json"));
      if (rb) {
        let verdict = "unknown", rubricVersion: string | null = null, model: string | null = null;
        try {
          const r = JSON.parse(new TextDecoder().decode(rb))?.review;
          verdict = String(r?.verdict ?? "unknown");
          if (typeof r?.rubricVersion === "string") rubricVersion = r.rubricVersion.slice(0, 60);
          if (typeof r?.model === "string") model = r.model.slice(0, 60);
        } catch { /* keep unknown */ }
        const rs = await readFile(join(vdir, "review.json.sig"), "utf8").catch(() => null);
        const valid = rs && publicKey ? (await checkReview(rb, rs.trim(), publicKey, ctx)).ok : null;
        review = { verdict, signed: rs !== null, valid, rubricVersion, model };
      }

      let approval: VersionState["approval"] = null;
      const ab = await read(join(vdir, "approval.json"));
      const as = await readFile(join(vdir, "approval.json.sig"), "utf8").catch(() => null);
      if (ab && as !== null) {
        if (!publicKey) approval = { ok: false, reason: "no public key configured to verify" };
        else {
          const r = await checkApproval(ab, as.trim(), publicKey, ctx);
          approval = r.ok ? { ok: true, by: r.approval.approvedBy, override: r.approval.override } : { ok: false, reason: r.reason };
        }
      }
      versions.push({ version: v.version, published: v.published, staged, review, approval });
    }
    out.push({ id, repo: repos[id] ?? "", versions });
  }
  return out;
}
