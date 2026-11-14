import { join } from "node:path";
import type { Transport } from "@om/shared";

const MAX_KEY_BYTES = 1024;

/** SHA-256 of the key's DER bytes, as lowercase hex. This is what an admin can read out or publish elsewhere to confirm a key. */
export async function keyFingerprint(spkiB64: string): Promise<string> {
  const bin = atob(spkiB64.trim());
  const der = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Groups a fingerprint for reading aloud: eight groups of eight characters per line pair. */
export function showFingerprint(hex: string): string {
  return (hex.match(/.{1,8}/g) ?? []).join(" ");
}

/** True only for a base64 SPKI ECDSA P-256 key, the one kind of key the marketplace signs with. */
export async function isValidKey(spkiB64: string): Promise<boolean> {
  try {
    const bin = atob(spkiB64.trim());
    const der = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return true;
  } catch { return false; }
}

/** Where a registry publishes its public key: <base>/public-key.txt (a local registry folder works too). */
export function keyLocation(registry: string): string {
  return /^https?:\/\//i.test(registry) ? registry.replace(/\/+$/, "") + "/public-key.txt" : join(registry, "public-key.txt");
}

/**
 * Fetches the registry's public key. The result is untrusted until the user has pinned it: it is size-limited and must
 * parse as a P-256 key, but whoever answers this request chooses the key, so it is only ever fetched on an explicit
 * `om init` and never replaces a key that is already saved unless the user asks.
 */
export async function fetchPublicKey(registry: string, t: Transport): Promise<{ key: string; from: string; fingerprint: string }> {
  const from = keyLocation(registry);
  const bytes = await t.get(from);
  if (bytes.length > MAX_KEY_BYTES) throw new Error(`${from} is too large to be a public key`);
  const key = new TextDecoder().decode(bytes).trim();
  if (!(await isValidKey(key))) throw new Error(`${from} does not contain a valid public key`);
  return { key, from, fingerprint: await keyFingerprint(key) };
}
