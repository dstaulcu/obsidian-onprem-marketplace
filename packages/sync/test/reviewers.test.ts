import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildWrapperArgs, extractJson, makeReviewer, openAiReviewer, wrapperReviewer } from "../src/reviewers";
import { parseModelOutput, reviewVersion, type Reviewer } from "../src/review";
import { loadRubric } from "../src/rubric";

const rubric = await loadRubric("rubric");
const good = { verdict: "pass", summary: "ok", findings: [] };

describe("extractJson", () => {
  it("handles plain, fenced and chatty output; leaves junk as a string", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBe("no json here");
    expect(parseModelOutput(extractJson("no json here"))).toBeNull();
  });
});

describe("wrapper reviewer", () => {
  it("fills the argument template", () => {
    const args = buildWrapperArgs({ command: "w", provider: "onprem", harness: "plain", args: ["--p", "{provider}", "--h", "{harness}", "--m", "{model}", "--q", "{prompt}", "--f", "{promptFile}"] }, "big-model", "PROMPT", "/tmp/x");
    expect(args).toEqual(["--p", "onprem", "--h", "plain", "--m", "big-model", "--q", "PROMPT", "--f", "/tmp/x"]);
  });
  it("runs a process with the prompt as an argument, no shell, and parses its JSON", async () => {
    const script = `process.stdout.write("note: " + JSON.stringify({verdict:"pass",summary:String(process.argv.at(-1).includes("JSON Schema")),findings:[]}))`;
    const r = wrapperReviewer({ command: process.execPath, args: ["-e", script, "--", "{prompt}"], provider: "p", harness: "h" }, "m");
    const out = await r("hello; rm -rf / && $(whoami)");
    expect(out.model).toBe("p/h/m");
    expect(parseModelOutput(out.output)).toMatchObject({ verdict: "pass", summary: "true" });
    expect(r.maxPromptChars).toBeLessThan(32_000); // command-line transport is size limited
  });
  it("can pass the prompt on stdin instead (no size limit)", async () => {
    const script = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({verdict:"pass",summary:String(s.length),findings:[]})))`;
    const r = wrapperReviewer({ command: process.execPath, args: ["-e", script], promptVia: "stdin" }, "m");
    expect(r.maxPromptChars).toBeUndefined();
    const out = parseModelOutput((await r("x".repeat(50_000))).output);
    expect(Number(out?.summary)).toBeGreaterThan(50_000);
  });
  it("reports a failing wrapper as an error, not a pass", async () => {
    const r = wrapperReviewer({ command: process.execPath, args: ["-e", "process.exit(3)"] }, "m");
    await expect(r("p")).rejects.toThrow(/exited 3/);
  });
});

describe("openai-compatible reviewer", () => {
  const reply = (content: unknown, ok = true): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
    (reply as unknown as { last?: { url: unknown; init?: RequestInit } }).last = { url: _u, init };
    return new Response(JSON.stringify({ model: "served-model", choices: [{ message: { content } }] }), { status: ok ? 200 : 500 });
  }) as typeof fetch;

  it("posts a chat completion with the key from the named env var and parses the reply", async () => {
    let seen: { url?: string; headers?: Record<string, string>; body?: { model: string; messages: { content: string }[]; response_format?: unknown } } = {};
    const f = (async (u: string, init: RequestInit) => {
      seen = { url: u, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ model: "served-model", choices: [{ message: { content: '```json\n' + JSON.stringify(good) + '\n```' } }] }));
    }) as unknown as typeof fetch;
    const r = openAiReviewer({ baseUrl: "https://llm.internal/v1/", apiKeyEnv: "OM_KEY", jsonMode: true }, "big", f, { OM_KEY: "secret" });
    const out = await r("PROMPT");
    expect(seen.url).toBe("https://llm.internal/v1/chat/completions");
    expect(seen.headers?.Authorization).toBe("Bearer secret");
    expect(seen.body?.model).toBe("big");
    expect(seen.body?.messages[1].content).toContain("PROMPT");
    expect(seen.body?.messages[1].content).toContain("JSON Schema");
    expect(seen.body?.response_format).toEqual({ type: "json_object" });
    expect(out.model).toBe("served-model");
    expect(parseModelOutput(out.output)?.verdict).toBe("pass");
  });
  it("fails safely: missing key, HTTP error, empty reply", async () => {
    await expect(openAiReviewer({ baseUrl: "http://x", apiKeyEnv: "NOPE" }, "m", reply("x"), {})("p")).rejects.toThrow(/NOPE is not set/);
    await expect(openAiReviewer({ baseUrl: "http://x" }, "m", reply("x", false), {})("p")).rejects.toThrow(/500/);
    await expect(openAiReviewer({ baseUrl: "http://x" }, "m", reply(undefined), {})("p")).rejects.toThrow(/no message content/);
  });
});

describe("makeReviewer config validation", () => {
  it("explains what is missing", () => {
    expect(() => makeReviewer({ provider: "openai-compatible" })).toThrow(/baseUrl/);
    expect(() => makeReviewer({ provider: "openai-compatible", openai: { baseUrl: "http://x" } })).toThrow(/model is required/);
    expect(() => makeReviewer({ provider: "wrapper" })).toThrow(/command/);
    expect(() => makeReviewer({})).toThrow(/claudePath/);
    expect(() => makeReviewer({ provider: "nope" as never })).toThrow(/unknown review provider/);
  });
});

describe("prompt size limits", () => {
  it("a size-limited transport makes mid-size bundles partial instead of overflowing", async () => {
    const code = "x".repeat(30_000);
    const out = await mkdtemp(join(tmpdir(), "reg-"));
    const vdir = join(out, "plugins", "demo", "1.0.0");
    await mkdir(vdir, { recursive: true });
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    await writeFile(join(vdir, "main.js"), code);
    await writeFile(join(vdir, "manifest.json"), "{}");
    await writeFile(join(out, "plugins", "demo", "versions.json"), JSON.stringify([
      { version: "1.0.0", minAppVersion: "1", published: "x", hasStyles: false, sha256: { main: sha(code), manifest: sha("{}"), styles: "" } }]));
    let prompt = "";
    const limited: Reviewer = Object.assign(async (p: string) => { prompt = p; return { output: good, model: "m" }; }, { maxPromptChars: 26_000 });
    await reviewVersion(out, "demo", "1.0.0", limited, { rubric });
    expect(prompt).not.toContain("x".repeat(1000)); // 30KB would fit the normal limit but not a 26K command line
    expect(prompt.length).toBeLessThan(26_000);
  });
});
