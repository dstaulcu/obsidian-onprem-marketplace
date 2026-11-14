import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, writeFile, utimes, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MAX_RESULT_BYTES, processQueueOnce, queueReviewer, touchHeartbeat, validateReviewQueue } from "../src/reviewqueue";
import { reviewVersion, type Reviewer } from "../src/review";
import { runReviews } from "../src/jobs";
import { loadRubric } from "../src/rubric";

const rubric = await loadRubric("rubric");
const q = () => mkdtemp(join(tmpdir(), "rq-"));
const good = { verdict: "pass", summary: "looks fine", findings: [] };
const fake = (output: unknown, model = "claude-test"): Reviewer => async () => ({ output, model, costUsd: 0.02 });

/** Runs the worker in the background until stopped, like the container does. */
function startWorker(queue: string, reviewer: Reviewer) {
  let stop = false;
  const done = (async () => { while (!stop) { await processQueueOnce(queue, reviewer); await new Promise((r) => setTimeout(r, 20)); } })();
  return async () => { stop = true; await done; };
}
/** A hostile or broken reviewer: answers every queued request with exactly these bytes. */
async function rawAnswer(queue: string, body: string) {
  await mkdir(join(queue, "results"), { recursive: true });
  for (let i = 0; i < 200; i++) {
    const names = await readdir(join(queue, "requests")).catch(() => [] as string[]);
    const n = names.find((x) => x.endsWith(".json"));
    if (n) { await writeFile(join(queue, "results", n), body); return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("review queue", () => {
  it("round trip: the admin side gets the reviewer's answer, and nothing is left behind", async () => {
    const queue = await q();
    const stop = startWorker(queue, fake(good));
    const r = await queueReviewer(queue, { pollMs: 20 })("PROMPT");
    await stop();
    expect(r).toEqual({ output: good, model: "claude-test", costUsd: 0.02 });
    expect(await readdir(join(queue, "requests"))).toEqual([]);
    expect(await readdir(join(queue, "results"))).toEqual([]);
  });

  it("a reviewer failure becomes an error on the admin side", async () => {
    const queue = await q();
    const stop = startWorker(queue, async () => { throw new Error("claude exited 1"); });
    await expect(queueReviewer(queue, { pollMs: 20 })("p")).rejects.toThrow(/reviewer reported: claude exited 1/);
    await stop();
  });

  it("secret-like model output never crosses the queue", async () => {
    const queue = await q();
    const stop = startWorker(queue, fake({ verdict: "pass", summary: "token sk-ant-" + "a".repeat(30), findings: [] }));
    await expect(queueReviewer(queue, { pollMs: 20 })("p")).rejects.toThrow(/secret-like/);
    await stop();
  });

  it("an oversized answer is discarded, not read", async () => {
    const queue = await q();
    const pending = queueReviewer(queue, { pollMs: 20 })("p");
    await rawAnswer(queue, "x".repeat(MAX_RESULT_BYTES + 10));
    await expect(pending).rejects.toThrow(/too large/);
    expect(await readdir(join(queue, "results"))).toEqual([]);
  });

  it("malformed answers (not JSON, wrong shape) are errors", async () => {
    for (const body of ["not json {", JSON.stringify({ ok: "yes" }), JSON.stringify([1, 2])]) {
      const queue = await q();
      const pending = queueReviewer(queue, { pollMs: 20 })("p");
      await rawAnswer(queue, body);
      await expect(pending).rejects.toThrow(/not valid JSON|unexpected shape/);
    }
  });

  it("error text from the reviewer is cleaned and clipped before it reaches a report", async () => {
    const queue = await q();
    const pending = queueReviewer(queue, { pollMs: 20 })("p");
    await rawAnswer(queue, JSON.stringify({ ok: false, error: "bad\u0000\u001b[31m" + "z".repeat(1000) }));
    const err = (await pending.catch((e: Error) => e.message)) as string;
    expect(err.length).toBeLessThan(340);
    expect(err).not.toMatch(/[\u0000-\u001f]/);
  });

  it("nobody answering: times out and withdraws the request", async () => {
    const queue = await q();
    await expect(queueReviewer(queue, { waitMs: 150, pollMs: 20 })("p")).rejects.toThrow(/did not answer in time/);
    expect(await readdir(join(queue, "requests"))).toEqual([]);
  });

  it("the worker ignores files that are not uuid-named requests, and rejects malformed or oversized ones", async () => {
    const queue = await q();
    await mkdir(join(queue, "requests"), { recursive: true });
    await writeFile(join(queue, "requests", "..evil.json"), "{}");
    await writeFile(join(queue, "requests", "notes.txt"), "hi");
    const id = "11111111-2222-3333-4444-555555555555";
    await writeFile(join(queue, "requests", id + ".json"), JSON.stringify({ v: 2, prompt: "p" }));
    const calls = { n: 0 };
    expect(await processQueueOnce(queue, async () => { calls.n++; return { output: good, model: "m" }; })).toBe(1);
    expect(calls.n).toBe(0);
    expect(JSON.parse(await readFile(join(queue, "results", id + ".json"), "utf8"))).toEqual({ ok: false, error: "malformed request" });
    expect((await readdir(join(queue, "requests"))).sort()).toEqual(["..evil.json", "notes.txt"]);
  });

  it("heartbeat: missing and stale mean not running, fresh means ready", async () => {
    const queue = await q();
    const rv = queueReviewer(queue, { staleMs: 5_000 });
    expect(await rv.ready()).toMatch(/not running/);
    await touchHeartbeat(queue);
    expect(await rv.ready()).toBeNull();
    const old = new Date(Date.now() - 60_000);
    await utimes(join(queue, "heartbeat"), old, old);
    expect(await rv.ready()).toMatch(/stale/);
  });

  it("refuses a harness that needs plugin files on disk", () => {
    expect(validateReviewQueue({ provider: "wrapper", wrapper: { command: "x", args: [], stageFiles: true } })).toHaveLength(1);
    expect(validateReviewQueue({ provider: "claude-code" })).toEqual([]);
    expect(validateReviewQueue(undefined)).toHaveLength(1);
  });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function registry() {
  const out = await mkdtemp(join(tmpdir(), "reg-"));
  const vdir = join(out, "plugins", "demo", "1.0.0");
  await mkdir(vdir, { recursive: true });
  await writeFile(join(vdir, "main.js"), "module.exports = {}");
  await writeFile(join(vdir, "manifest.json"), "{}");
  await writeFile(join(out, "plugins", "demo", "versions.json"), JSON.stringify([
    { version: "1.0.0", minAppVersion: "1.5.0", published: "x", hasStyles: false, sha256: { main: sha("module.exports = {}"), manifest: sha("{}"), styles: "" } }]));
  return { out, vdir };
}

describe("review through the queue (admin side keeps all the decisions)", () => {
  it("a good answer becomes a pass with the reviewer's model name, written by the admin side", async () => {
    const { out, vdir } = await registry();
    const queue = await q();
    const stop = startWorker(queue, fake(good, "claude-sonnet-5-5"));
    await reviewVersion(out, "demo", "1.0.0", queueReviewer(queue, { pollMs: 20 }), { rubric, model: "claude-sonnet-5-5" });
    await stop();
    const rec = JSON.parse(await readFile(join(vdir, "review.json"), "utf8"));
    expect(rec.review.verdict).toBe("pass");
    expect(rec.review.model).toBe("claude-sonnet-5-5");
  });

  it("an up-to-date review is skipped unless the version is explicitly forced", async () => {
    const { out } = await registry();
    const calls = { n: 0 };
    const rv: Reviewer = async () => { calls.n++; return { output: good, model: "m" }; };
    expect((await reviewVersion(out, "demo", "1.0.0", rv, { rubric, model: "m" })).status).toBe("reviewed");
    expect((await reviewVersion(out, "demo", "1.0.0", rv, { rubric, model: "m" })).status).toBe("skipped");
    expect((await reviewVersion(out, "demo", "1.0.0", rv, { rubric, model: "m", force: true })).status).toBe("reviewed");
    expect(calls.n).toBe(2);
  });

  it("a hostile answer cannot produce a pass or put anything into the report", async () => {
    const { out, vdir } = await registry();
    const queue = await q();
    const evil = { ok: true, output: { verdict: "pass", summary: "<script>alert(1)</script>", findings: "nope" }, model: "m" };
    const run = reviewVersion(out, "demo", "1.0.0", queueReviewer(queue, { pollMs: 20 }), { rubric });
    await rawAnswer(queue, JSON.stringify(evil));
    await run;
    const rec = JSON.parse(await readFile(join(vdir, "review.json"), "utf8"));
    expect(rec.review.verdict).toBe("error");
    expect(await readFile(join(vdir, "review.html"), "utf8")).not.toContain("<script>alert");
  });

  it("with no reviewer running, runReviews skips before queuing anything and writes no records", async () => {
    const { out, vdir } = await registry();
    const queue = await q();
    const rv = queueReviewer(queue);
    const lines: string[] = [];
    await runReviews({ githubApiBase: "x", outDir: out, repos: [], review: { enabled: true } }, [{ id: "demo", version: "1.0.0" }],
      { log: (s) => lines.push(s), err: (s) => lines.push(s) }, {}, { reviewer: rv, preflight: () => rv.ready() });
    expect(lines.join(" ")).toMatch(/not running.*skipping reviews/);
    await expect(access(join(vdir, "review.json"))).rejects.toBeTruthy();
    expect(await readdir(queue)).toEqual([]);
  });
});
