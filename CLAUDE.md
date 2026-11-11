# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Obsidian's built-in plugin browser can't target a custom registry. This repo provides (1) a **static registry generator** that mirrors GitHub releases from an on-prem GitHub into a folder of files, and (2) an **Obsidian plugin** (`onprem-marketplace`) that browses/installs/updates plugins from that registry. See `docs/README.md` for the admin and client-bootstrap flow.

## Repository & workflow

This is the "home" version. Its remote lives under the `https://github.com/dstaulcu` organization, and it may later serve as the upstream that a work (on-prem) version patches from. Keep org-specific values (e.g. `githubApiBase`, registry URL in `registry.config.json` and the plugin's `DEFAULTS`) as placeholders or config so changes stay easy to carry downstream. Repo name is `obsidian-onprem-marketplace` (`origin` = `https://github.com/dstaulcu/obsidian-onprem-marketplace.git`, branch `main`); the plugin brands as id `onprem-marketplace` in `packages/plugin/manifest.json`. Nothing has been committed or pushed yet.

## Commands

npm workspaces (`packages/*`). Run from the repo root:

- `npm install`
- `npm run build` — builds in order: `@om/shared` → `@om/sync` → `onprem-marketplace` (order matters; the plugin and sync depend on shared)
- `npm test` — `vitest run` (only `packages/sync/test/sync.test.ts` exists)
- Single test: `npx vitest run packages/sync/test/sync.test.ts -t "adds versions"`
- Run sync: `node packages/sync/dist/cli.js [registry.config.json]` (needs the env var named by `tokenEnv`; exits 1 if any errors)
- Install plugin into a vault: `node scripts/bootstrap-vault.mjs <vaultPath> <registryUrl>`

Each package's `build` runs `tsc -p .` (type-check only; `noEmit` in `tsconfig.base.json`) and then bundles with esbuild (sync → `dist/cli.js`, plugin → `packages/plugin/main.js`, CJS, `obsidian`/`electron` external). `dist/`, `registry/` and `packages/plugin/main.js` are gitignored build outputs.

## Architecture

- `packages/shared` — types (`PluginManifest`, `IndexEntry`, `VersionEntry`) and semver/manifest validation, consumed as TypeScript source (`main: src/index.ts`) by both other packages. The registry file format is the contract between sync and plugin, so change types here first.
- `packages/sync` — `syncRegistry(cfg, fetcher)` reads GitHub releases per repo in `registry.config.json`, skips drafts/prereleases, requires release assets `main.js` + `manifest.json` (+ optional `styles.css`), and requires tag (minus `v`) == `manifest.version`. Output layout under `outDir`: `index.json` (latest per plugin), `plugins/<id>/versions.json` (sha256s, newest first), `plugins/<id>/<version>/{main.js,styles.css,manifest.json}`. Properties to preserve: idempotent (a version dir whose `manifest.json` exists is skipped; `manifest.json` is written last as the completion marker), and `rebuildIndex` regenerates `index.json` from disk so previously synced plugins persist. The `Fetcher` is injectable — tests mock it rather than hitting the network.
- `packages/plugin` — Obsidian plugin. `registry.ts` fetches registry files via `requestUrl`; `installer.ts` verifies sha256 against `versions.json`, writes into `<configDir>/plugins/<id>`, and reloads/enables via Obsidian's **undocumented `app.plugins`** manager — all such internals are deliberately confined to `installer.ts`; keep it that way. `main.ts` holds the plugin class, marketplace modal and settings tab. The marketplace can't uninstall itself and self-updates when its own repo (id `onprem-marketplace`) is nominated in the registry config.

## Status caveat

Per `docs/README.md`, the plugin compiles but has not been run inside Obsidian; the `app.plugins` usage needs verifying against the target Obsidian version. Sync is unit-tested.
