import type { IncomingMessage } from "node:http";

export interface Identity { name: string; method: "mtls" | "password" }
/** Turns a request into an identity, or null if this authenticator does not recognise it. New methods (trusted proxy, OIDC) plug in here. */
export interface Authenticator { authenticate(req: IncomingMessage): Identity | null }
