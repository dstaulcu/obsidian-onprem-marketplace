# Admin service

> **Experimental.** The admin service, client-activity view and Splunk forwarding are covered by unit tests. The
> container setup has been run once on Docker Desktop (build, mTLS login, sync, nginx log read, `stats.json`), but:
> nothing has been tried against a real Splunk; real Obsidian and `om` user agents have not been checked against the
> parser (only an Obsidian-style one I supplied); Docker Desktop shows every client as the bridge address
> (`172.18.0.1`), so zones and distinct counts are not meaningful there; and the dashboard page has not been viewed in
> a browser. Expect rough edges and do not expose it beyond a test network yet.

A small web interface for the registry admin: see what is mirrored, staged, reviewed and approved, and trigger **sync**
and **review**. It does not approve or sign anything: `approve` stays on the CLI, so the signing key never has to
live in the container (see [Security](#security-model)).

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

`GITHUB_TOKEN` and `ANTHROPIC_API_KEY` reach the service as environment variables (use your orchestrator's secret store).

## What it can do

`GET /api/plugins` (versions, review verdict, approval state), `POST /api/sync`, `POST /api/review`
(`{"all":true}` or `{"id","version"}`), `GET /api/jobs[/<id>]`. One job runs at a time (a second request gets 409).
Approvals and signed reviews are verified with the **public** key; an approval made with another key shows as invalid.
For anything unapproved the page shows the CLI command to run on the admin host.

Every login, denial, sync and review is appended to the audit log (`auditLog`, JSON lines, who/what/when/address; never
passwords or request bodies). Keep it on a volume that the registry web server cannot serve.

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

**Log rotation.** nginx does not rotate by itself. Use `logrotate` with `copytruncate` (or rotate and signal nginx), and
rotate daily or at a modest size. The reader detects a changed inode, a smaller file, or changed leading bytes and
restarts at the new content; lines written to a rotated-away file after the reader's last pass are lost, so keep the
polling gap (10 s) small relative to your rotation. Behind Docker Desktop, `$remote_addr` is often the bridge gateway
for every client; check what you see from another machine before relying on zones or distinct counts.

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
- **No signing in the UI.** Compromising an admin login lets an attacker trigger syncs and reviews and read status, but
  not sign approvals. Approvals still need the private key and a human on the CLI. Reviews are only signed if you
  mount a key (`review.signingKeyPath`); a signed review is not an approval, but clients using `requireReviewPass`
  trust one, so mounting the key widens what a compromised admin can do.
- **CSRF.** Browsers attach cookies and client certificates to cross-site requests, so every POST must carry
  `X-OM-Admin: 1` (forcing a CORS preflight that is never approved) and any `Origin` must match the host.
- **Untrusted data.** Plugin ids, versions and findings come from third-party repos. The UI renders them with
  `textContent` only, under a strict CSP with no inline script.
- **Brute force.** Passwords are scrypt-hashed; failures are rate-limited per user+address and per address; unknown
  users cost the same as wrong passwords.
- **Limits.** Sessions live in memory (a restart signs everyone out). Behind a reverse proxy the client address is the
  proxy's, so the per-address limit is coarser. There is no per-user role model: every allowed admin can do everything
  the UI offers. OIDC, trusted-proxy and LDAP authenticators can be added behind `Authenticator` (`src/auth/types.ts`).
