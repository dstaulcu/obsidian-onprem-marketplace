import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const derive = (pw: string, salt: Buffer, n = N, r = R, p = P) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

/** "scrypt$N$r$p$salt$hash" (base64 parts). Self-describing so cost can be raised later without breaking old entries. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${(await derive(pw, salt)).toString("base64")}`;
}

export async function verifyHash(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await derive(pw, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return want.length === got.length && timingSafeEqual(want, got);
}

export type Users = Record<string, string>;
export async function readUsers(file: string): Promise<Users> {
  try { const u = JSON.parse(await readFile(file, "utf8")); return u && typeof u === "object" ? u : {}; } catch { return {}; }
}
export async function setPassword(file: string, name: string, pw: string): Promise<void> {
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(name)) throw new Error("user names may contain letters, digits and . _ @ - (max 64)");
  if (pw.length < 12) throw new Error("password must be at least 12 characters");
  const users = await readUsers(file);
  users[name] = await hashPassword(pw);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(users, null, 2), { mode: 0o600 });
}

// A real hash to compare against when the user does not exist, so unknown users cost the same time as wrong passwords.
let dummy: Promise<string> | undefined;

/** Returns the user name on success. Never reveals whether the user or the password was wrong. */
export async function checkLogin(file: string, name: string, pw: string): Promise<string | null> {
  const users = await readUsers(file);
  const stored = Object.prototype.hasOwnProperty.call(users, name) ? users[name] : await (dummy ??= hashPassword("not-a-real-password"));
  const ok = await verifyHash(pw, stored);
  return ok && Object.prototype.hasOwnProperty.call(users, name) ? name : null;
}

/** In-memory failure counter per key (ip|user): `max` failures within the window lock that key out for `lockoutMs`. */
export class LoginLimiter {
  private fails = new Map<string, { n: number; first: number; lockedUntil: number }>();
  constructor(private max = 5, private windowMs = 15 * 60_000, private lockoutMs = 15 * 60_000, private now = () => Date.now()) {}
  locked(key: string): boolean { return (this.fails.get(key)?.lockedUntil ?? 0) > this.now(); }
  fail(key: string): void {
    const t = this.now(), e = this.fails.get(key);
    if (!e || t - e.first > this.windowMs) { this.fails.set(key, { n: 1, first: t, lockedUntil: 0 }); return; }
    e.n++;
    if (e.n >= this.max) e.lockedUntil = t + this.lockoutMs;
  }
  ok(key: string): void { this.fails.delete(key); }
}
