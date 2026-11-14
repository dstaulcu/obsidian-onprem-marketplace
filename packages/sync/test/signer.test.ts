import { describe, it, expect } from "vitest";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApproval } from "@om/shared";
import { syncRegistry, type Fetcher } from "../src/sync";
import { generateKeys } from "../src/signing";
import { loadSigningKey, queueSigner, signerHandler, SIGNS_PER_MINUTE } from "../src/signer";
import { processQueue, touchHeartbeat } from "../src/workqueue";

const manifest = (v: string) => JSON.stringify({ id: "demo", name: "Demo", version: v, minAppVersion: "1.5.0", description: "d", author: "a" });
const fetcher: Fetcher = async (url) => {
  if (url.includes("/releases"))
    return new Response(JSON.stringify(["1.0.0"].map((t) => ({ tag_name: t, draft: false, prerelease: false, published_at: "x",
      assets: ["main.js", "manifest.json"].map((n) => ({ name: n, url: `http://gh/asset/${t}/${n}` })) }))));
  const m = /asset\/(.+)\/(.+)$/.exec(url)!;
  return new Response(m[2] === "manifest.json" ? manifest(m[1]) : `code-${m[1]}`);
};
const exists = (p: string) => access(p).then(() => true, () => false);

async function setup() {
  const outDir = await mkdtemp(join(tmpdir(), "reg-"));
  await syncRegistry({ githubApiBase: "http://gh", outDir, repos: [{ repo: "o/r" }] }, fetcher);
  const keys = generateKeys();
  const logs: string[] = [];
  const handler = signerHandler(outDir, keys.privatePem, (l) => logs.push(l));
  const entry = JSON.parse(await readFile(join(outDir, "plugins", "demo", "versions.json"), "utf8"))[0];
  return { outDir, keys, logs, handler, entry };
}
async function writeReview(outDir: string, entry: any, verdict: string) {
  await writeFile(join(outDir, "plugins", "demo", "1.0.0", "review.json"), JSON.stringify({ schema: 1, id: "demo", version: "1.0.0", sha256: entry.sha256, review: { verdict } }));
}

describe("signing key loading", () => {
  it("reads a PEM from a file or the environment, derives the public key, and rejects junk", async () => {
    const k = generateKeys();
    const dir = await mkdtemp(join(tmpdir(), "key-"));
    const file = join(dir, "k.pem");
    await writeFile(file, k.privatePem);
    expect((await loadSigningKey(file, {})).publicSpkiB64).toBe(k.publicSpkiB64);
    expect((await loadSigningKey(undefined, { OM_SIGNING_KEY: k.privatePem })).publicSpkiB64).toBe(k.publicSpkiB64);
    await expect(loadSigningKey(undefined, {})).rejects.toThrow(/no signing key/);
    await expect(loadSigningKey(undefined, { OM_SIGNING_KEY: "not a key" })).rejects.toThrow(/valid PEM/);
  });
});

