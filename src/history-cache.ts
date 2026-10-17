import type { LlmTask, NeutralMessage } from "./format.js";

/**
 * The message list Norns last sent this worker, per run.
 *
 * Once a worker joins with `features: ["message_cache"]`, Norns sends a run's
 * later steps as the change since the last task on this connection:
 * `messages_delta: { base_count, drop, append }` — of the `base_count`
 * messages held, drop the first `drop`, append the rest. A delta against a
 * base this worker does not hold is a miss: the worker answers
 * `message_cache_miss` and Norns resends the whole list at the same step.
 * Bounded by run count; the run used longest ago goes first.
 */
export class HistoryCache {
  readonly #runs = new Map<number | string, NeutralMessage[]>();
  readonly #maxRuns: number;

  constructor(maxRuns = 256) {
    this.#maxRuns = maxRuns;
  }

  /** The task with `messages` filled in, or `undefined` on a miss. */
  resolve(task: LlmTask): LlmTask | undefined {
    // A prefix to summarise, not the history; leaves the cache alone.
    if (task.purpose === "compact") return task;

    const runId = task.run_id;
    const delta = task.messages_delta;

    if (delta === undefined) {
      if (runId !== undefined && Array.isArray(task.messages)) this.#remember(runId, task.messages);
      return task;
    }

    const previous = runId === undefined ? undefined : this.#runs.get(runId);
    if (runId === undefined || previous === undefined || previous.length !== delta.base_count) {
      return undefined;
    }

    const messages = [...previous.slice(delta.drop), ...delta.append];
    this.#remember(runId, messages);
    const resolved: LlmTask = { ...task, messages };
    delete resolved.messages_delta;
    return resolved;
  }

  /** Forget everything: a new connection gets the full history anyway. */
  clear(): void {
    this.#runs.clear();
  }

  /** How many runs are held; for tests. */
  get size(): number {
    return this.#runs.size;
  }

  #remember(runId: number | string, messages: NeutralMessage[]): void {
    this.#runs.delete(runId);
    this.#runs.set(runId, messages);
    while (this.#runs.size > this.#maxRuns) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) break;
      this.#runs.delete(oldest);
    }
  }
}
