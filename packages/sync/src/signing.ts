import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isSafeVersion, isValidPluginId, type Approval, type FileHashes, type VersionEntry } from "@om/shared";

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
export async function approveVersion(outDir: string, id: string, version: string, privatePem: string, by: string): Promise<Approval> {
  if (!isValidPluginId(id) || !isSafeVersion(version)) throw new Error("invalid id or version");
  const pdir = join(outDir, "plugins", id);
  const versions: VersionEntry[] = JSON.parse(await readFile(join(pdir, "versions.json"), "utf8"));
  const v = versions.find((x) => x.version === version);
  if (!v) throw new Error(`${id}@${version} is not in the registry`);
  const vdir = join(pdir, version);
  const actual: FileHashes = {
    main: sha(await readFile(join(vdir, "main.js"))),
    manifest: sha(await readFile(join(vdir, "manifest.json"))),
    styles: (await exists(join(vdir, "styles.css"))) ? sha(await readFile(join(vdir, "styles.css"))) : "",
  };
  for (const k of ["main", "manifest", "styles"] as const)
    if (actual[k] !== v.sha256[k]) throw new Error(`${k} on disk does not match versions.json; refusing to approve`);
  const approval: Approval = { schema: 1, id, version, sha256: actual, approvedBy: by, approvedAt: new Date().toISOString() };
  const bytes = Buffer.from(JSON.stringify(approval, null, 2), "utf8");
  await mkdir(vdir, { recursive: true });
  await writeFile(join(vdir, "approval.json"), bytes);
  await writeFile(join(vdir, "approval.json.sig"), signBytes(privatePem, bytes));
  return approval;
}
