# Deploying to a cluster (handoff for the platform team)

Status: **experimental.** The system runs from `docker-compose.yml` (Rancher Desktop / Docker). Nothing here has been run on Kubernetes or
against your corporate network, so the Kubernetes parts below are a design to build and verify, not a tested recipe. The list of what is
unverified is at the end; please read it first.

## What runs

| Container | Image | Listens | Talks to | Holds |
|---|---|---|---|---|
| `registry` | `nginx:stable-alpine` | 80 (clients: Obsidian plugin, `om`, browsers) | nothing | read-only view of the registry files, the landing page and the PUBLIC key |
| `admin` | repo `Dockerfile` | 8443 (HTTPS; mTLS and/or password) | git servers (GitHub/GitLab), the tracker (nominations), Splunk (optional), the two queues | `GITHUB_TOKEN`, `NOMINATIONS_TOKEN`, `SPLUNK_HEC_TOKEN`; **never** the signing key or a model key |
| `reviewer` | `deploy/reviewer/Dockerfile` | none | the model service only | the model key |
| `signer` | `deploy/signer/Dockerfile` | none | **nothing** (no network) | the signing key |
| `logrotate` | `deploy/logrotate/Dockerfile` | none | nothing | nothing (rotates the access and audit logs) |
| `init` | `busybox` | one-shot | nothing | makes the data folders writable by the admin's user |

Why they are separate (please keep it that way): the admin is the web-facing process and the most exposed, so it must not be able to sign
anything or hold a model credential. The signer is the only thing that can create an approval; the admin verifies what it returns with the
public key. See `docs/concepts/security.md`.

**Run exactly one replica.** The admin is a single writer (one job at a time, file-based queues). There is no high availability; use
`strategy: Recreate`.

## Volumes (what must persist, and who shares what)

| Volume | Mounted by | Contents | Persist / back up |
|---|---|---|---|
| registry data (`/data`) | admin (rw), registry (ro), signer (ro) | the registry: plugin files, `index.json`, approvals, reviews, `downloads/` | **yes, back up** |
| audit (`/audit`) | admin, logrotate | the audit log **and the admin's state** (`/audit/state`: repositories added from the dashboard, triage notes, activity cursor, rubric snapshots) | **yes, back up** |
| queue (`/queue`) | admin, reviewer | review requests and answers | no (can be emptyDir) |
| signq (`/signq`) | admin, signer | approval requests and answers | no (can be emptyDir) |
| logs (`/logs`, `/var/log/om`) | registry (rw), admin (ro), logrotate | nginx access log, which the admin tails for the Clients tab | no, but forward it to Splunk if you want history |
| config (`/config`) | admin (ro), reviewer, signer (their own files only) | `admin.config.json`, `registry.config.json`, `admin-users.json`, TLS files, `public-key.txt` | from ConfigMap/Secret |

The simplest layout that matches what was tested is **one pod with these containers sharing the volumes** (the queues as `emptyDir`,
registry data and audit as PVCs). If you split them into separate pods, registry data needs a ReadWriteMany volume and the queues need
one too. The registry folder is a plain folder on purpose: the container writes it and nginx only reads it.

## Secrets: one container each

| Secret | Goes to | Never to |
|---|---|---|
| signing private key (PEM) | `signer` only, mounted at `/run/secrets/signing-key` | admin, reviewer, registry, any config file |
| model API key | `reviewer` only | admin |
| `GITHUB_TOKEN` (read releases; a token per server if you use several) | `admin` | reviewer, signer |
| `NOMINATIONS_TOKEN` (Issues read+write on the tracker repo only) | `admin` | everything else |
| `SPLUNK_HEC_TOKEN` | `admin` | |
| admin TLS key, user password hashes | `admin` (read-only) | |

