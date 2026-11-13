import { requestUrl } from "obsidian";
import { createRegistryClient, sha256Hex, type RegistryClient, type Transport } from "@om/shared";

/** Obsidian's requestUrl (bypasses CORS); everything else lives in the shared registry client. */
const transport: Transport = {
  async get(url) {
    const r = await requestUrl({ url, headers: { "Cache-Control": "no-cache" } });
    return new Uint8Array(r.arrayBuffer);
  },
};

export const registry = (base: string): RegistryClient => createRegistryClient(base, transport);
export const fetchIndex = (base: string) => registry(base).fetchIndex();
export const reportUrl = (base: string, id: string, version: string) => registry(base).reportUrl(id, version);
export { sha256Hex };
