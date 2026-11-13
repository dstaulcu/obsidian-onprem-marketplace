import { checkReview, selectVersion, type Signed, type TrustMode } from "./attest";
import { compareSemver, isSafeVersion, isValidPluginId, type IndexEntry, type VersionEntry } from "./index";

/**
 * Registry client shared by the Obsidian plugin and the `om` CLI. It knows the registry layout and applies the
 * trust policy, but not how bytes are fetched (the Transport) or where they are written (the caller).
 * The registry is untrusted input: ids/versions that could escape a plugins directory are dropped.
 */
export interface Transport { get(url: string): Promise<Uint8Array> }
export interface Trust { mode: TrustMode; publicKey: string; requireReviewPass?: boolean }

const join = (base: string, path: string) => base.replace(/\/+$/, "") + "/" + path;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

export async function sha256Hex(buf: BufferSource): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RegistryClient {
  readonly base: string;
  fetchIndex(): Promise<IndexEntry[]>;
  fetchVersions(id: string): Promise<VersionEntry[]>;
  /** A signed document and its detached signature; null if either is missing. */
  fetchSigned(id: string, version: string, name: string): Promise<Signed | null>;
  fetchFile(id: string, version: string, name: string): Promise<Uint8Array>;
  reportUrl(id: string, version: string): string;
  /** Newest-first selection under the trust policy; throws if nothing is installable. */
  resolveVersion(id: string, trust: Trust, version?: string): Promise<{ entry: VersionEntry; approved: boolean }>;
  /** "pass" | "findings" | "fail" | "error", "invalid" if the record does not verify, "unverified" with no key, null if none. */
  reviewStatus(id: string, entry: VersionEntry, trust: Trust): Promise<string | null>;
  /** Downloads the files of a version and checks each against the sha256 listed in versions.json; throws on any mismatch. */
  fetchVerified(id: string, v: VersionEntry): Promise<{ name: string; bytes: Uint8Array }[]>;
}

export function createRegistryClient(base: string, transport: Transport): RegistryClient {
  const getJson = async <T>(path: string) => JSON.parse(text(await transport.get(join(base, path)))) as T;
  const c: RegistryClient = {
    base,
    async fetchIndex() {
      const all = await getJson<IndexEntry[]>("index.json");
      return all.filter((e) => isValidPluginId(e?.id) && isSafeVersion(e.latestVersion));
    },
    async fetchVersions(id) {
      if (!isValidPluginId(id)) throw new Error(`Invalid plugin id: ${id}`);
      const all = await getJson<VersionEntry[]>(`plugins/${id}/versions.json`);
      return all.filter((v) => isSafeVersion(v?.version));
    },
    async fetchSigned(id, version, name) {
      if (!isValidPluginId(id) || !isSafeVersion(version)) return null;
      try {
        const doc = await transport.get(join(base, `plugins/${id}/${version}/${name}`));
        const sig = await transport.get(join(base, `plugins/${id}/${version}/${name}.sig`));
        return { bytes: new Uint8Array(doc) as Signed["bytes"], sig: text(sig) };
      } catch { return null; }
    },
    async fetchFile(id, version, name) {
      if (!isValidPluginId(id) || !isSafeVersion(version)) throw new Error(`Invalid plugin id or version: ${id}@${version}`);
      return transport.get(join(base, `plugins/${id}/${version}/${name}`));
    },
    reportUrl: (id, version) => join(base, `plugins/${id}/${version}/review.html`),
    async resolveVersion(id, trust, version) {
      if (!isValidPluginId(id)) throw new Error(`Invalid plugin id: ${id}`);
      const versions = (await c.fetchVersions(id)).sort((a, b) => compareSemver(b.version, a.version));
      const { pick, reason } = await selectVersion(id, versions, trust.mode, trust.publicKey, (ver) => c.fetchSigned(id, ver, "approval.json"), version,
        { requireReviewPass: trust.requireReviewPass, getReview: (ver) => c.fetchSigned(id, ver, "review.json") });
      if (!pick) throw new Error(`No installable version of ${id}: ${reason ?? "none"}`);
      return pick;
    },
    async reviewStatus(id, entry, trust) {
      const s = await c.fetchSigned(id, entry.version, "review.json");
      if (!s) return null;
      if (!trust.publicKey) return "unverified";
      const r = await checkReview(s.bytes, s.sig, trust.publicKey, { id, version: entry.version, actual: entry.sha256 });
      return r.ok ? r.record.review.verdict : "invalid";
    },
    async fetchVerified(id, v) {
      const names: [string, string][] = [["main.js", v.sha256.main], ["manifest.json", v.sha256.manifest]];
      if (v.hasStyles) names.push(["styles.css", v.sha256.styles]);
      const out: { name: string; bytes: Uint8Array }[] = [];
      for (const [name, expected] of names) {
        const bytes = await c.fetchFile(id, v.version, name);
        if ((await sha256Hex(bytes as BufferSource)) !== expected) throw new Error(`Checksum mismatch for ${id}/${name}; refusing to install`);
        out.push({ name, bytes });
      }
      return out;
    },
  };
  return c;
}
