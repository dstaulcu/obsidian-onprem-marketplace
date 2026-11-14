import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isSafeVersion, isValidPluginId } from "@om/shared";

/**
 * Shared triage notes: plain text that admins leave on a plugin version ("waiting on the maintainer", "asked security").
 * Deliberately basic. Notes are NOT registry data: they live in the admin's own state folder, never in a path the
 * registry web server serves, and they never influence what clients can install (only a signed approval does).
 *
 * One JSON object per line, append-only, so it is easy to read from outside the admin (a ticketing integration, a log
 * shipper, grep). `ref` is a free-text pointer for such a system (for example a ticket number); the admin never follows it.
 */
export interface Note { id: string; plugin: string; version: string; by: string; at: string; text: string; ref?: string }

export const MAX_TEXT = 2000;
export const MAX_REF = 100;
export const MAX_FILE_BYTES = 5_000_000;
export const MAX_LISTED = 5000;

// Control characters other than newline and tab are dropped; the UI renders everything as text anyway.
const clean = (s: string) => s.replace(/[^\n\t -~ -￿]/g, "");

export class NoteError extends Error {}

export class NoteStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Note[]> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); } catch { return []; }
    const out: Note[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const n = JSON.parse(line) as Note;
        if (typeof n.id === "string" && typeof n.plugin === "string" && typeof n.version === "string" && typeof n.text === "string") out.push(n);
      } catch { /* a damaged line never hides the others */ }
    }
    return out.slice(-MAX_LISTED);
  }

  async add(by: string, plugin: unknown, version: unknown, text: unknown, ref?: unknown): Promise<Note> {
    if (typeof plugin !== "string" || !isValidPluginId(plugin) || typeof version !== "string" || !isSafeVersion(version)) throw new NoteError("invalid plugin id or version");
    if (typeof text !== "string") throw new NoteError("a note needs text");
    const body = clean(text).trim();
    if (!body) throw new NoteError("a note needs text");
    if (body.length > MAX_TEXT) throw new NoteError(`a note can be at most ${MAX_TEXT} characters`);
    let r: string | undefined;
    if (ref !== undefined && ref !== null && ref !== "") {
      if (typeof ref !== "string") throw new NoteError("ref must be text");
      r = clean(ref).replace(/[\n\t]/g, " ").trim().slice(0, MAX_REF) || undefined;
    }
    await mkdir(dirname(this.file), { recursive: true });
    const size = await stat(this.file).then((s) => s.size, () => 0);
    if (size > MAX_FILE_BYTES) throw new NoteError("the notes file is full; archive it and start a new one");
    const note: Note = { id: randomUUID(), plugin, version, by: clean(by).slice(0, 64), at: new Date().toISOString(), text: body, ...(r ? { ref: r } : {}) };
    await appendFile(this.file, JSON.stringify(note) + "\n", { mode: 0o600 });
    return note;
  }
}
