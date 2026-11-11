import { requestUrl } from "obsidian";
import type { IndexEntry, VersionEntry } from "@om/shared";

const join = (base: string, path: string) => base.replace(/\/+$/, "") + "/" + path;

async function getJson<T>(url: string): Promise<T> {
  const r = await requestUrl({ url, headers: { "Cache-Control": "no-cache" } });
  return r.json as T;
}

export const fetchIndex = (base: string) => getJson<IndexEntry[]>(join(base, "index.json"));
export const fetchVersions = (base: string, id: string) =>
  getJson<VersionEntry[]>(join(base, `plugins/${id}/versions.json`));

export async function fetchFile(base: string, id: string, version: string, name: string): Promise<ArrayBuffer> {
  const r = await requestUrl({ url: join(base, `plugins/${id}/${version}/${name}`) });
  return r.arrayBuffer;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
