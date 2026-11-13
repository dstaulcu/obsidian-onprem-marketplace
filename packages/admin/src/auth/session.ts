import { randomBytes } from "node:crypto";
import type { Identity } from "./types";

/** Server-side sessions: the cookie holds an opaque random id only, so there is nothing to forge or decode. */
export class SessionStore {
  private s = new Map<string, { who: string; created: number; last: number }>();
  constructor(private idleMs = 30 * 60_000, private maxMs = 8 * 3_600_000, private now = () => Date.now()) {}

  create(who: string): string {
    const id = randomBytes(32).toString("base64url");
    this.s.set(id, { who, created: this.now(), last: this.now() });
    return id;
  }
  get(id: string | undefined): Identity | null {
    const e = id ? this.s.get(id) : undefined;
    if (!e) return null;
    const t = this.now();
    if (t - e.last > this.idleMs || t - e.created > this.maxMs) { this.s.delete(id!); return null; }
    e.last = t;
    return { name: e.who, method: "password" };
  }
  destroy(id: string | undefined): void { if (id) this.s.delete(id); }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
