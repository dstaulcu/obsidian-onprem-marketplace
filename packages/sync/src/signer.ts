import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isSafeVersion, isValidPluginId } from "@om/shared";
import { buildApproval } from "./signing";
import { clip, HEARTBEAT_STALE_MS, queueCall, queueReady, type CallOpts, type Fields } from "./workqueue";

/**
 * The signer: the ONLY process that holds the registry signing key. It runs in its own container, has no network ports, sees
 * the registry read-only, and answers requests from the admin through the work queue (workqueue.ts).
 *
 * What the signer decides for itself, whatever the admin says: it re-reads the plugin files from the registry and recomputes
 * their hashes, refuses unless a review matching exactly those files passed (or an override reason is given, which is recorded
 * inside the signed approval), and rate limits itself. It cannot be asked to sign arbitrary bytes, only an approval of a
 * version that is in the registry. The `by` name comes from the admin; every request is also logged here, outside the admin's
 * reach, so a compromised admin cannot erase the record of what was signed.
 *
 * The admin verifies the returned signature with the PUBLIC key before it writes anything into the registry.
 */
export const MAX_OVERRIDE = 300;
export const SIGNS_PER_MINUTE = 30;

/** Loads the private key from a file (a mounted secret) or, failing that, the OM_SIGNING_KEY environment variable. */
export async function loadSigningKey(file: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<{ privatePem: string; publicSpkiB64: string }> {
  let pem = file ? await readFile(file, "utf8") : env.OM_SIGNING_KEY;
  if (!pem?.trim()) throw new Error("no signing key: mount it as a file (--key-file) or set OM_SIGNING_KEY");
  pem = pem.trim() + "\n";
  let publicSpkiB64: string;
  try { publicSpkiB64 = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64"); }
  catch { throw new Error("the signing key is not a valid PEM private key"); }
  return { privatePem: pem, publicSpkiB64 };
}

/** The request handler the signer worker runs. `registryDir` is mounted read-only. */
export function signerHandler(registryDir: string, privatePem: string, log: (line: string) => void, now: () => number = Date.now) {
  const recent: number[] = [];
  return async (req: Fields): Promise<Fields> => {
    const { id, version, by, override } = req;
    const who = clip(by, 64).trim();
    const note = typeof override === "string" ? clip(override, MAX_OVERRIDE).trim() : "";
    const entry = { id: clip(id, 80), version: clip(version, 40), by: who, ...(note ? { override: note } : {}) };
    try {
      if (typeof id !== "string" || !isValidPluginId(id) || typeof version !== "string" || !isSafeVersion(version)) throw new Error("invalid plugin id or version");
      if (!who) throw new Error("a request must say who is approving");
      if (override !== undefined && typeof override !== "string") throw new Error("override must be text");
      while (recent.length && now() - recent[0] > 60_000) recent.shift();
      if (recent.length >= SIGNS_PER_MINUTE) throw new Error("too many approvals in the last minute");
      recent.push(now());
      const { approval, bytes, sig } = await buildApproval(registryDir, id, version, privatePem, who, note || undefined);
      log(JSON.stringify({ event: "signed", ts: new Date(now()).toISOString(), ...entry, reviewVerdict: approval.reviewVerdict, main: approval.sha256.main.slice(0, 16) }));
      return { approval: bytes.toString("utf8"), sig };
    } catch (e) {
      log(JSON.stringify({ event: "refused", ts: new Date(now()).toISOString(), ...entry, reason: clip((e as Error).message, 200) }));
      throw e;
    }
  };
}

export interface QueueSigner {
  sign(req: { id: string; version: string; by: string; override?: string }): Promise<{ approval: string; sig: string }>;
  /** null when a signer is alive, otherwise a short reason to show the admin. */
  ready(): Promise<string | null>;
}

/** Admin side: asks the signer container for an approval. Nothing here can sign anything. */
export function queueSigner(queue: string, o: CallOpts = {}): QueueSigner {
  return {
    async sign(req) {
      const j = await queueCall(queue, { ...req }, { ...o, what: "signer", waitMs: o.waitMs ?? 60_000 });
      if (typeof j.approval !== "string" || typeof j.sig !== "string") throw new Error("the signer's answer had an unexpected shape");
      return { approval: j.approval, sig: j.sig };
    },
    ready: () => queueReady(queue, "signer", o.staleMs ?? HEARTBEAT_STALE_MS),
  };
}
