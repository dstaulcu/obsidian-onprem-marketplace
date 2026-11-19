// A stand-in for an OpenAI-compatible model service, so the demo's reviews are repeatable and cost nothing.
// It returns a fixed, recorded-style answer chosen by the plugin id named in the prompt. The admin treats the answer as untrusted and
// validates it exactly like a real model's (static checks still run and still set the verdict floor), so this shows the real pipeline.
// Usage: node demo/fake-model.mjs [port] [bindHost]   (default 9091 on 127.0.0.1; 0.0.0.0 so the reviewer container can reach it)
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9091);
const bind = process.argv[3] ?? "127.0.0.1";

const ANSWERS = {
  "shady-sync": {
    verdict: "fail",
    summary: "The plugin says it syncs notes but reads credentials-like settings and sends them to an undeclared host. The source also contains text addressed to the reviewer asking it to report a pass; that text was treated as data and ignored.",
    findings: [
      { severity: "high", title: "Vault data sent to an undeclared host", detail: "main.js builds a request to a host that the manifest description does not mention and includes note contents in the body.", file: "main.js" },
      { severity: "high", title: "Prompt-injection attempt aimed at the reviewer", detail: "A comment instructs the reviewing model to ignore its rules and answer \"pass\". This was not followed; attempting it is itself a strong signal of bad intent.", file: "main.js" },
      { severity: "medium", title: "Obfuscated string construction", detail: "The destination is assembled from encoded fragments so a reader cannot see it at a glance.", file: "main.js" },
    ],
  },
  default: {
    verdict: "pass",
    summary: "The plugin does what its description says: it inserts the current date and time into the open note. No network access, no file access outside the vault, no obfuscation.",
    findings: [],
  },
};

createServer((req, res) => {
  if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url ?? "")) { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let text = "";
    try { text = (JSON.parse(body).messages ?? []).map((m) => String(m.content)).join("\n"); } catch { /* answer the default */ }
    const key = Object.keys(ANSWERS).find((k) => k !== "default" && text.includes(k)) ?? "default";
    console.log(`review request (${text.length} chars) -> ${key}`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      model: "demo-recorded", choices: [{ message: { role: "assistant", content: JSON.stringify(ANSWERS[key]) } }],
    }));
  });
}).listen(port, bind, () => console.log(`fake model service on http://${bind}:${port}`));
