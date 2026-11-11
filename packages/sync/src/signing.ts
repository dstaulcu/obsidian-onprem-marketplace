import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isSafeVersion, isValidPluginId, type Approval, type FileHashes, type ReviewRecord } from "@om/shared";
import { findEntry } from "./catalog";

export function generateKeys(): { privatePem: string; publicSpkiB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicSpkiB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Raw r||s (IEEE P1363) so the signature verifies with WebCrypto in Obsidian. */
export function signBytes(privatePem: string, bytes: Uint8Array): string {
  const s = createSign("SHA256");
  s.update(bytes);
  return s.sign({ key: privatePem, dsaEncoding: "ieee-p1363" }).toString("base64");
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const exists = (p: string) => access(p).then(() => true, () => false);

/** Writes plugins/<id>/<version>/approval.json + .sig after re-checking files on disk against versions.json. */
/**
 * Refuses unless a review record matching these exact files has verdict "pass". `override` (a stated reason) allows
 * approving anyway and is recorded in the signed approval.
 */
export async function approveVersion(outDir: string, id: string, version: string, privatePem: string, by: string, override?: string): Promise<Approval> {
  if (!isValidPluginId(id) || !isSafeVersion(version)) throw new Error("invalid id or version");
  const pdir = join(outDir, "plugins", id);
  const v = await findEntry(pdir, version);
  if (!v) throw new Error(`${id}@${version} is not in the registry`);
  const vdir = join(pdir, version);
  const actual: FileHashes = {
    main: sha(await readFile(join(vdir, "main.js"))),
    manifest: sha(await readFile(join(vdir, "manifest.json"))),
    styles: (await exists(join(vdir, "styles.css"))) ? sha(await readFile(join(vdir, "styles.css"))) : "",
  };
  for (const k of ["main", "manifest", "styles"] as const)
    if (actual[k] !== v.sha256[k]) throw new Error(`${k} on disk does not match versions.json; refusing to approve`);
  let reviewVerdict: Approval["reviewVerdict"] = "none";
  try {
    const rec = JSON.parse(await readFile(join(vdir, "review.json"), "utf8")) as ReviewRecord;
    if (["main", "manifest", "styles"].every((k) => rec.sha256[k as keyof FileHashes] === actual[k as keyof FileHashes])) reviewVerdict = rec.review.verdict;
  } catch { /* no usable review */ }
  if (reviewVerdict !== "pass" && !override?.trim())
    throw new Error(`no passing review for ${id}@${version} (${reviewVerdict}); run the review, or pass --override "<reason>" to approve anyway`);
  const approval: Approval = {
    schema: 1, id, version, sha256: actual, approvedBy: by, approvedAt: new Date().toISOString(), reviewVerdict,
    ...(reviewVerdict !== "pass" ? { override: override!.trim() } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(approval, null, 2), "utf8");
  await mkdir(vdir, { recursive: true });
  await writeFile(join(vdir, "approval.json"), bytes);
  await writeFile(join(vdir, "approval.json.sig"), signBytes(privatePem, bytes));
  return approval;
}
