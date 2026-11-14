import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseRepoRef, resolveSources, sameRepo, isCanonical } from "../src/sources";
import { makeSourceFetcher, normalizeReleases, releasesUrl, throwFor, RateLimitError } from "../src/providers";
import { syncRegistry } from "../src/sync";
import { checkRepo } from "../src/nominate";
import glFixture from "./fixtures/gitlab-releases.json";

const cfg = {
  githubApiBase: "https://api.github.com",
  sources: [
    { webBase: "https://github.corp", type: "github" as const },
    { webBase: "https://gitlab.corp", type: "gitlab" as const, tokenEnv: "GL_TOKEN" },
    { webBase: "http://plain.corp:8080", type: "gitlab" as const },
  ],
};
const S = resolveSources(cfg);
const canon = (s: string) => { const r = parseRepoRef(s, S); return r.ok ? r.ref.canonical : "REFUSED: " + r.reason; };

describe("repository references", () => {
  it("one canonical form per repository, whichever way it is written", () => {
    const same: [string, string][] = [
      ["acme/plugin", "acme/plugin"],
      ["https://github.com/acme/plugin", "acme/plugin"],
      ["https://github.com/acme/plugin.git", "acme/plugin"],
      ["https://github.com/acme/plugin/", "acme/plugin"],
      ["https://GITHUB.com/acme/plugin/releases/tag/v1", "acme/plugin"],
      ["https://github.com/acme/plugin/tree/main/src?x=1#y", "acme/plugin"],
      ["github.com/acme/plugin", "acme/plugin"],
      ["https://github.corp/acme/plugin", "github.corp/acme/plugin"],
      ["github.corp/acme/plugin", "github.corp/acme/plugin"],
      ["https://gitlab.corp/grp/plugin", "gitlab.corp/grp/plugin"],
      ["https://gitlab.corp/grp/sub/deep/plugin.git", "gitlab.corp/grp/sub/deep/plugin"],
      ["https://gitlab.corp/grp/sub/plugin/-/releases", "gitlab.corp/grp/sub/plugin"],
      ["https://gitlab.corp/grp/sub/plugin/-/tree/main", "gitlab.corp/grp/sub/plugin"],
      ["http://plain.corp:8080/g/p", "plain.corp:8080/g/p"],
    ];
    for (const [input, want] of same) expect(canon(input), input).toBe(want);
  });

  it("the same name on two servers is two repositories; case does not make a new one", () => {
    expect(sameRepo(canon("https://github.corp/acme/plugin"), canon("https://github.com/acme/plugin"))).toBe(false);
    expect(sameRepo(canon("ACME/Plugin"), canon("acme/plugin"))).toBe(true);
    expect(sameRepo(canon("https://gitlab.corp/A/B"), canon("gitlab.corp/a/b"))).toBe(true);
  });

  it("refuses what it cannot vouch for", () => {
    const refused = [
      "", "acme", "acme/", "/acme/x", "a b/c", "a/b/c", "a/../b", "../x", "https://github.com/a/..",
      "https://github.com/a%2Fb/c", "https://github.com/a/b%2e%2e",
      "https://user:pass@github.com/acme/plugin", "https://evil.example/acme/plugin", "https://gitlab.evil/a/b",
      "http://github.com/acme/plugin", "https://plain.corp:8080/g/p", "ftp://github.com/a/b", "javascript:alert(1)",
      "https://github.com/", "https://github.com/onlyowner", "https://gitlab.corp/onlygroup", "a/b.lock",
    ];
    for (const r of refused) expect(canon(r), r).toMatch(/^REFUSED/);
    expect(parseRepoRef(null, S).ok).toBe(false);
    expect(parseRepoRef("x/".repeat(200), S).ok).toBe(false);
  });

  it("a canonical string read back from disk parses to itself", () => {
    for (const c of ["acme/plugin", "github.corp/acme/plugin", "gitlab.corp/grp/sub/plugin", "plain.corp:8080/g/p"]) {
      expect(isCanonical(c)).toBe(true);
      expect(canon(c)).toBe(c);
    }
  });

  it("validates the source list", () => {
    expect(() => resolveSources({ githubApiBase: "https://api.github.com", sources: [{ webBase: "https://x.corp/path", type: "gitlab" }] })).toThrow(/just the server address/);
    expect(() => resolveSources({ githubApiBase: "https://api.github.com", sources: [{ webBase: "https://x.corp", type: "gitlab", tokenEnv: "A", tokenFile: "/b" }] })).toThrow(/only one of/);
    expect(() => resolveSources({ githubApiBase: "https://api.github.com", sources: [{ webBase: "https://github.com", type: "github" }] })).toThrow(/twice/);
    expect(S.map((x) => x.host)).toEqual(["github.com", "github.corp", "gitlab.corp", "plain.corp:8080"]);
    expect(S[2].apiBase).toBe("https://gitlab.corp/api/v4");
    expect(S[1].apiBase).toBe("https://github.corp/api/v3");
  });
});

