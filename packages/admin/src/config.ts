import { readFile } from "node:fs/promises";
import { validNetwork, type Network } from "./events";
import { validateSplunk, type SplunkConfig } from "./splunk";

export interface AdminConfig {
  listen?: { host?: string; port?: number };
  /** Server certificate/key; `clientCa` turns on client-certificate (mTLS) login. */
  tls?: { cert: string; key: string; clientCa?: string };
  /** Plain HTTP is refused unless this is set explicitly (development only). */
  allowInsecureHttp?: boolean;
  /** registry.config.json used by the sync and review jobs. */
  registryConfig: string;
  publicKeyFile?: string;
  /** Web address of the GitHub server, used to build "report an issue" links. Default: derived from the sync config's githubApiBase. */
  githubWebBase?: string;
  /** Where the rubric lives in the source repository (its rubric/ folder), shown on the Rubric tab so admins can review it and its history. */
  rubricSourceUrl?: string;
  /** The repository's new-issue page (https://host/owner/repo/issues/new), used for "propose a change" links. */
  rubricProposeUrl?: string;
  /** Public URL of the static registry, used for report links in the UI. */
  registryUrl?: string;
  mtls?: { allow: string[] };
  password?: { usersFile: string; idleMinutes?: number; maxHours?: number; maxFailures?: number; lockoutMinutes?: number };
  auditLog: string;
  /**
   * The registry web server's access log in the `om` JSON format (deploy/nginx-om.conf). Mounted read-only; it can
   * contain every client's address and user agent, so it must not sit in the served registry tree.
   */
  accessLog?: string;
  /** Strip this prefix from logged paths when the registry is served below a sub-path, e.g. "/registry". */
  basePath?: string;
  /** Where cursors and client aggregates are kept (never inside the served tree). Default: <auditLog dir>/state. */
  stateDir?: string;
  /** Labels for client addresses, e.g. { "cidr": "10.20.0.0/16", "name": "Engineering" }. IPv4 only. */
  networks?: Network[];
  /** Counts-only stats.json written into the registry for the marketplace listing. Needs accessLog. */
  stats?: { publish?: boolean; windowDays?: number; minCount?: number };
  /**
   * Directory shared with the separate reviewer container (see docs/admin.md). When set, reviews are never run in this
   * process: the prompt is queued, the reviewer container (which holds the model credentials) answers, and the answer is
   * validated here exactly like a local one. Leave unset to review in-process (needs the provider's credentials here).
   */
  reviewQueue?: string;
  /**
   * Directory shared with the separate signer container (see docs/admin.md). When set, the dashboard can approve versions: the
   * signing key never enters this process; the signer signs, and this service verifies the answer with the public key before
   * writing it into the registry. Needs publicKeyFile. Leave unset to keep approving on the command line.
   */
  signerQueue?: string;
  /** Stream events to Splunk HEC. The token comes from an env var or file, never from this config. */
  splunk?: SplunkConfig;
}

/** Fails closed: refuses configurations that would expose a login over plaintext or enable a method with nothing behind it. */
export function validateConfig(c: AdminConfig): string[] {
  const e: string[] = [];
  if (!c.registryConfig) e.push("registryConfig is required");
  if (!c.auditLog) e.push("auditLog is required");
  if (!c.mtls && !c.password) e.push("enable at least one of \"mtls\" or \"password\"");
  if (!c.tls && !c.allowInsecureHttp) e.push("\"tls\" is required (set allowInsecureHttp only for local development)");
  if (c.mtls && !c.tls?.clientCa) e.push("mtls needs tls.clientCa (the CA that issues admin client certificates)");
  if (c.mtls && !c.mtls.allow?.length) e.push("mtls.allow is empty: no certificate would be authorised");
  if (c.password && !c.password.usersFile) e.push("password.usersFile is required");
  for (const n of c.networks ?? []) if (!validNetwork(n)) e.push(`networks: bad entry ${JSON.stringify(n)} (need an IPv4 "a.b.c.d/len" and a name)`);
  if (c.githubWebBase !== undefined && !/^https?:[/][/][^/ ]+$/.test(c.githubWebBase)) e.push("githubWebBase must look like https://github.example.internal (no path)");
  for (const [k, v] of [["rubricSourceUrl", c.rubricSourceUrl], ["rubricProposeUrl", c.rubricProposeUrl]] as const)
    if (v !== undefined && !/^https?:[/][/][^\s?#]+$/.test(v)) e.push(`${k} must be an http(s) address without a query or fragment`);
  if (c.signerQueue !== undefined && (typeof c.signerQueue !== "string" || !c.signerQueue)) e.push("signerQueue must be a directory path");
  if (c.signerQueue && !c.publicKeyFile) e.push("signerQueue needs publicKeyFile: approvals returned by the signer are verified with it before they are used");
  if (c.reviewQueue !== undefined && (typeof c.reviewQueue !== "string" || !c.reviewQueue)) e.push("reviewQueue must be a directory path");
  if (c.stats?.publish && !c.accessLog) e.push("stats.publish needs accessLog");
  if (c.stats) {
    if (c.stats.windowDays !== undefined && !(c.stats.windowDays >= 1 && c.stats.windowDays <= 90)) e.push("stats.windowDays must be 1-90");
    if (c.stats.minCount !== undefined && !(c.stats.minCount >= 1)) e.push("stats.minCount must be at least 1");
  }
  if (c.splunk) {
    e.push(...validateSplunk(c.splunk));
    if (!c.accessLog && !(c.splunk.forward ?? ["audit"]).every((s) => s === "audit") && c.splunk.forward) e.push("splunk.forward includes \"access\" but accessLog is not set");
  }
  return e;
}

export async function loadAdminConfig(file: string): Promise<AdminConfig> {
  const c = JSON.parse(await readFile(file, "utf8")) as AdminConfig;
  const errs = validateConfig(c);
  if (errs.length) throw new Error(`${file}: ${errs.join("; ")}`);
  return c;
}
