import { requestUrl } from "obsidian";
import { isSafeVersion, isValidPluginId, type IndexEntry, type Signed, type VersionEntry } from "@om/shared";

const join = (base: string, path: string) => base.replace(/\/+$/, "") + "/" + path;

async function getJson<T>(url: string): Promise<T> {
  const r = await requestUrl({ url, headers: { "Cache-Control": "no-cache" } });
  return r.json as T;
}

/** The registry is untrusted input: drop entries whose id/version could escape the plugins directory. */
export async function fetchIndex(base: string): Promise<IndexEntry[]> {
  const all = await getJson<IndexEntry[]>(join(base, "index.json"));
  return all.filter((e) => isValidPluginId(e?.id) && isSafeVersion(e.latestVersion));
}
export async function fetchVersions(base: string, id: string): Promise<VersionEntry[]> {
  if (!isValidPluginId(id)) throw new Error(`Invalid plugin id: ${id}`);
  const all = await getJson<VersionEntry[]>(join(base, `plugins/${id}/versions.json`));
  return all.filter((v) => isSafeVersion(v?.version));
}

export const reportUrl = (base: string, id: string, version: string) => join(base, `plugins/${id}/${version}/review.md`);

/** Fetches a signed document and its detached signature; null if either is missing. */
export async function fetchSigned(base: string, id: string, version: string, name: string): Promise<Signed | null> {
  try {
    const doc = await requestUrl({ url: join(base, `plugins/${id}/${version}/${name}`) });
    const sig = await requestUrl({ url: join(base, `plugins/${id}/${version}/${name}.sig`) });
    return { bytes: new Uint8Array(doc.arrayBuffer), sig: sig.text };
  } catch { return null; }
}

export async function fetchFile(base: string, id: string, version: string, name: string): Promise<ArrayBuffer> {
  const r = await requestUrl({ url: join(base, `plugins/${id}/${version}/${name}`) });
  return r.arrayBuffer;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