The signing key's isolation is the security model. In Kubernetes make sure the admin's service account (and anyone with read access to
the namespace's secrets) cannot read the signing-key Secret; ideally use your external secret store (Vault, External Secrets, CSI driver)
and scope it to the signer's service account only. Environment variables named in config (`tokenEnv`, `apiKeyEnv`) hold names, never
values; no key material belongs in any config file.

**Key rotation is not designed yet.** Clients pin the public key the first time they run `om init`, and the plugin verifies approvals
against it, so replacing the key means every client has to re-trust the new one. Decide your custody (who can read the key, how it is
backed up or escrowed) before the first approval you care about.

## Reviews with an OpenAI-compatible model service

The reviewer container can use any service that speaks `POST {base_url}/chat/completions` with a bearer key. In
`registry.config.json`:

```json
"review": {
  "enabled": true,
  "provider": "openai-compatible",
  "model": "your-model-name",
  "openai": {
    "baseUrl": "https://llm.internal.example/v1",
    "apiKeyEnv": "REVIEW_API_KEY",
    "jsonMode": false,
    "maxPromptChars": 60000
  }
}
```

- Put the key in the reviewer's environment as `REVIEW_API_KEY` (the compose file and `.env.example` already pass it through). The
  admin never sees it.
- Build the reviewer image without the Claude Code CLI: `INSTALL_CLAUDE_CODE=false` (a build arg; a `.env` value for compose). The image
  then needs no access to the public npm registry for it.
- `maxPromptChars` is the most text the model takes per request, in characters, with room for its answer. Plugins larger than that are
  reviewed from excerpts, and the report says so ("PARTIAL"), instead of failing. Leave it out only if the model's context is large.
- `jsonMode` asks the server for `response_format: json_object`; turn it on only if your service supports it. Whatever comes back is
  validated against a strict schema; an answer that does not fit becomes an `error` verdict, never a pass.
- **Not tested against a real service.** Use **Review** on one version first and read the report before trusting verdicts.
  The deterministic checks run regardless of the model and set a floor the model cannot lower.
- If the service uses an internal certificate authority, set `NODE_EXTRA_CA_CERTS` to a mounted CA file on the **reviewer** (and on the
  admin if its git servers use one).

## Networking

- **Registry (clients):** serve it over HTTPS with a corporate-CA certificate at your ingress. Clients accept `http` or `https`, but
  without TLS the public key a new client pins is not protected in transit (an attacker on the path could substitute their own key).
  Give users the key fingerprint by another route if that matters.
- **Admin:** terminates its own TLS (mTLS and/or password). If you terminate TLS at the ingress instead, use passthrough, or add an
  authenticator for the ingress's headers (there is a seam for it in `packages/admin/src/auth/`, but none is built).
- **Real client addresses:** behind a load balancer nginx sees the balancer's address, so the Clients tab and Splunk would show one
  client. Copy `deploy/nginx-realip.example.conf` into `config/nginx-extra/realip.conf` (compose) or a ConfigMap mounted at
  `/etc/nginx/om-extra` and list only your balancer's addresses. Tested locally with a forged header from a listed address.
- **Probes:** `GET /healthz` on the registry (port 80) and on the admin (HTTPS 8443) returns `200 ok` and reveals nothing; probe hits
  are not logged. If the admin is configured for **mTLS only** (no password), the TLS handshake demands a client certificate that a
  probe cannot present, so use a `tcpSocket` probe instead.
- **Egress policy** (compose cannot enforce this, your network policy must):

| Pod/container | Allow out to |
|---|---|
| registry | nothing |
| signer | nothing |
| admin | the configured git servers, the tracker (`api.github.com` or your GitHub Enterprise), Splunk HEC if used; nothing else |
| reviewer | the model service only |

- **Corporate proxy and CA, to verify:** Node's built-in `fetch` does not use `HTTPS_PROXY` unless told to (check the proxy setting for your
  Node version, and test it); an internal CA needs `NODE_EXTRA_CA_CERTS`. The Windows `om.exe` embeds Node and may not trust the Windows
  certificate store, which could break `om init --registry https://...` with a corporate certificate. **Test this on a real work
  machine first.** Fallbacks: set `NODE_EXTRA_CA_CERTS` for the user, or pass `--key` with a key file.

## Hardening already in compose (carry into `securityContext`)

Non-root user `10001` (set `OM_UID`/`OM_GID`; use `fsGroup` so the PVCs are writable), `readOnlyRootFilesystem` with `/tmp` as a
tmpfs/emptyDir, `capabilities: drop: [ALL]`, `allowPrivilegeEscalation: false`. The `logrotate` container is the exception: it runs as
root with only `DAC_OVERRIDE`, `FOWNER`, `CHOWN`. You can replace it with your cluster's log rotation, but nginx's access log is a file the
admin tails (by inode and offset, and it copy-truncates), so it must stay on a shared volume and be rotated in place.

## Images and build

- The base images are unpinned tags (`node:22-slim`, `nginx:stable-alpine`, `busybox:stable`, `alpine:3.20`). Pin them by digest and
  pull from your internal mirror.
- The build runs `npm ci`: point it at your internal npm registry (`.npmrc`) and use the committed `package-lock.json`.
- `playwright-core` (`npm run ui-check`) is a development tool and is not in any runtime image.
- Tag images by the release; the dashboard does not yet show which commit it was built from.

## Configuring a downstream (work) fork

Keep the home repository as the upstream and change only values, not code: `githubApiBase` and `sources` (your GitHub Enterprise / GitLab
servers) in `registry.config.json`; `githubWebBase`, `registryUrl`, `rubricSourceUrl`, `rubricProposeUrl`, `nominations` in
`admin.config.json`; `nominateUrl`, `sourceBase`/`sourceBases`, `projectUrl`, `toolHint`, `contact` in `deploy/landing/landing.json`.
The Docs and Issues buttons in the admin header point at the upstream repository (a constant in `packages/admin/src/ui.ts`).

## Not verified (please test, and tell us what you find)

- Everything on Kubernetes (manifests, volumes, probes, network policy).
- The OpenAI-compatible reviewer against your real model service.
- `om.exe` over HTTPS with a corporate CA; Node and proxy settings in the containers.
- Real client addresses behind your load balancer (the nginx setting is tested only with a forged header locally).
- Splunk forwarding against a real HEC endpoint.
- GitLab with a private instance (asset downloads with a token), and the nomination write path (comment and close) against real GitHub
  with the dedicated token.
- The Obsidian plugin and `app.plugins` internals against your target Obsidian version (see `CLAUDE.md`).

## Order that worked locally (adapt)

1. Create `config/` (`admin.config.json`, `registry.config.json`, `public-key.txt`, TLS files, `admin-users.json`).
2. Create the signing key in your secret store; put the matching **public** key in `config/public-key.txt`.
3. Start the stack (`docker compose --profile signer up -d` locally); sign in; **Sync now**; **Review**; **Approve** one version.
4. From a client: `om init --registry <registry address> --vault "<vault>"`, then `om marketplace`.
