import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Transport } from "@om/shared";

/** http(s) via fetch; anything else is a local folder (plain path or file:// URL), which makes offline mirrors and tests work. */
export const transport: Transport = {
  async get(url) {
    if (/^https?:\/\//i.test(url)) {
      const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
      if (!r.ok) throw new Error(`GET ${url} failed: ${r.status} ${r.statusText}`);
      return new Uint8Array(await r.arrayBuffer());
    }
    return new Uint8Array(await readFile(url.startsWith("file:") ? fileURLToPath(url) : url));
  },
};
