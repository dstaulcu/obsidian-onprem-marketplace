import { randomUUID } from "node:crypto";
import type { Log } from "@om/sync/src/jobs";

export interface Job {
  id: string; kind: string; who: string; status: "running" | "done" | "failed";
  started: string; finished?: string; output: string[]; error?: string;
}
export class Busy extends Error { constructor(public readonly running: Job) { super(`a ${running.kind} job is already running`); } }

const MAX_LINES = 2000;

/** One job at a time (sync and review both write the registry). Output is captured per job, newest 20 jobs kept. */
export class JobRunner {
  private jobs: Job[] = [];
  list(): Job[] { return this.jobs.slice().reverse(); }
  get(id: string): Job | undefined { return this.jobs.find((j) => j.id === id); }
  running(): Job | undefined { return this.jobs.find((j) => j.status === "running"); }

  start(kind: string, who: string, fn: (log: Log) => Promise<void>): Job {
    const r = this.running();
    if (r) throw new Busy(r);
    const job: Job = { id: randomUUID(), kind, who, status: "running", started: new Date().toISOString(), output: [] };
    this.jobs.push(job);
    if (this.jobs.length > 20) this.jobs.splice(0, this.jobs.length - 20);
    const push = (prefix: string) => (s: string) => { if (job.output.length < MAX_LINES) job.output.push(prefix + s); };
    fn({ log: push(""), err: push("! ") }).then(
      () => { job.status = "done"; job.finished = new Date().toISOString(); },
      (e) => { job.status = "failed"; job.error = (e as Error).message; job.finished = new Date().toISOString(); },
    );
    return job;
  }
}
