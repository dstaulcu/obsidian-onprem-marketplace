import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkApproval, verifySignature } from "@om/shared";
import { approveVersion, generateKeys, signBytes } from "../src/signing";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function fixture() {
  const out = await mkdtemp(join(tmpdir(), "reg-"));
  const vdir = join(out, "plugins", "demo", "1.0.0");
  await mkdir(vdir, { recursive: true });
  await writeFile(join(vdir, "main.js"), "code");
  await writeFile(join(vdir, "manifest.json"), "{}");
  await writeFile(join(out, "plugins", "demo", "versions.json"), JSON.stringify([
    { version: "1.0.0", minAppVersion: "1.5.0", published: "x", hasStyles: false, sha256: { main: sha("code"), manifest: sha("{}"), styles: "" } }]));
  return { out, vdir, actual: { main: sha("code"), manifest: sha("{}"), styles: "" } };
}

describe("signing (Node sign, WebCrypto verify)", () => {
  it("verifies a good signature and rejects tampered bytes or another key", async () => {
    const k = generateKeys(), other = generateKeys();
    const bytes = new TextEncoder().encode("hello");
    const sig = signBytes(k.privatePem, bytes);
    expect(await verifySignature(bytes, sig, k.publicSpkiB64)).toBe(true);
    expect(await verifySignature(new TextEncoder().encode("hellp"), sig, k.publicSpkiB64)).toBe(false);
    expect(await verifySignature(bytes, sig, other.publicSpkiB64)).toBe(false);
    expect(await verifySignature(bytes, "not-base64!!", k.publicSpkiB64)).toBe(false);
  });

  it("approve writes a signed approval that checkApproval accepts only for the approved hashes", async () => {
    const { out, vdir, actual } = await fixture();
    const k = generateKeys();
    await approveVersion(out, "demo", "1.0.0", k.privatePem, "tester");
    const bytes = await readFile(join(vdir, "approval.json"));
    const sig = await readFile(join(vdir, "approval.json.sig"), "utf8");
    expect((await checkApproval(bytes, sig, k.publicSpkiB64, { id: "demo", version: "1.0.0", actual })).ok).toBe(true);
    const swapped = await checkApproval(bytes, sig, k.publicSpkiB64, { id: "demo", version: "1.0.0", actual: { ...actual, main: sha("evil") } });
    expect(swapped).toEqual({ ok: false, reason: "main differs from what was approved" });
    expect((await checkApproval(bytes, sig, k.publicSpkiB64, { id: "demo", version: "1.0.1", actual })).ok).toBe(false);
    const forged = Buffer.from(bytes.toString().replace("tester", "mallory"));
    expect((await checkApproval(forged, sig, k.publicSpkiB64, { id: "demo", version: "1.0.0", actual })).ok).toBe(false);
  });

  it("refuses to approve files that no longer match versions.json", async () => {
    const { out, vdir } = await fixture();
    await writeFile(join(vdir, "main.js"), "tampered");
    await expect(approveVersion(out, "demo", "1.0.0", generateKeys().privatePem, "t")).rejects.toThrow(/does not match/);
  });
});

import { selectVersion, type Signed } from "@om/shared";

describe("selectVersion", () => {
  const h = (n: string) => ({ main: n, manifest: n, styles: "" });
  const versions = [{ version: "2.0.0", sha256: h("b") }, { version: "1.0.0", sha256: h("a") }];
  const k = generateKeys();
  const approval = (version: string, sha256: ReturnType<typeof h>, key = k): Signed => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, id: "demo", version, sha256, approvedBy: "t", approvedAt: "x" }));
    return { bytes: bytes as Uint8Array<ArrayBuffer>, sig: signBytes(key.privatePem, bytes) };
  };

  it("require-signed picks the newest approved version, skipping an unapproved newer one", async () => {
    const r = await selectVersion("demo", versions, "require-signed", k.publicSpkiB64,
      async (v) => (v === "1.0.0" ? approval("1.0.0", h("a")) : null));
    expect(r.pick?.entry.version).toBe("1.0.0");
    expect(r.pick?.approved).toBe(true);
  });
  it("require-signed refuses when nothing is approved, hashes differ, key is wrong, or no key is pinned", async () => {
    const none = await selectVersion("demo", versions, "require-signed", k.publicSpkiB64, async () => null);
    expect(none.pick).toBeNull();
    const swapped = await selectVersion("demo", versions, "require-signed", k.publicSpkiB64, async (v) => approval(v, h("zzz")), "2.0.0");
    expect(swapped.pick).toBeNull();
    const wrongKey = await selectVersion("demo", versions, "require-signed", k.publicSpkiB64, async (v) => approval(v, h(v === "2.0.0" ? "b" : "a"), generateKeys()));
    expect(wrongKey.pick).toBeNull();
    expect((await selectVersion("demo", versions, "require-signed", "", async () => null)).pick).toBeNull();
  });
  it("warn installs the newest but flags it unapproved; off ignores approvals", async () => {
    const w = await selectVersion("demo", versions, "warn", k.publicSpkiB64, async () => null);
    expect(w.pick).toMatchObject({ approved: false });
    expect(w.pick?.entry.version).toBe("2.0.0");
    expect((await selectVersion("demo", versions, "off", "", async () => null)).pick?.entry.version).toBe("2.0.0");
  });
});
