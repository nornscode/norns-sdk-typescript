import { describe, expect, it } from "vitest";
import type { LlmTask, NeutralMessage } from "../src/format.js";
import { HistoryCache } from "../src/history-cache.js";

const user = (content: string): NeutralMessage => ({ role: "user", content });

function full(runId: number, messages: NeutralMessage[], extra: Partial<LlmTask> = {}): LlmTask {
  return { task_id: "t", run_id: runId, messages, ...extra };
}

function delta(runId: number, base_count: number, drop: number, append: NeutralMessage[]): LlmTask {
  return { task_id: "t", run_id: runId, messages_delta: { base_count, drop, append } };
}

describe("HistoryCache", () => {
  it("remembers a full task and applies deltas to it", () => {
    const cache = new HistoryCache();

    expect(cache.resolve(full(1, [user("hi")]))?.messages).toEqual([user("hi")]);

    const second = cache.resolve(delta(1, 1, 0, [{ role: "assistant", content: "yo" }]));
    expect(second?.messages).toEqual([user("hi"), { role: "assistant", content: "yo" }]);
    expect(second?.messages_delta).toBeUndefined();
    expect(second?.task_id).toBe("t");

    // A dropped prefix (compaction, a sliding window).
    const third = cache.resolve(delta(1, 2, 1, [user("more")]));
    expect(third?.messages?.map((m) => m.content)).toEqual(["yo", "more"]);
  });

  it("misses on an unknown or wrong-sized base, without disturbing what is held", () => {
    const cache = new HistoryCache();
    expect(cache.resolve(delta(7, 1, 0, []))).toBeUndefined();

    cache.resolve(full(7, [user("a"), user("b")]));
    expect(cache.resolve(delta(7, 1, 0, []))).toBeUndefined();
    expect(cache.resolve(delta(7, 2, 0, []))?.messages).toEqual([user("a"), user("b")]);
  });

  it("leaves the cache alone for compaction tasks", () => {
    const cache = new HistoryCache();
    cache.resolve(full(1, [user("a"), user("b")]));

    const compact = cache.resolve(full(1, [user("a")], { purpose: "compact" }));
    expect(compact?.messages).toEqual([user("a")]);
    expect(cache.resolve(delta(1, 2, 0, []))?.messages).toEqual([user("a"), user("b")]);
  });

  it("evicts the run used longest ago first", () => {
    const cache = new HistoryCache(2);
    for (const runId of [1, 2, 3]) cache.resolve(full(runId, [user(String(runId))]));

    expect(cache.size).toBe(2);
    expect(cache.resolve(delta(1, 1, 0, []))).toBeUndefined();
    expect(cache.resolve(delta(2, 1, 0, []))).toBeDefined();
    expect(cache.resolve(delta(3, 1, 0, []))).toBeDefined();
  });
});
