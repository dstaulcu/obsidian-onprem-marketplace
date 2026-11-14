# Admin service

> **Experimental.** The admin service, client-activity view and Splunk forwarding are covered by unit tests. The
> container setup has been run once on Docker Desktop (build, mTLS login, sync, nginx log read, `stats.json`), but:
> nothing has been tried against a real Splunk; real Obsidian and `om` user agents have not been checked against the
> parser (only an Obsidian-style one I supplied); Docker Desktop shows every client as the bridge address
> (`172.18.0.1`), so zones and distinct counts are not meaningful there; and the dashboard page has not been viewed in
> a browser. Expect rough edges and do not expose it beyond a test network yet.

A small web interface for the registry admin: see what is mirrored, staged, reviewed and approved, and trigger **sync**
and **review**, withdraw or release versions, and (optionally) **approve**. The admin process never holds the signing key: approving
is done by a separate [signer container](#approving-from-the-dashboard-the-signer), or on the CLI where the key lives (see
[Security](#security-model)).

It is one dependency-free Node process (`packages/admin`, `om-admin`) beside the static registry. There is no external
identity provider; login is **client certificates (mTLS)**, **local passwords**, or both.

## Login methods

| Method | How it works | Use when |
| --- | --- | --- |
| mTLS | The TLS handshake verifies the client certificate against your admin CA (`tls.clientCa`); `mtls.allow` then lists which certificates (subject CN, or SHA-256 fingerprint) may administer. A valid certificate that is not listed is refused. | Preferred. Nothing to phish or brute-force. |
| Password | `admin-users.json` holds scrypt hashes. Login sets an opaque, server-side session cookie (`HttpOnly`, `SameSite=Strict`, `Secure`), with idle and absolute expiry. Repeated failures lock the user+address out. | Browsers without a certificate installed. |

With both enabled the server asks for a certificate but does not require one, so password users can still connect.
TLS is mandatory; the service refuses to start without it unless `allowInsecureHttp` is set (development only).

## Setup

1. **Certificates.** With an existing CA, issue a server certificate and a client certificate per admin. A throwaway CA
   for trying it out:
   ```
   openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out admin-ca.crt -days 365 -subj "/CN=om-admin-ca"
   openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=registry-admin.example.internal"
   printf "subjectAltName=DNS:registry-admin.example.internal\nextendedKeyUsage=serverAuth\n" > server.ext
   openssl x509 -req -in server.csr -CA admin-ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile server.ext
   # per admin (import the .p12 into the browser or OS certificate store)
   openssl req -newkey rsa:2048 -nodes -keyout alice.key -out alice.csr -subj "/CN=alice@example.internal"
   printf "extendedKeyUsage=clientAuth\n" > client.ext
   openssl x509 -req -in alice.csr -CA admin-ca.crt -CAkey ca.key -CAcreateserial -out alice.crt -days 365 -extfile client.ext
   openssl pkcs12 -export -inkey alice.key -in alice.crt -out alice.p12
   ```
   Keep `ca.key` offline; the service only needs `admin-ca.crt`.
2. **Config.** Copy `admin.config.example.json` to `config/admin.config.json` and edit. `registry.config.json` there
   must use `"outDir": "/data"` and should **not** set `review.signingKeyPath` unless you accept the trade-off below.
   Put the registry public key in `config/public-key.txt` (the admin view uses it only to verify approvals).
3. **Passwords (optional).** On the host: `node packages/admin/dist/admin.cjs passwd alice --users config/admin-users.json`
   (prompted, min 12 characters; or `OM_ADMIN_PASSWORD` for scripting).
4. **Run.** `docker compose up --build` starts the admin on `https://localhost:8443` and the read-only registry on
   `http://localhost:8080`. The registry is the host folder **`./registry-data`** (created on first start, gitignored),
   served read-only by nginx and written by the admin container. On Linux first run
   `export OM_UID=$(id -u) OM_GID=$(id -g)` so files the admin writes stay editable by you. Without Docker:
   `npm run build`, then `node packages/admin/dist/admin.cjs serve --config admin.config.json`.
5. **Sync, then approve.** Use the dashboard's Sync button. Then sign what you trust **on your own machine**, where the
   private key lives (it never enters the container):
   ```
   node packages/sync/dist/cli.js approve <id@version> --key keys/signing-key.pem --registry registry-data [--override "reason"]
   ```
   The registry is served straight from that folder, so the approval is visible to clients immediately and the dashboard
   shows it as approved. `--override` is needed unless a passing review exists.

`GITHUB_TOKEN` reaches the admin as an environment variable (use your orchestrator's secret store). `ANTHROPIC_API_KEY` goes to the separate **reviewer** container only; see [Reviews](#reviews-in-a-separate-container). Compose reads both from a `.env` file (copy `.env.example`; it is gitignored).

## What it can do

`GET /api/plugins` (versions, review verdict, approval state), `POST /api/sync`, `POST /api/review`
(`{"all":true}` or `{"id","version"}`, plus `"force":true` to redo a single version), `POST /api/approve` (only with a signer), `POST /api/manage`, `GET|POST /api/notes`, `GET /api/jobs[/<id>]`. One job runs at a time (a second request gets 409).
Approvals and signed reviews are verified with the **public** key; an approval made with another key shows as invalid.
For anything unapproved the page shows the CLI command to run on the admin host.

Every login, denial, sync and review is appended to the audit log (`auditLog`, JSON lines, who/what/when/address; never
passwords or request bodies). Keep it on a volume that the registry web server cannot serve.

## Managing versions

Each version row in the Plugins tab has **Withdraw** (or **Release** for a held-back version). Both ask for a second click.
The API is `POST /api/manage` with `{"action","id","version"}`, where action is one of:

| Action | Effect |
| --- | --- |
| `withdraw` | Removes the approval and moves the version from `versions.json` to `staged.json`, so clients no longer see it. |
| `revoke` | Removes only the approval (`approval.json` and its signature). |
| `hold` | Hides a published version without touching its approval. |
| `release` | Publishes a held-back version again, but only if the publish policy allows it (with `approved`, it needs a valid approval; with `reviewed-pass`, a passing review). |

These only ever make the clients' view stricter, or restore what the policy already permits. None of them can create an approval.
They run as audited jobs (`manage.<action>`), so they cannot interleave with a sync or review. **Copies already installed on
clients stay installed**: clients cannot be told to uninstall, and there is no signed revocation list yet (see
[Security](concepts/security.md)). The files stay in the registry, so a withdrawn version can be released again.

## Reporting findings to the plugin's repository

A reviewed version with verdict `findings` or `fail` gets a **Report issue** link. It opens the plugin repository's new-issue page with a
short prefilled title and text (the verdict and a link to the full report) in a new tab. You read it, edit it and post it under your own
GitHub login: nothing is sent from the admin and no token is involved. The text never contains model output, because that is derived
from untrusted code. The link is built from the repository recorded in `index.json` (shape-checked) and the GitHub web address, which
defaults to the host of `githubApiBase` (`api.github.com` becomes `https://github.com`); set `githubWebBase` in the admin config to
override it for an on-prem server. Consider whether a public repository is the right place for a security finding before posting it.

## Triage notes

The **Notes** button on a version row opens a side panel where any admin can leave a plain-text note (up to 2000 characters, plus an
optional reference such as a ticket number). Notes are shared between admins, append-only, and stored in `<stateDir>/notes.jsonl`,
one JSON object per line, never in the served registry. They are for people: they do not affect what clients can install. The file
is meant to be easy to consume elsewhere (`GET /api/notes`, or read the file), and each note produces a `note.add` audit event (ids only,
not the text), so a log shipper or ticketing integration can react to it. There are deliberately no statuses or assignees; a ticketing
system is better at that.

## Approving from the dashboard (the signer)

An approval is a signature that tells every client "install this", so the key that makes it never enters the admin process. Approving
from the dashboard uses a third small container, `signer`, which is optional (`docker compose --profile signer up -d`):

| Step | Who | What |
| --- | --- | --- |
| 1 | admin | An admin clicks **Approve** (a version with a passing review needs a second click; anything else needs a written reason). The admin queues `{id, version, by, reason}` in the `signq` volume. |
| 2 | signer | Re-reads the plugin files from the registry (read-only) and recomputes their hashes. Refuses unless a review matching those exact files passed, or a reason was given (recorded inside the signed approval). Rate limited to 30 a minute. Signs. Logs the decision. |
| 3 | admin | Verifies the signature with the PUBLIC key, checks it covers exactly the hashes on disk and names the logged-in admin, then writes `approval.json` and its signature into the registry. A bad answer is a failed job and writes nothing. |

The signer has **no network at all** (`network_mode: none`), no ports, a read-only root and a read-only registry. It cannot be asked to
sign arbitrary bytes, only an approval for a version that is in the registry. It refuses to start if its key does not match
`public-key.txt`. Every signature and refusal is written to the signer's own log (`docker compose logs signer`), where a compromised
admin cannot erase it; the admin also writes `approve.start`, `approve` (with the review verdict and any reason) and `approve.failed`
to its audit log, which Splunk forwards.

Setup: put the signing key in your secret store. In Compose it is a file secret read from `secrets/signing-key.pem` (gitignored); on
Kubernetes or Rancher mount a Secret at `/run/secrets/signing-key`, or set `OM_SIGNING_KEY` to the PEM. Make the file readable by the
container user (on Linux set `OM_UID`/`OM_GID` to its owner). Then add `"signerQueue": "/signq"` and a `publicKeyFile` to
`config/admin.config.json` and start with `--profile signer`. If the signer is down, **Approve** fails immediately with a clear message
and the CLI still works. Single-admin approval is the default; the admin's identity is whoever is logged in.

**What this does and does not protect.** A stolen admin login can no longer sign anything itself, but it can ask the signer to approve a
version that is in the registry and has a passing review (or any version, with a written reason). The audit trail and the signer's own log
are what make that visible. The signer trusts the `review.json` it finds in the registry, which the admin writes; if you need the review
itself to be tamper-evident, sign reviews (`review.signingKeyPath`) and treat that as a separate decision.

## Reviews in a separate container

Reviews send third-party plugin code to a model, so the process that does that does not share a container with the admin
login, the registry write access or the GitHub and Splunk tokens. Compose runs a second service, `reviewer`, and the two
talk through a folder (the `queue` volume):

| Step | Who | What |
| --- | --- | --- |
| 1 | admin | Verifies the files against `versions.json`, runs the static checks, builds the prompt, writes it to `queue/requests/<uuid>.json`. |
| 2 | reviewer | Takes the request (deleting it claims it), calls the model, writes only the raw answer to `queue/results/<uuid>.json`. |
| 3 | admin | Reads and deletes the answer, validates it against the schema, applies the secret filter, decides the verdict, and writes `review.html` and `review.json` itself. |

The reviewer has no ports, no registry files, no signing key and only `registry.config.json` (not the rest of `config/`,
which holds TLS keys and password hashes). The admin container has no Anthropic key at all. Whatever comes back is untrusted:
a missing, oversized (over 256 KB), malformed or secret-containing answer becomes an `error` verdict, never a pass, and nothing
the reviewer writes ever lands in the served registry.

To turn it on, set `"reviewQueue": "/queue"` in `config/admin.config.json` and give `config/registry.config.json` a review section:
```json
"review": { "enabled": false, "provider": "claude-code", "model": "claude-sonnet-5-5", "maxBudgetUsd": 0.5, "maxReviewsPerRun": 5 }
```
`enabled` only controls automatic reviews after a sync; the **Review all** button works either way. Put `ANTHROPIC_API_KEY` in
`.env`. The reviewer needs to reach `api.anthropic.com`; Compose cannot allow-list outbound hosts, so restrict that with your
network policy.

- **Reviewer down:** the reviewer touches a heartbeat file every 5 seconds. If it is older than 30 seconds, **Review all** is refused
  at once (503, "the reviewer container is not running") and a sync skips its reviews, rather than each version waiting out a timeout
  and recording an error.
- **Signed reviews:** if you set `review.signingKeyPath`, the admin (not the reviewer) signs the record, so that key would sit in the
  admin container. The reviewer never needs it.
- **"Ephemeral":** each review runs in a fresh temporary directory that is deleted afterwards, but the reviewer container itself is long
  running. A container per review is possible under an orchestrator that can start Jobs (for example Kubernetes), without giving the admin
  access to a container runtime; the queue protocol would stay the same.
- **Limits:** one review at a time. A reviewer crash mid-review loses that request; the admin times out after 6 minutes and records an
  error verdict, and the next run reviews it again. `wrapper` harnesses that read plugin files from disk (`stageFiles`) are refused with a
  queue, because only the prompt crosses it. Stale files in the queue are swept after an hour.
- **Image:** `deploy/reviewer/Dockerfile` installs Claude Code from npm (about 850 MB). Pin it with
  `--build-arg CLAUDE_CODE_VERSION=<version>`; the default is `latest`. Without `reviewQueue`, reviews run inside the admin process
  using the configured provider, which then needs its credentials in the admin container.

## Client activity (server-side only)

Nothing is reported by clients. The admin service reads the **registry web server's access log** and derives activity
from it. `deploy/nginx-om.conf` (mounted by `docker-compose.yml`) writes that log as one JSON object per line to
`/var/log/om/access.log`, logging the path without query strings; the admin mounts the same volume read-only and sets
`"accessLog": "/logs/access.log"`.

| Signal | Meaning |
| --- | --- |
| Successful `GET plugins/<id>/<version>/main.js` | Indicator of an **install or update** (`install: true` in the event). |
| `GET index.json` / `plugins/<id>/versions.json` | A client **checked in**. |
| User agent | Obsidian's desktop agent normally includes its version and OS; `om` is recognised if it sends `om/<version>`. Anything else is "other". |
| `networks` | Optional IPv4 table (`{ "cidr": "10.20.0.0/16", "name": "Engineering" }`) turning addresses into zone labels. |

The dashboard shows known clients (last seen, client, OS, zone, address), a plugin x version table of what clients
**last fetched** (labelled latest / behind / unapproved / not in registry by joining with the registry), and recent
events. **This is inferred state.** The server cannot see what is installed or enabled; a failed download, a shared
office address or a copied URL all distort it. Treat it as operational insight, never as proof, and never as input to
a trust decision.

Hardening: the log is attacker-influenced (any host can send any path or user agent), so each line is parsed on its own,
only exact registry paths with valid ids and versions are accepted, fields are length-capped and stripped of control
characters, failed requests (404 probes) create no clients or counts, and the client table is capped at 5000 entries.
Aggregates and the read position are saved in **one atomic file** under `stateDir` (default `<auditLog dir>/state`),
so a restart neither resets counts nor counts lines twice; client keys in the counts are salted hashes. Raw addresses
exist only in the admin-only client table, never in anything the registry web server can serve.

**Log rotation and retention.** `docker-compose.yml` includes a `logrotate` container (no network, only the two log volumes) that checks hourly and rotates the nginx access log and the admin audit log with `copytruncate`, compressing old files. Set these in the environment or a `.env` file next to `docker-compose.yml`, then run `docker compose up -d`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OM_ACCESS_LOG_DAYS` | 14 | Daily access log files kept. |
| `OM_AUDIT_LOG_DAYS` | 14 | Daily audit log files kept. Raise it if you must answer who did what further back. |
| `OM_LOG_MAX_SIZE` | 50M | Rotate early once a log passes this size (`100k`, `50M`, `1G`). |

Invalid values (0, text) fall back to the default with a warning in `docker compose logs logrotate`, so a typo cannot delete your logs. Total disk use is roughly retention days times daily volume. Docker's own container output is capped at 3 x 10 MB per service. Dashboard counts and last-seen times live in `<stateDir>/activity.json` and are not affected by rotation. Without Splunk, the retention above is all the raw request history you have. The reader detects a changed inode, a smaller file or changed leading bytes and restarts at the new content; lines written between its last pass (10 s) and a rotation are lost, so the access log is not a guaranteed record. Behind Docker Desktop, `$remote_addr` is often the bridge gateway for every client; check what you see from another machine before relying on zones or distinct counts.

### Published popularity stats

With `"stats": { "publish": true, "windowDays": 30, "minCount": 5 }` the service writes **`stats.json`** into the registry
root (temp file + rename) every five minutes: distinct clients that downloaded `main.js` per plugin and per version over
the window. Counts below `minCount` are withheld, and the file contains no addresses or user agents. It is approximate
and unsigned: anyone can request `main.js` repeatedly, shared addresses undercount, and a failed download still counts.
Display it as "approx." and never use it for trust. (The marketplace listing does not read it yet.)

## Forwarding events to Splunk

```json
"splunk": {
  "url": "https://splunk.example.internal:8088",
  "tokenEnv": "SPLUNK_HEC_TOKEN",
  "index": "obsidian_registry",
  "sourcetype": "om:event",
  "source": "om-admin",
  "caFile": "/config/tls/splunk-ca.crt",
  "forward": ["access", "audit"]
}
```

- **Token:** from the environment variable named by `tokenEnv`, or a file named by `tokenFile`. It is never read from this
  config file and never appears in logs, errors or API responses.
- **TLS:** `https://` is required (`allowInsecureHttp` exists for development only). For a self-signed Splunk certificate
  give `caFile`; certificate verification is never switched off.
- **Payload:** one HEC event per record to `/services/collector/event`, `Authorization: Splunk <token>`, with `time` set to
  the **original** event time. `index` is omitted unless configured (an index the token cannot write to makes HEC reject
  the whole batch). Streams: `access` (the events above) and `audit` (login, denied, sync, review actions as
  `admin.<action>`). Cookies, session ids, passwords and request bodies are never forwarded.
- **Delivery is at-least-once.** The read position only advances after HEC answers 200, with exponential backoff
  (5 s up to 5 min) while it does not. Each event has a stable `id` (`<stream>:<byte offset>`) so a re-sent batch can be
  de-duplicated in Splunk. A Splunk outage never blocks the dashboard or the API (separate cursor), and the log simply
  keeps growing until it recovers. The first time it is enabled it starts at the **end** of the log; set
  `"backfill": true` to send the existing history.
- **Check it:** `node packages/admin/dist/admin.cjs splunk-test --config admin.config.json` sends one test event and
  prints Splunk's answer; the dashboard's Forwarding line shows events sent, last success and the last error.

Event fields (`schema: 1`; names are a contract, new fields may be added but existing ones are not renamed):
`id, time, type (plugin.download | catalog.check | admin.*), plugin, version, file, status, bytes, install, client{kind,version,os,ua}, addr, zone`.

## Security model

- **Separate listener.** Clients read the registry from a static, read-only server. The admin listens elsewhere; the
  registry volume is writable only by the admin container.
- **No signing key in the admin.** Compromising an admin login lets an attacker trigger syncs and reviews, withdraw versions and read
  status, but not sign approvals itself: signing happens in the separate signer container (see above), which re-checks the files and the
  review, and its answer is verified before use. A stolen login can still ask the signer to approve something that passes its checks, so
  watch the audit log and the signer's own log. Reviews are only signed if you mount a key (`review.signingKeyPath`); a signed review is
  not an approval, but clients using `requireReviewPass` trust one, so mounting that key into the admin widens what a compromised admin
  can do.
- **CSRF.** Browsers attach cookies and client certificates to cross-site requests, so every POST must carry
  `X-OM-Admin: 1` (forcing a CORS preflight that is never approved) and any `Origin` must match the host.
- **Untrusted data.** Plugin ids, versions and findings come from third-party repos. The UI renders them with
  `textContent` only, under a strict CSP with no inline script.
- **Brute force.** Passwords are scrypt-hashed; failures are rate-limited per user+address and per address; unknown
  users cost the same as wrong passwords.
- **Limits.** Sessions live in memory (a restart signs everyone out). Behind a reverse proxy the client address is the
  proxy's, so the per-address limit is coarser. There is no per-user role model: every allowed admin can do everything
  the UI offers. OIDC, trusted-proxy and LDAP authenticators can be added behind `Authenticator` (`src/auth/types.ts`).