describe("signer", () => {
  it("signs an approval for a version with a passing review, without writing to the registry", async () => {
    const { outDir, keys, handler, entry } = await setup();
    await writeReview(outDir, entry, "pass");
    const r = await handler({ v: 1, id: "demo", version: "1.0.0", by: "alice" }) as { approval: string; sig: string };
    const chk = await checkApproval(new Uint8Array(Buffer.from(r.approval)), r.sig, keys.publicSpkiB64, { id: "demo", version: "1.0.0", actual: entry.sha256 });
    expect(chk.ok).toBe(true);
    expect(chk.ok && chk.approval).toMatchObject({ approvedBy: "alice", reviewVerdict: "pass" });
    expect(await exists(join(outDir, "plugins", "demo", "1.0.0", "approval.json"))).toBe(false); // the signer never writes the registry
  });

  it("refuses without a passing review unless an override reason is given, and records the reason inside the signature", async () => {
    const { outDir, keys, handler, entry, logs } = await setup();
    await expect(handler({ v: 1, id: "demo", version: "1.0.0", by: "alice" })).rejects.toThrow(/no passing review/);
    await writeReview(outDir, entry, "findings");
    await expect(handler({ v: 1, id: "demo", version: "1.0.0", by: "alice" })).rejects.toThrow(/no passing review/);
    const r = await handler({ v: 1, id: "demo", version: "1.0.0", by: "alice", override: "vendor confirmed the network call" }) as { approval: string; sig: string };
    const chk = await checkApproval(new Uint8Array(Buffer.from(r.approval)), r.sig, keys.publicSpkiB64, { id: "demo", version: "1.0.0", actual: entry.sha256 });
    expect(chk.ok && chk.approval.override).toBe("vendor confirmed the network call");
    const events = logs.map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual(["refused", "refused", "signed"]); // every decision is logged where the admin cannot reach
    expect(events[2]).toMatchObject({ id: "demo", version: "1.0.0", by: "alice", override: "vendor confirmed the network call", reviewVerdict: "findings" });
  });

  it("re-checks the files itself: a tampered main.js is refused whatever the admin asks", async () => {
    const { outDir, handler, entry } = await setup();
    await writeReview(outDir, entry, "pass");
    await writeFile(join(outDir, "plugins", "demo", "1.0.0", "main.js"), "evil()");
    await expect(handler({ v: 1, id: "demo", version: "1.0.0", by: "alice", override: "x" })).rejects.toThrow(/does not match versions.json/);
  });

  it("rejects bad input and rate limits itself", async () => {
    const { outDir, keys, entry } = await setup();
    await writeReview(outDir, entry, "pass");
    let t = 1_000_000;
    const h = signerHandler(outDir, keys.privatePem, () => {}, () => t);
    await expect(h({ v: 1, id: "../x", version: "1.0.0", by: "a" })).rejects.toThrow(/invalid/);
    await expect(h({ v: 1, id: "demo", version: "../1", by: "a" })).rejects.toThrow(/invalid/);
    await expect(h({ v: 1, id: "demo", version: "1.0.0", by: "  " })).rejects.toThrow(/who is approving/);
    await expect(h({ v: 1, id: "demo", version: "1.0.0", by: "a", override: 7 })).rejects.toThrow(/override must be text/);
    await expect(h({ v: 1, id: "demo", version: "9.9.9", by: "a" })).rejects.toThrow(/not in the registry/);
    for (let i = 0; i < SIGNS_PER_MINUTE - 1; i++) await h({ v: 1, id: "demo", version: "1.0.0", by: "a" }); // the unknown-version attempt above already used one
    await expect(h({ v: 1, id: "demo", version: "1.0.0", by: "a" })).rejects.toThrow(/too many approvals/);
    t += 61_000;
    await expect(h({ v: 1, id: "demo", version: "1.0.0", by: "a" })).resolves.toBeTruthy();
  });

  it("works across the queue, and a missing signer is reported at once", async () => {
    const { outDir, keys, handler, entry } = await setup();
    await writeReview(outDir, entry, "pass");
    const queue = await mkdtemp(join(tmpdir(), "sq-"));
    const signer = queueSigner(queue, { pollMs: 20, staleMs: 5_000 });
    expect(await signer.ready()).toMatch(/not running/);
    await touchHeartbeat(queue);
    expect(await signer.ready()).toBeNull();
    let stop = false;
    const loop = (async () => { while (!stop) { await processQueue(queue, handler); await new Promise((r) => setTimeout(r, 20)); } })();
    const r = await signer.sign({ id: "demo", version: "1.0.0", by: "alice" });
    await expect(signer.sign({ id: "demo", version: "9.9.9", by: "alice" })).rejects.toThrow(/signer reported: .*not in the registry/);
    stop = true; await loop;
    const chk = await checkApproval(new Uint8Array(Buffer.from(r.approval)), r.sig, keys.publicSpkiB64, { id: "demo", version: "1.0.0", actual: entry.sha256 });
    expect(chk.ok).toBe(true);
  });
});