describe("GitLab release answers (shape captured from a real gitlab.com response)", () => {
  const gl = S[3];
  it("encodes nested group paths in the project id", () => {
    expect(releasesUrl(gl, "grp/sub/name", 10)).toBe("http://plain.corp:8080/api/v4/projects/grp%2Fsub%2Fname/releases?per_page=10");
    expect(releasesUrl(S[0], "o/r", 10)).toBe("https://api.github.com/repos/o/r/releases?per_page=10");
  });
  it("maps tag, date, upcoming (as pre-release) and asset links", () => {
    const r = normalizeReleases(gl, glFixture);
    expect(r[0].tag).toBe(glFixture[0].tag_name);
    expect(r[0].draft).toBe(false);
    expect(r[0].prerelease).toBe(false);
    expect(r[0].published).toBe(glFixture[0].released_at);
    expect(r[0].assets.length).toBe(2);
    expect(r[0].assets[0].url).toMatch(/^https:\/\/gitlab\.com\//);
    const up = normalizeReleases(gl, [{ tag_name: "v2", upcoming_release: true, assets: { links: [] } }]);
    expect(up[0].prerelease).toBe(true);
  });
  it("refuses an answer that is not a list, and skips junk entries", () => {
    expect(() => normalizeReleases(gl, { message: "401 Unauthorized" })).toThrow(/unexpected/);
    expect(normalizeReleases(gl, [null, 5, { nope: 1 }, { tag_name: "v1", assets: "x" }]).map((x) => x.tag)).toEqual(["v1"]);
  });
  it("treats GitLab's 429 and its ratelimit headers as a rate limit", () => {
    const r = new Response("{}", { status: 429, headers: { "ratelimit-remaining": "0", "ratelimit-reset": "1794693720" } });
    expect(() => throwFor(gl, "u", r)).toThrow(RateLimitError);
    expect(() => throwFor(gl, "u", new Response("{}", { status: 404 }))).toThrow(/404/);
  });
});

describe("the token goes only where it belongs", () => {
  afterEach(() => vi.restoreAllMocks());
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const stub = (redirects: Record<string, string> = {}) => vi.stubGlobal("fetch", async (u: URL | string, init?: { headers?: Record<string, string> }) => {
    const url = String(u); seen.push({ url, headers: init?.headers ?? {} });
    return redirects[url] ? new Response("", { status: 302, headers: { location: redirects[url] } }) : new Response("ok");
  });
  const env = { GL_TOKEN: "glpat-secret", GH_TOKEN: "ghp-secret" };
  const sources = resolveSources({ githubApiBase: "https://api.github.com", tokenEnv: "GH_TOKEN", sources: [{ webBase: "https://gitlab.corp", type: "gitlab", tokenEnv: "GL_TOKEN" }] });

  it("sends each source's token only to that source, in the right header", async () => {
    seen.length = 0; stub();
    const f = makeSourceFetcher(sources, env);
    await f("https://gitlab.corp/api/v4/projects/a%2Fb/releases");
    await f("https://api.github.com/repos/a/b/releases");
    expect(seen[0].headers["PRIVATE-TOKEN"]).toBe("glpat-secret");
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(seen[1].headers.Authorization).toBe("Bearer ghp-secret");
    expect(seen[1].headers["PRIVATE-TOKEN"]).toBeUndefined();
  });

  it("refuses an address on a server that is not configured, before any request", async () => {
    seen.length = 0; stub();
    const f = makeSourceFetcher(sources, env);
    await expect(f("https://evil.example/main.js")).rejects.toThrow(/not a configured git server/);
    await expect(f("not a url")).rejects.toThrow(/not a web address/);
    expect(seen).toEqual([]);
  });

  it("follows a redirect to storage without the token, and refuses a downgrade to http", async () => {
    seen.length = 0; stub({ "https://api.github.com/repos/a/b/releases/assets/1": "https://objects.example/blob?sig=1", "https://gitlab.corp/dl": "http://objects.example/x" });
    const f = makeSourceFetcher(sources, env);
    expect((await f("https://api.github.com/repos/a/b/releases/assets/1")).ok).toBe(true);
    expect(seen[1].url).toBe("https://objects.example/blob?sig=1");
    expect(seen[1].headers.Authorization).toBeUndefined();
    await expect(f("https://gitlab.corp/dl")).rejects.toThrow(/refusing a redirect/);
  });

  it("reads a token from a file, trimmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-tok-"));
    await writeFile(join(dir, "t"), "from-file\n");
    const s = resolveSources({ githubApiBase: "https://api.github.com", sources: [{ webBase: "https://gitlab.corp", type: "gitlab", tokenFile: join(dir, "t") }] });
    seen.length = 0; stub();
    await makeSourceFetcher(s, {})("https://gitlab.corp/api/v4/x");
    expect(seen[0].headers["PRIVATE-TOKEN"]).toBe("from-file");
  });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MF = (id = "demo", v = "1.0.0") => JSON.stringify({ id, name: id, version: v, minAppVersion: "1.5.0", description: "d", author: "a" });

