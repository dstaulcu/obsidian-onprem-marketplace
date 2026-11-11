# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Obsidian's built-in plugin browser can't target a custom registry. This repo provides (1) a **static registry generator** that mirrors GitHub releases from an on-prem GitHub into a folder of files, and (2) an **Obsidian plugin** (`onprem-marketplace`) that browses/installs/updates plugins from that registry. See `docs/README.md` for the admin and client-bootstrap flow.

## Repository & workflow

This is the "home" version. Its remote lives under the `https://github.com/dstaulcu` organization, and it may later serve as the upstream that a work (on-prem) version patches from. Keep org-specific values (e.g. `githubApiBase`, registry URL in `registry.config.json` and the plugin's `DEFAULTS`) as placeholders or config so changes stay easy to carry downstream. Repo name is `obsidian-onprem-marketplace` (`origin` = `https://github.com/dstaulcu/obsidian-onprem-marketplace.git`, branch `main`); the plugin brands as id `onprem-marketplace` in `packages/plugin/manifest.json`. Work is pushed to `main`.

## Commands

npm workspaces (`packages/*`). Run from the repo root:

- `npm install`
- `npm run build` — builds in order: `@om/shared` → `@om/sync` → `onprem-marketplace` (order matters; the plugin and sync depend on shared)
- `npm test` — `vitest run` (tests live in `packages/sync/test/`: `sync`, `signing`, `review`)
- Single test: `npx vitest run packages/sync/test/sync.test.ts -t "adds versions"`
- Run sync: `node packages/sync/dist/cli.js [registry.config.json]` (needs the env var named by `tokenEnv`; exits 1 if any errors)
- Install plugin into a vault: `node scripts/bootstrap-vault.mjs <vaultPath> <registryUrl> [publicKeyFile] [off|warn|require-signed]`
- Signing/review (see `docs/concepts/attestation.md`): `node packages/sync/dist/cli.js keygen keys`, `... review <id@version | --all>` (needs `ANTHROPIC_API_KEY`), `... approve <id@version> --key keys/signing-key.pem`
- Review model: `review.provider` = `claude-code` | `openai-compatible` | `wrapper` (`packages/sync/src/reviewers.ts`); all return untrusted output validated by `review.ts`. Wrapper args are a template (`{provider} {harness} {model} {prompt} {promptFile}`), spawned without a shell.
- Rubric: checks live in `rubric/rules.json` and `rubric/review-prompt.md` (not in code); `node packages/sync/dist/cli.js rubric --write docs/concepts/rubric.md` validates them, runs each rule's examples, and regenerates the readable doc. Rubric version = content hash, so any rule change makes earlier reviews stale.
- Rate limits: set the env var named by `tokenEnv` (e.g. `$env:GITHUB_TOKEN = (gh auth token)`); `maxVersions` caps mirrored history

Each package's `build` runs `tsc -p .` (type-check only; `noEmit` in `tsconfig.base.json`) and then bundles with esbuild (sync → `dist/cli.js`, plugin → `packages/plugin/main.js`, CJS, `obsidian`/`electron` external). `dist/`, `registry/` and `packages/plugin/main.js` are gitignored build outputs.

## Architecture

- `packages/shared` — types (`PluginManifest`, `IndexEntry`, `VersionEntry`) and semver/manifest validation, consumed as TypeScript source (`main: src/index.ts`) by both other packages. The registry file format is the contract between sync and plugin, so change types here first.
- `packages/sync` — `syncRegistry(cfg, fetcher)` reads GitHub releases per repo in `registry.config.json`, skips drafts/prereleases, requires release assets `main.js` + `manifest.json` (+ optional `styles.css`), and requires tag (minus `v`) == `manifest.version`. Output layout under `outDir`: `index.json` (latest per plugin), `plugins/<id>/versions.json` (sha256s, newest first), `plugins/<id>/<version>/{main.js,styles.css,manifest.json}`. Properties to preserve: idempotent (a version dir whose `manifest.json` exists is skipped; `manifest.json` is written last as the completion marker), and `rebuildIndex` regenerates `index.json` from disk so previously synced plugins persist. The `Fetcher` is injectable — tests mock it rather than hitting the network.
- `packages/plugin` — Obsidian plugin. `registry.ts` fetches registry files via `requestUrl`; `installer.ts` verifies sha256 against `versions.json`, writes into `<configDir>/plugins/<id>`, and reloads/enables via Obsidian's **undocumented `app.plugins`** manager — all such internals are deliberately confined to `installer.ts`; keep it that way. `main.ts` holds the plugin class, marketplace modal and settings tab. The marketplace can't uninstall itself and self-updates when its own repo (id `onprem-marketplace`) is nominated in the registry config.

- `packages/shared/src/attest.ts` — signature verification and the install-eligibility logic (`checkApproval`, `selectVersion`), shared by the plugin and tests. Signed documents are verified over their exact served bytes (ECDSA P-256, raw r||s, base64). The review stage (`packages/sync/src/review.ts`) treats reviewed code as hostile input: Claude Code runs with no tools, deterministic checks in `staticchecks.ts` set a verdict floor the model cannot lower, and the reviewer is injectable so tests never call a model. Never put key material or API keys in config; `*.pem`, `keys/` are gitignored.
- Shell note: writing large files with bash heredocs can fail to parse in this environment; use the file tools or a script file instead. The user's shell is Windows PowerShell 5.1 (no `&&`).

## Status caveat

The plugin has been run in a home Obsidian vault (modal, approval badges, report links); re-verify the `app.plugins` usage against the target Obsidian version before the work rollout. Sync, signing and review are unit-tested; the live Claude Code review has been exercised on `test-plugin` only. Known gaps are listed in `docs/concepts/security.md`.
