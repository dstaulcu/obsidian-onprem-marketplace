# Obsidian On-Prem Marketplace

Obsidian's built-in plugin browser cannot be pointed at a custom registry, so this project provides an
**On-Prem Marketplace plugin** plus a **static registry** fed from releases on your on-prem GitHub.

## Concept guides
- [Overview](concepts/overview.md) - start here
- [Registry & sync](concepts/registry-and-sync.md) - admins
- [Install & update lifecycle](concepts/install-lifecycle.md) - users
- [Security & trust model](concepts/security.md) - security stakeholders
- [Developer guide](concepts/developer-guide.md) - contributors

## Admin flow
1. Edit `registry.config.json`: set `githubApiBase` (e.g. `https://github.corp/api/v3`), `tokenEnv`, and the nominated `repos`.
2. Each plugin repo publishes a GitHub release whose tag equals the `manifest.json` version, with `main.js`,
   `manifest.json` and optional `styles.css` attached (the standard Obsidian layout).
3. `npm install && npm run build`, then `node packages/sync/dist/cli.js` (schedule it). It writes `registry/`.
4. Serve `registry/` from any static web server (IIS, nginx, file share) at your registry URL.
5. To self-update the marketplace plugin, nominate its repo too (id `onprem-marketplace`).

## Client bootstrap (once per vault)
`node scripts/bootstrap-vault.mjs <vaultPath> <registryUrl>`, then in Obsidian turn off Restricted mode
(Settings > Community plugins) and reload. Use the ribbon store icon or the "Browse internal plugins" command.

## Security notes
Installed files are verified against sha256 hashes in the registry, but the registry is a trust boundary:
only nominate repos you control, and restrict write access to the web root.

## Status
Built and unit-tested (sync). The plugin compiles but has **not yet been run inside Obsidian**; the
`app.plugins` internals in `packages/plugin/src/installer.ts` need to be confirmed against your Obsidian version.
