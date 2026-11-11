/**
 * Signed documents. A document is a JSON file whose EXACT served bytes are signed (ECDSA P-256 / SHA-256,
 * raw r||s signature, base64) and stored next to it as `<name>.json.sig`. Verify the bytes before parsing.
 * Works in Node >= 20 and in Obsidian (WebCrypto), so the same code is tested under vitest.
 */
export type Verdict = "pass" | "findings" | "fail" | "error";

export interface FileHashes { main: string; manifest: string; styles: string }

/** Admin approval of one exact set of file hashes. */
export interface Approval {
  schema: 1;
  id: string;
  version: string;
  sha256: FileHashes;
  approvedBy: string;
  approvedAt: string;
}

/** Signed record of an automated review. Produced for every reviewed version, whatever the verdict. */
export interface ReviewRecord {
  schema: 1;
  id: string;
  version: string;
  sha256: FileHashes;
  review: {
    type: string;
    model: string;
    rubricVersion: string;
    promptSha256: string;
    scope: string[];
    verdict: Verdict;
    /** Path relative to the version directory; the report is bound by reportSha256. */
    reportPath: string;
    reportSha256: string;
    reviewedAt: string;
    costUsd?: number;
  };
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.trim());
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True only if `sigB64` is a valid signature over exactly `bytes` by the SPKI (base64) public key. */
export async function verifySignature(bytes: BufferSource, sigB64: string, publicKeySpkiB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki", b64ToBytes(publicKeySpkiB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64ToBytes(sigB64), bytes);
  } catch { return false; }
}

export type ApprovalResult = { ok: true; approval: Approval } | { ok: false; reason: string };

/**
 * Decides whether a version may be installed under require-signed mode. `actual` are the hashes of the
 * files the client really downloaded; they must equal the hashes the admin signed.
 */
export async function checkApproval(
  approvalBytes: Uint8Array<ArrayBuffer>, sigB64: string, publicKeySpkiB64: string,
  expect: { id: string; version: string; actual: FileHashes },
): Promise<ApprovalResult> {
  if (!(await verifySignature(approvalBytes, sigB64, publicKeySpkiB64))) return { ok: false, reason: "bad signature" };
  let a: Approval;
  try { a = JSON.parse(new TextDecoder().decode(approvalBytes)) as Approval; } catch { return { ok: false, reason: "unreadable approval" }; }
  if (a?.schema !== 1 || a.id !== expect.id || a.version !== expect.version) return { ok: false, reason: "approval is for a different plugin/version" };
  for (const k of ["main", "manifest", "styles"] as const)
    if (a.sha256?.[k] !== expect.actual[k]) return { ok: false, reason: `${k} differs from what was approved` };
  return { ok: true, approval: a };
}

export type TrustMode = "off" | "warn" | "require-signed";
export interface Signed { bytes: Uint8Array<ArrayBuffer>; sig: string }
export interface Pick<V extends { version: string; sha256: FileHashes }> { entry: V; approved: boolean }

/**
 * Chooses which version to install. `versions` must be newest first. In require-signed mode only a version
 * whose signed approval matches the registry's listed hashes is eligible (and the caller then verifies the
 * downloaded files against those same hashes); with no pinned key nothing is eligible (fail closed).
 */
export async function selectVersion<V extends { version: string; sha256: FileHashes }>(
  id: string, versions: V[], mode: TrustMode, publicKey: string,
  getApproval: (version: string) => Promise<Signed | null>, wanted?: string,
): Promise<{ pick: Pick<V> | null; reason?: string }> {
  const candidates = wanted ? versions.filter((v) => v.version === wanted) : versions;
  if (!candidates.length) return { pick: null, reason: "no such version" };
  if (mode === "off") return { pick: { entry: candidates[0], approved: false } };
  if (!publicKey) return mode === "require-signed" ? { pick: null, reason: "no public key pinned" } : { pick: { entry: candidates[0], approved: false } };
  let lastReason = "no approved version";
  for (const v of candidates) {
    const s = await getApproval(v.version).catch(() => null);
    const r = s ? await checkApproval(s.bytes, s.sig, publicKey, { id, version: v.version, actual: v.sha256 }) : null;
    if (r?.ok) return { pick: { entry: v, approved: true } };
    lastReason = r ? r.reason : "not approved";
    if (mode === "warn") return { pick: { entry: candidates[0], approved: false }, reason: lastReason };
  }
  return { pick: null, reason: lastReason };
}
