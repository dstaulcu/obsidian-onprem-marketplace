# Obsidian On-Prem Marketplace

Obsidian's built-in plugin browser cannot be pointed at a custom registry, so this project provides an
**On-Prem Marketplace plugin** plus a **static registry** fed from releases on your on-prem GitHub.

## Concept guides
- [Overview](concepts/overview.md) - start here
- [Registry & sync](concepts/registry-and-sync.md) - admins
- [Install & update lifecycle](concepts/install-lifecycle.md) - users
- [Review, approval & signing](concepts/attestation.md) - admins and security
- [The review rubric](concepts/rubric.md) - what is checked, and how to contribute a check (`rubric/README.md`)
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
`node scripts/bootstrap-vault.mjs <vaultPath> <registryUrl> [publicKeyFile]` (pass the public key to pin it and default to `require-signed`), then in Obsidian turn off Restricted mode
(Settings > Community plugins) and reload. Use the ribbon store icon or the "Browse internal plugins" command.

## Hosting the registry with an admin web UI (experimental)
For a container deployment, `docker compose up` runs the static registry and an admin service (mTLS and/or password
login, trigger sync/review, see status; approvals stay on the CLI). See [Admin service](admin.md).

## Provisioning vaults with the `om` CLI
For scripted setup (for example from a vault quickstart), `om` installs and checks plugins in a vault folder without Obsidian running:

```
om vaults                                      # vaults Obsidian knows (use a name or id as --vault)
om init --registry URL --vault Personal   # save settings once (or --all-vaults); fetches and pins URL/public-key.txt, prints its fingerprint
# or pin a key you got another way: om init --registry URL --key public-key.txt --vault Personal
om settings                                    # show what is saved and what is in effect
om marketplace                                 # install the marketplace plugin and point it at the registry
om install hello-notes other-plugin@1.2.0      # to the default vault; add --vault V or --all-vaults
om config  hello-notes --file preset.json [--force]   # merge settings into data.json
om status | update | verify
```
`om init` only saves settings (per user, never any secret) and touches no vault or network. Flags override env (`OM_REGISTRY`, `OM_PUBLIC_KEY`, `OM_TRUST_MODE`, `OM_VAULT`), which override `om.config.json` beside the program, which overrides the saved settings. The target vault is never guessed: it is `--vault`, `--all-vaults`, or the default you saved, and every result line is prefixed with the vault it ran on. It applies the same rules as the plugin: with the default `require-signed` mode only versions with a valid signed approval are installed, and downloads must match the hashes in `versions.json`. Pin the public key out of band (never fetch it from the registry host). `--json` gives machine-readable results; the exit status is non-zero on any failure. Build with `npm run build`; `npm run build:exe` produces a single `dist/om.exe` (the embedded Node binary's Authenticode signature is invalidated, so sign the exe if your policy requires it).

## Security notes
Use `require-signed` mode (see [Review, approval & signing](concepts/attestation.md)) so clients install only versions an
admin approved under a pinned key. Without signatures the sha256 values come from the same registry as the files and
only catch corruption. Only nominate repos you trust and restrict write access to the web root. Full model and known gaps:
[Security & trust model](concepts/security.md).

## Status
See the [project README](../README.md#status).
