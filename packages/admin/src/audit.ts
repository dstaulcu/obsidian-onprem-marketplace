import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Append-only JSON lines: who did what, from where. Never log passwords, tokens or request bodies. */
export interface Audit { record(who: string, action: string, detail?: Record<string, unknown>, ip?: string): Promise<void> }

export function fileAudit(file: string): Audit {
  let ready: Promise<unknown> | undefined;
  return {
    async record(who, action, detail = {}, ip) {
      ready ??= mkdir(dirname(file), { recursive: true });
      await ready;
      await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), who, action, ip, ...detail }) + "\n");
    },
  };
}
