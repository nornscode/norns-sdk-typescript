import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";

export const MAX_REMEMBERED_RESULTS = 512;

/**
 * What this worker has already done, by idempotency key.
 *
 * Kept on disk, because the case it exists for is the worker dying: Norns
 * re-dispatches the call it was holding, and a worker that came back with
 * an empty head would do the side effect a second time, which is the exact
 * thing the key is supposed to prevent.
 *
 * It is a crash guard, not a ledger. Bounded, best-effort, and never allowed
 * to take a worker down: if the file cannot be read or written, the worker
 * runs with memory alone and says so once.
 */
export class CompletedCalls {
  #path: string | undefined;
  readonly #limit: number;
  readonly #entries = new Map<string, Record<string, unknown>>();
  readonly #logger: Logger;

  constructor(path: string | undefined, logger: Logger, limit = MAX_REMEMBERED_RESULTS) {
    this.#path = path;
    this.#limit = limit;
    this.#logger = logger;
    this.#load();
  }

  get path(): string | undefined {
    return this.#path;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): Record<string, unknown> | undefined {
    const entry = this.#entries.get(key);
    return entry ? { ...entry } : undefined;
  }

  add(key: string, result: Record<string, unknown>): void {
    this.#entries.delete(key);
    this.#entries.set(key, result);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#save();
  }

  #load(): void {
    if (!this.#path) return;
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#logger.warn(
          `Could not read ${this.#path} (${(err as Error).message}); starting with no memory of completed calls`,
        );
      }
      return;
    }
    try {
      const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object") this.#entries.set(key, value);
      }
    } catch (err) {
      this.#logger.warn(
        `Could not parse ${this.#path} (${(err as Error).message}); starting with no memory of completed calls`,
      );
    }
  }

  #save(): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#entries)));
      renameSync(tmp, this.#path);
    } catch (err) {
      this.#logger.warn(
        `Could not write ${this.#path} (${(err as Error).message}); completed calls will not survive a restart`,
      );
      this.#path = undefined;
    }
  }
}

/**
 * Where a worker keeps what it has already done: `NORNS_STATE_DIR` if set
 * (empty disables), else a directory under the system temp dir. Enough to
 * outlive the process, which is the failure this guards, and nothing a
 * project has to clean up.
 */
export function completedCallsPath(
  workerId: string,
  stateDir: string | null | undefined,
): string | undefined {
  const base = stateDir === undefined ? process.env.NORNS_STATE_DIR : stateDir;
  if (base === "" || base === null) return undefined;
  const root = base ?? join(tmpdir(), "norns-worker-state");
  const safe = workerId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return join(root, `${safe}.completed.json`);
}
