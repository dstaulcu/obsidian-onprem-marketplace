import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReviewer, MODEL_SCHEMA, type Reviewer } from "./review";

/**
 * Reviewer providers. All of them return untrusted text/JSON that review.ts validates strictly, so a model that
 * ignores the schema yields an "error" verdict, never a pass.
 *   claude-code        Claude Code headless (also works against an Anthropic-compatible gateway via env vars)
 *   openai-compatible  POST {baseUrl}/chat/completions
 *   wrapper            an organization's standard harness wrapper, run as a process
 */
export interface OpenAiConfig {
  baseUrl: string;
  /** Name of the env var holding the bearer token (never the token itself). Optional for unauthenticated endpoints. */
  apiKeyEnv?: string;
  /** Ask the server for JSON mode via response_format. Off by default because not every server supports it. */
  jsonMode?: boolean;
  timeoutMs?: number;
}
export interface WrapperConfig {
  command: string;
  /** Argument template. Placeholders: {provider} {harness} {model} {prompt} {promptFile} {stageDir}. */
  args: string[];
  provider?: string;
  harness?: string;
  /** How the prompt reaches the wrapper: as an argument (default), on stdin, or as a file path. */
  promptVia?: "arg" | "stdin" | "file";
  /**
   * The harness has file tools and reads the plugin files itself. The plugin files are copied into a fresh empty
   * directory which becomes the wrapper's working directory ({stageDir} is its absolute path). The prompt then
   * names files instead of embedding source. Requires a harness whose file access is read-only and confined to
   * its working directory; this program cannot enforce that for you.
   */
  stageFiles?: boolean;
  timeoutMs?: number;
}
export interface ProviderConfig {
  provider?: "claude-code" | "openai-compatible" | "wrapper";
  model?: string;
  maxBudgetUsd?: number;
  claudePath?: string;
  openai?: OpenAiConfig;
  wrapper?: WrapperConfig;
}

/** Non-Claude-Code providers have no schema flag, so the schema and a JSON-only instruction go in the prompt. */
export const withSchemaInstruction = (prompt: string) =>
  `${prompt}\n\nRespond with ONLY one JSON object, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(MODEL_SCHEMA)}`;

/** Pulls a JSON object out of model text: whole string, a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const tries = [t, t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""), t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const c of tries) { try { return JSON.parse(c); } catch { /* next */ } }
  return t; // unparseable: left as a string so validation rejects it
}

export function buildWrapperArgs(w: WrapperConfig, model: string, prompt: string, promptFile?: string, stageDir?: string): string[] {
  const vars: Record<string, string> = {
    provider: w.provider ?? "", harness: w.harness ?? "", model, prompt: (w.promptVia ?? "arg") === "arg" ? prompt : "", promptFile: promptFile ?? "", stageDir: stageDir ?? "",
  };
  return w.args.map((a) => a.replace(/\{(provider|harness|model|prompt|promptFile|stageDir)\}/g, (_m, k: string) => vars[k]));
}

function run(command: string, args: string[], stdin: string | null, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let so = "", se = "";
    const t = setTimeout(() => { p.kill(); reject(new Error("reviewer timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => (so += d)); p.stderr.on("data", (d) => (se += d));
    p.on("error", reject);
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(so) : reject(new Error(`${command} exited ${code}: ${se.slice(0, 300)}`)); });
    p.stdin.end(stdin ?? "");
  });
}

export function wrapperReviewer(w: WrapperConfig, model: string): Reviewer {
  // Windows allows ~32K characters on a command line; leave room for the other arguments.
  const r: Reviewer = async (prompt, ctx) => {
    const own = ctx?.stageDir ? null : await mkdtemp(join(tmpdir(), "om-review-"));
    const cwd = (ctx?.stageDir ?? own)!;
    try {
      const full = withSchemaInstruction(prompt);
      const via = w.promptVia ?? "arg";
      let file: string | undefined;
      if (via === "file") { file = join(cwd, "prompt.txt"); await writeFile(file, full); }
      const out = await run(w.command, buildWrapperArgs(w, model, via === "arg" ? full : "", file, ctx?.stageDir), via === "stdin" ? full : null, cwd, w.timeoutMs ?? 300_000);
      return { output: extractJson(out), model: [w.provider, w.harness, model].filter(Boolean).join("/") };
    } finally { if (own) await rm(own, { recursive: true, force: true }); }
  };
  if ((w.promptVia ?? "arg") === "arg") r.maxPromptChars = 26_000;
  if (w.stageFiles) r.stageFiles = true;
  return r;
}

export function openAiReviewer(o: OpenAiConfig, model: string, fetchFn: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Reviewer {
  return async (prompt) => {
    const key = o.apiKeyEnv ? env[o.apiKeyEnv] : undefined;
    if (o.apiKeyEnv && !key) throw new Error(`env var ${o.apiKeyEnv} is not set`);
    const res = await fetchFn(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model, temperature: 0,
        messages: [
          { role: "system", content: "You are a careful security reviewer of JavaScript plugins. You only analyse text you are given." },
          { role: "user", content: withSchemaInstruction(prompt) },
        ],
        ...(o.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 300_000),
    });
    if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("response had no message content");
    return { output: extractJson(text), model: j.model ?? model };
  };
}

export function makeReviewer(c: ProviderConfig): Reviewer {
  const model = c.model ?? "";
  switch (c.provider ?? "claude-code") {
    case "claude-code":
      // Config value, else the CLAUDE_PATH env var, else "claude" resolved from PATH (must be a real executable, not a .cmd shim).
      return claudeReviewer({ claudePath: c.claudePath ?? process.env.CLAUDE_PATH ?? "claude", model: c.model, maxBudgetUsd: c.maxBudgetUsd });
    case "openai-compatible":
      if (!c.openai?.baseUrl) throw new Error("review.openai.baseUrl is required for provider openai-compatible");
      if (!model) throw new Error("review.model is required for provider openai-compatible");
      return openAiReviewer(c.openai, model);
    case "wrapper":
      if (!c.wrapper?.command || !c.wrapper.args) throw new Error("review.wrapper.command and .args are required for provider wrapper");
      return wrapperReviewer(c.wrapper, model);
    default:
      throw new Error(`unknown review provider: ${String(c.provider)}`);
  }
}
