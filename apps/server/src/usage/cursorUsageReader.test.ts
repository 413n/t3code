import { assert, describe, it } from "@effect/vitest";

import { CursorKeychainTimeoutError } from "../provider/cursorKeychainToken.ts";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";

const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
const baseMs = 1780000000000;

const events = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, offset) => ({
    timestamp: String(baseMs + from + offset),
    model: "gpt-5",
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
  }));

const read = (request: (url: string, init: RequestInit) => Promise<Response>) =>
  readCursorAccountUsage({ kind: "keychain" }, 0, baseMs * 2, request, async () => accessToken);

const requestedPage = (init: RequestInit) => Number(JSON.parse(String(init.body)).page);

/** Holds every request issued in one synchronous burst, then answers the burst newest first. */
function reversedBursts(respond: (page: number) => unknown) {
  const pages: number[] = [];
  const completed: number[] = [];
  const held: (() => void)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const request = async (_url: string, init: RequestInit) => {
    const page = requestedPage(init);
    pages.push(page);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    if (held.length === 0) {
      queueMicrotask(() => {
        for (const release of held.splice(0).toReversed()) release();
      });
    }
    await new Promise<void>((resolve) => held.push(resolve));
    inFlight--;
    completed.push(page);
    return Response.json(respond(page));
  };
  return { request, pages, completed, maxInFlight: () => maxInFlight };
}

const offsets = (records: readonly { readonly timestampMs: number }[]) =>
  records.map((record) => record.timestampMs - baseMs);

const sequence = (length: number) => Array.from({ length }, (_, index) => index);

describe("readCursorAccountUsage", () => {
  it("asks for Keychain approval when the prompt goes unanswered", async () => {
    const result = await readCursorAccountUsage(
      { kind: "keychain" },
      0,
      1,
      () => Promise.reject(new Error("no network expected")),
      () => Promise.reject(new CursorKeychainTimeoutError()),
    );
    assert.deepStrictEqual(result, {
      accountKey: null,
      records: [],
      missing: false,
      error: "Allow Keychain access on the Mac running T3 Code, then refresh.",
    });
  });

  it("fetches pages after the first concurrently and keeps them in page order", async () => {
    const total = 9500;
    const { request, pages, completed, maxInFlight } = reversedBursts((page) => ({
      totalUsageEventsCount: total,
      usageEventsDisplay: events((page - 1) * 1000, Math.min(page * 1000, total)),
    }));
    const result = await read(request);
    assert.isNull(result.error);
    assert.deepStrictEqual(offsets(result.records), sequence(total));
    assert.deepStrictEqual(
      pages.toSorted((a, b) => a - b),
      sequence(10).map((index) => index + 1),
    );
    assert.notDeepEqual(
      completed,
      completed.toSorted((a, b) => a - b),
    );
    assert.isAbove(maxInFlight(), 1);
    assert.isBelow(maxInFlight(), 9);
  });

  it("reconciles boundary overlap across concurrent pages and continues past the expected range", async () => {
    const total = 2999;
    const { request, pages, maxInFlight } = reversedBursts((page) => ({
      totalUsageEventsCount: total,
      usageEventsDisplay:
        page === 1
          ? events(0, 1000)
          : page === 2
            ? events(999, 1999)
            : page === 3
              ? events(1999, 2999)
              : [],
    }));
    const result = await read(request);
    assert.isNull(result.error);
    assert.deepStrictEqual(offsets(result.records), sequence(total));
    assert.strictEqual(new Set(result.records.map((record) => record.dedupeKey)).size, total);
    assert.strictEqual(maxInFlight(), 2);
    assert.strictEqual(pages.at(-1), 4);
  });

  it("aborts in-flight pages and stops requesting after the first failure", async () => {
    for (const { status, error } of [
      { status: 500, error: "Cursor account usage could not be read." },
      { status: 401, error: "Sign in to Cursor again to read account usage." },
    ]) {
      const pages: number[] = [];
      const signals: AbortSignal[] = [];
      const result = await read(async (_url, init) => {
        const page = requestedPage(init);
        pages.push(page);
        if (page === 1) {
          return Response.json({
            totalUsageEventsCount: 30_500,
            usageEventsDisplay: events(0, 1000),
          });
        }
        if (page === 3) return new Response(null, { status });
        const signal = init.signal;
        if (!signal) throw new Error("Missing abort signal");
        signals.push(signal);
        return new Promise<Response>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      });
      assert.strictEqual(result.error, error);
      assert.deepStrictEqual(result.records, []);
      assert.isAbove(signals.length, 0);
      assert.isTrue(signals.every((signal) => signal.aborted));
      assert.isBelow(pages.length, 31);
    }
  });

  it("reads pages one at a time when the first page has no total", async () => {
    const { request, pages, maxInFlight } = reversedBursts((page) => ({
      usageEventsDisplay: events((page - 1) * 1000, page === 3 ? 2500 : page * 1000),
    }));
    const result = await read(request);
    assert.isNull(result.error);
    assert.deepStrictEqual(offsets(result.records), sequence(2500));
    assert.deepStrictEqual(pages, [1, 2, 3]);
    assert.strictEqual(maxInFlight(), 1);
  });
});
