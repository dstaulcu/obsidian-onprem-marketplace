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
