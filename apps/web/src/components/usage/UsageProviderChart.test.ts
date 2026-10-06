import { describe, expect, it } from "vite-plus/test";

import {
  buildPeriodColumns,
  chartScale,
  mixSamples,
  niceScale,
  SAMPLE_XS,
  sampleCurve,
  smoothCurve,
  VIEW_WIDTH,
} from "./UsageProviderChart";
import { providersWithUsage } from "./usageProviders";

/** Points spread evenly across the plot, as the chart lays out its periods. */
const spread = (ys: readonly number[]) =>
  ys.map((y, index) => ({ x: (index * VIEW_WIDTH) / (ys.length - 1), y }));

describe("sampleCurve", () => {
  it("passes through every period exactly", () => {
    const points = spread([200, 40, 120, 260, 90]);
    const sampled = sampleCurve(
      smoothCurve(points),
      points.map((point) => point.x),
    );

    sampled.forEach((y, index) => expect(y).toBeCloseTo(points[index]?.y ?? Number.NaN, 9));
  });

  it("stays monotone between rising periods instead of overshooting", () => {
    const sampled = sampleCurve(smoothCurve(spread([250, 248, 120, 118, 10, 8])), SAMPLE_XS);

    sampled.slice(1).forEach((y, index) => expect(y).toBeLessThanOrEqual(sampled[index] ?? 0));
  });

  it("lands curves with different period counts on the same grid", () => {
    // Monotone cubics reproduce a straight line, so 7 and 30 periods of the
    // same trend must resample to the same values, sample for sample.
    const line = (count: number) =>
      sampleCurve(
        smoothCurve(
          spread(Array.from({ length: count }, (_, index) => 240 - (index * 200) / (count - 1))),
        ),
        SAMPLE_XS,
      );
    const weekly = line(7);
    const monthly = line(30);

    expect(weekly).toHaveLength(SAMPLE_XS.length);
    expect(monthly).toHaveLength(SAMPLE_XS.length);
    weekly.forEach((y, index) => expect(y).toBeCloseTo(monthly[index] ?? Number.NaN, 6));
    expect(weekly[0]).toBeCloseTo(240, 9);
    expect(weekly[weekly.length - 1]).toBeCloseTo(40, 9);
  });
});

describe("mixSamples", () => {
  it("runs from the old samples to the new ones", () => {
    const from = [0, 100, 200];
    const to = [200, 100, 0];

    expect(mixSamples(from, to, 0)).toEqual(from);
    expect(mixSamples(from, to, 1)).toEqual(to);
    expect(mixSamples(from, to, 0.25)).toEqual([50, 100, 150]);
  });
});

describe("chartScale", () => {
  const columns = [
    {
      total: 0,
      bands: [
        { provider: "codex" as const, value: 40 },
        { provider: "cursor" as const, value: 900 },
      ],
    },
  ];

  it("scales to providers that have answered", () => {
    const scale = chartScale(columns, ["codex", "cursor"], new Set(["cursor" as const]));

    expect(scale.max).toBe(40);
    expect(scale.labeled).toBe(true);
  });

  it("holds unlabeled placeholder gridlines until something answers", () => {
    const scale = chartScale(columns, ["codex", "cursor"], new Set(["codex", "cursor"] as const));

    expect(scale.labeled).toBe(false);
    expect(scale.ticks.length).toBeGreaterThan(1);
  });
});

describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    // Regression: an earlier version stopped at the last step below the peak,
    // so the tallest day was drawn past the plot and clipped.
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);

    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });

  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 30,
        totalTokens: 300,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
        ]),
      },
    ],
    // 2026-08-02 is deliberately absent: a day with no activity.
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("plots each day on its own", () => {
    expect(buildPeriodColumns(days, byDay, "cost").map((column) => column.total)).toEqual([
      30, 0, 5,
    ]);
  });

  it("reads the requested metric", () => {
    expect(buildPeriodColumns(days, byDay, "tokens").map((column) => column.total)).toEqual([
      300, 0, 50,
    ]);
  });

  it("keeps band values absolute rather than cumulative", () => {
    // Regression: the bands were once stack offsets, which drew Claude Code
    // permanently above Codex regardless of which provider spent more.
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
    ]);
  });

  it("reports the total as the sum of its bands", () => {
    for (const column of buildPeriodColumns(days, byDay, "cost")) {
      const sum = column.bands.reduce((running, band) => running + band.value, 0);
      expect(column.total).toBeCloseTo(sum, 9);
    }
  });
});

describe("providersWithUsage", () => {
  it("omits providers with no cost or tokens", () => {
    expect(
      providersWithUsage([
        { provider: "codex", costUsd: 0, totalTokens: 0 },
        { provider: "claude", costUsd: 0, totalTokens: 200 },
      ]),
    ).toEqual(["claude"]);
  });
});

describe("hourly chart columns", () => {
  it("zero-fills inactive hours and preserves hourly provider values", () => {
    const byHour = new Map([
      [
        "2026-08-11T09:37:00.000Z",
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T09:37:00.000Z",
          costUsd: 4,
          totalTokens: 40,
          byProvider: new Map([["codex" as const, { costUsd: 4, totalTokens: 40 }]]),
        },
      ],
    ]);

    expect(
      buildPeriodColumns(
        ["2026-08-11T08:37:00.000Z", "2026-08-11T09:37:00.000Z", "2026-08-11T10:37:00.000Z"],
        byHour,
        "cost",
      ).map((column) => column.total),
    ).toEqual([0, 4, 0]);
  });
});
