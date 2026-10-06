import { assert, describe, it } from "@effect/vitest";

import { cursorFetchRanges, mergeCursorFetches } from "./cursorAccountCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const record = (timestampMs: number): UsageRecord => ({
  provider: "cursor",
  timestampMs,
  model: "claude-fable-5",
  sessionId: "conversation-1",
  totals: {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: `cursor-account:a:${timestampMs}:0`,
});

describe("cursorAccountCache", () => {
  it("does not claim the unfetched gap after a cache that ended before the window", () => {
    const cache = {
      accountKey: "a",
      sinceMs: 0,
      untilMs: 10 * DAY_MS,
      fetchedAtMs: 10 * DAY_MS,
      records: [record(5 * DAY_MS)],
    };
    const nowMs = 60 * DAY_MS;
    const ranges = cursorFetchRanges(cache, 59 * DAY_MS, nowMs);
    assert.deepStrictEqual(ranges, [{ sinceMs: 59 * DAY_MS, untilMs: nowMs }]);

    const merged = mergeCursorFetches(
      cache,
      "a",
      ranges.map((range) => ({ range, records: [record(59.5 * DAY_MS)] })),
      nowMs,
      0,
    );
    assert.strictEqual(merged.sinceMs, 59 * DAY_MS);
    assert.deepStrictEqual(
      merged.records.map((entry) => entry.timestampMs),
      [59.5 * DAY_MS],
    );
    // A wider window now fetches the history it is missing.
    assert.deepStrictEqual(cursorFetchRanges(merged, 30 * DAY_MS, nowMs), [
      { sinceMs: 30 * DAY_MS, untilMs: 59 * DAY_MS },
    ]);
  });
});
