# Demo playbook

An offline demonstration of the whole flow with two inert plugins and a fake GitHub:

- **hello-notes** (1.0.0, 1.1.0): a benign plugin that inserts the date and time. It should review clean and be approved.
- **shady-sync** (1.0.0): deliberately suspicious-looking and **inert** (nothing in it is ever called). It trips several checks and
  even contains a prompt-injection attempt aimed at the reviewing model. It should never reach users.

> **Status: draft, not yet run end to end.** The scripts below date from the command-line era and have not been re-run since the
> marketplace page, the admin dashboard, the containers and `om` were added. Each flow in the script has been exercised separately
> against the real stack (not with these fixtures), but nobody has performed the whole walkthrough yet. Run it once, fix what breaks,
> then remove this note. The to-do list is at the end.

## The story (what the audience sees)

Each act says where it happens and what to point out. "Expected" is what should happen, not a record of what was observed.

| # | Act | Where | Expected |
|---|---|---|---|
| 1 | **A user opens the marketplace page** | browser, `http://localhost:8080` | Plugins tab is empty ("nothing approved yet"); Get started shows the `om.exe` download and the three commands. |
| 2 | **Admin signs in** | dashboard, `https://localhost:8443` | Cards show 0 plugins; the tabs are Plugins, Clients, Activity, Repositories, Nominations, Rubric, Forwarding, Jobs. |
| 3 | **Nominate and add a repository** | Repositories tab (type `demo/hello-notes`, **Check**, **Add and sync**); optionally a nomination issue in the Nominations tab | The check shows the plugin id, its versions and that it is acceptable; both versions appear in the Plugins tab, **held back** from users. |
| 4 | **Review** | Plugins tab, **Review** on each version (or **Review all**) | hello-notes: `pass`. shady-sync: `fail` or `findings`, with hits for the checks it trips, and the report notes that the model was told to ignore the injection. The report includes the plugin's manifest. |
| 5 | **Report a finding** | shady-sync row, **Report issue** | Opens a prefilled issue page whose text is the review (manifest, checks, model findings). Do not post it in the demo. |
| 6 | **Approve** | hello-notes 1.0.0, **Approve** (signed by the separate signer container); shady-sync **cannot** be approved without an override reason | An "Approved" badge appears. The signer's log (`docker compose logs signer`) shows the signature. |
| 7 | **User installs** | marketplace page, then Obsidian: the **On-Prem Marketplace** plugin (store icon) | Only hello-notes is offered; it installs and enables. shady-sync is not listed. |
| 8 | **Update path** | approve hello-notes 1.1.0 | The plugin shows an update; installing it works. The Clients tab shows the version each client last fetched and the **compatibility** table (hello-notes 1.1.0 needs Obsidian 1.5.0). |
| 9 | **Tamper** | `.\demo\tamper.ps1`, then try to install or update | The client **refuses**: the file no longer matches the approved hash. `.\demo\tamper.ps1 -Undo` restores it. |
| 10 | **Pull a version back** | Plugins tab, **Withdraw** a version (and **Release** it again) | It disappears from, then returns to, what users see. Anything already installed stays installed; only new installs and updates change. |
| 11 | **The rubric** | Rubric tab | The list of checks, the version, and (after changing a rule) which reviews are stale and a free impact estimate. |

Say out loud in act 6 or 9: the admin container never holds the signing key, and a file changed on the web server after approval
fails the check on the client.

## Setup, command-line track (the existing scripts)

Runs on the host with Node and no containers. Good for acts 4 (reviews), 6 (approve on the command line), 7, 9. It has no dashboard and
no marketplace page, so acts 1 to 3, 5, 8 and 10 to 11 cannot be shown this way.

```powershell
npm install; npm run build
.\demo\00-preflight.ps1          # checks Node, builds, Claude Code, ANTHROPIC_API_KEY, free ports, fixtures
.\demo\01-reset.ps1              # new registry folder and signing key, fresh demo vault with the plugin and public key pinned
.\demo\02-start-servers.ps1      # fake GitHub on :9090, the registry on :8080
node packages/sync/dist/cli.js demo/registry.config.json
node packages/sync/dist/cli.js review --all --config demo/registry.config.json
node packages/sync/dist/cli.js approve hello-notes@1.0.0 --key demo/keys/signing-key.pem --registry demo/registry
```

Open `demo\vault` in Obsidian once and turn Restricted mode off before presenting.

## Setup, dashboard track (to build)

The goal is the full story above, from the containers, without touching your real registry folder. It does not exist yet. What it
needs:

1. A separate compose project (for example `docker compose -p om-demo`) with its **own** data folder (`demo/registry`), config
   folder (`demo/config`), audit volume and ports, so it can run next to a real deployment and never touches `registry-data/`.
2. The fake GitHub reachable **from the containers**: today it listens on `127.0.0.1` only, so it needs a host/bind option, and the
   demo `registry.config.json` must point `githubApiBase` at `http://host.docker.internal:9090` (to be confirmed on Rancher Desktop).
3. A demo admin config (test login, `registryUrl`, `githubWebBase`) and a demo signing key created by `01-reset.ps1`, mounted to the
   signer only. Never reuse a real key.
4. A review model for the reviewer container: `ANTHROPIC_API_KEY`, or an OpenAI-compatible service (see
   [Deploying](../docs/deploy.md#reviews-with-an-openai-compatible-model-service)). A pre-recorded reviewer answer would make the demo
   repeatable and free of cost; that is an option to consider.
5. `om.exe` published to the demo registry's downloads (`publish-download`), so the Get started tab is real.
6. A reset script for this track (stop, delete the demo folders, recreate).

## To do

- [ ] Run the command-line track end to end and fix whatever has drifted (flags, config names, ports).
- [ ] Build the dashboard track (list above), then run all eleven acts and correct the "Expected" column to what really happens.
- [ ] Record a new walkthrough (the existing recording shows only the Obsidian plugin lifecycle) and add it here.
- [ ] Remove the "draft" status note above and update the "Want to see it first?" line in the top-level README.

## Client plugin lifecycle

A recording of the lifecycle of the marketplace client plugin in an Obsidian vault.

![Marketplace client plugin lifecycle](demo_obsidian_onprem_marketplace_client.gif)

*(Recording: [demo_obsidian_onprem_marketplace_client.gif](demo_obsidian_onprem_marketplace_client.gif).)*