/** A mock git world: GitHub and GitLab both offering a plugin called "demo". */
function world(): (url: string, accept?: string) => Promise<Response> {
  const gh = [{ tag_name: "v1.0.0", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z", assets: [{ name: "main.js", url: "https://api.github.com/a/main" }, { name: "manifest.json", url: "https://api.github.com/a/manifest" }] }];
  const gl = [{ tag_name: "1.0.0", released_at: "2026-02-01T00:00:00Z", upcoming_release: false, assets: { links: [
    { name: "main.js", url: "https://x/ignored", direct_asset_url: "https://gitlab.corp/g/p/-/releases/1.0.0/downloads/main.js" },
    { name: "manifest.json", url: "https://gitlab.corp/g/p/-/releases/1.0.0/downloads/manifest.json" }] } }];
  return async (url) => {
    if (url.startsWith("https://api.github.com/repos/a/b/releases?")) return new Response(JSON.stringify(gh));
    if (url.startsWith("https://gitlab.corp/api/v4/projects/g%2Fp/releases?")) return new Response(JSON.stringify(gl));
    if (url.endsWith("main") || url.endsWith("main.js")) return new Response("code-" + (url.includes("gitlab") ? "gl" : "gh"));
    if (url.endsWith("manifest") || url.endsWith("manifest.json")) return new Response(MF());
    return new Response("{}", { status: 404 });
  };
}

describe("syncing from more than one server", () => {
  const base = { githubApiBase: "https://api.github.com", sources: [{ webBase: "https://gitlab.corp", type: "gitlab" as const }] };
  it("mirrors a GitLab release, records its canonical repo, and refuses the same plugin id from another server", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "om-ms-"));
    const r = await syncRegistry({ ...base, outDir, repos: [{ repo: "https://gitlab.corp/g/p.git" }, { repo: "https://github.com/a/b" }] }, world());
    expect(r.added).toEqual(["gitlab.corp/g/p@1.0.0"]);
    expect(r.errors.join()).toMatch(/plugin id "demo" is already provided by gitlab.corp\/g\/p; not mixing in versions from a\/b/);
    expect(await readFile(join(outDir, "plugins/demo/1.0.0/main.js"), "utf8")).toBe("code-gl");
    const idx = JSON.parse(await readFile(join(outDir, "index.json"), "utf8"));
    expect(idx[0].repo).toBe("gitlab.corp/g/p");
    const v = JSON.parse(await readFile(join(outDir, "plugins/demo/versions.json"), "utf8"));
    expect(v[0].sha256.main).toBe(sha("code-gl"));
    // a later run in the other order still keeps the first owner
    const again = await syncRegistry({ ...base, outDir, repos: [{ repo: "a/b" }] }, world());
    expect(again.errors.join()).toMatch(/already provided by gitlab.corp\/g\/p/);
  });

  it("reports an unlisted host as an error for that repo only", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "om-ms-"));
    await mkdir(outDir, { recursive: true });
    const r = await syncRegistry({ ...base, outDir, repos: [{ repo: "https://evil.example/a/b" }, { repo: "a/b" }] }, world());
    expect(r.errors[0]).toMatch(/not a git server this marketplace is set up to use/);
    expect(r.added).toEqual(["a/b@v1.0.0"]);
  });

  it("checkRepo accepts a GitLab URL and echoes the canonical name; it never calls an unlisted host", async () => {
    const calls: string[] = [];
    const f = world();
    const spy: typeof f = async (u, a) => { calls.push(u); return f(u, a); };
    const S2 = resolveSources(base);
    const ok = await checkRepo(S2, spy, "https://gitlab.corp/g/p/-/releases");
    expect(ok.ok).toBe(true);
    expect(ok.repo).toBe("gitlab.corp/g/p");
    calls.length = 0;
    const no = await checkRepo(S2, spy, "https://evil.example/g/p");
    expect(no.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
