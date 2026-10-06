import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { UsageProviderKind } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { cn } from "~/lib/utils";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const SAMPLE_COUNT = 193;
const MORPH_MS = 500;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();

/** The fixed x grid every morph resamples onto, so any two curves can blend. */
export const SAMPLE_XS = Array.from(
  { length: SAMPLE_COUNT },
  (_, index) => (index * VIEW_WIDTH) / (SAMPLE_COUNT - 1),
);

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly providers: readonly UsageProviderKind[];
  /** Providers without data yet: flat along the bottom, left out of the scale, rising when they land. */
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
}

/** One day's per-provider values, shared by the paths and the hover readout. */
export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function valueFor(
  totals: DailyTotals | HourlyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = totals?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

export function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

export function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(segments: readonly CurveSegment[]): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

/**
 * Evaluates a curve at ascending x positions. Control points sit at x thirds,
 * so x is linear in t and each y is exact, wherever the periods fall.
 */
export function sampleCurve(segments: readonly CurveSegment[], xs: readonly number[]) {
  let index = 0;
  return xs.map((x) => {
    while (index < segments.length - 1 && x > (segments[index]?.to.x ?? x)) index += 1;
    const segment = segments[index];
    if (segment === undefined) return VIEW_HEIGHT;
    const { from, c1, c2, to } = segment;
    const span = to.x - from.x;
    const t = span === 0 ? 0 : Math.min(1, Math.max(0, (x - from.x) / span));
    const u = 1 - t;
    return u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y;
  });
}

/** Blends two sample sets on the shared grid: progress 0 is `from`, 1 is `to`. */
export function mixSamples(from: readonly number[], to: readonly number[], progress: number) {
  return from.map((y, index) => y + ((to[index] ?? y) - y) * progress);
}

/** Straight segments through samples; the grid is dense enough to read as a curve. */
function polylinePath(xs: readonly number[], ys: readonly number[]) {
  return ys
    .map((y, index) => `${index === 0 ? "M" : "L"}${(xs[index] ?? 0).toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
}

function areaPath(line: string) {
  return line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`;
}

/** A loading line: flat along the zero line until its usage lands. */
const FLAT_SAMPLES = SAMPLE_XS.map(() => VIEW_HEIGHT);
const FLAT_LINE = `M0,${VIEW_HEIGHT} L${VIEW_WIDTH},${VIEW_HEIGHT}`;

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest day drawn past the top of the plot, where it is
 * clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const PLACEHOLDER_TICKS = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index);

/**
 * Scales to the providers that have answered. Until any has, unlabeled
 * placeholder gridlines hold their usual spacing so nothing shifts on arrival.
 */
export function chartScale(
  columns: readonly DayColumn[],
  providers: readonly UsageProviderKind[],
  loadingProviders: ReadonlySet<UsageProviderKind>,
) {
  if (loadingProviders.size > 0 && providers.every((provider) => loadingProviders.has(provider))) {
    return { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false };
  }
  // The scale tops out at the largest single provider-period, not the sum:
  // layered series each measure from zero, so a combined peak would leave
  // the plot permanently half empty.
  const peak = columns.reduce(
    (max, column) =>
      column.bands.reduce(
        (inner, band) =>
          loadingProviders.has(band.provider) ? inner : Math.max(inner, band.value),
        max,
      ),
    0,
  );
  return { ...niceScale(peak, TICK_COUNT), labeled: true };
}

// Leave room above the top gridline so the constant-width stroke is not
// clipped when a series reaches the peak.
function valueToY(value: number, max: number) {
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

/** Per-provider shapes in paint order: answered curves heaviest first, loading providers flat. */
function buildChart(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
  providers: readonly UsageProviderKind[],
  loadingProviders: ReadonlySet<UsageProviderKind>,
) {
  const columns = buildPeriodColumns(periods, byPeriod, metric);
  const scale = chartScale(columns, providers, loadingProviders);
  const stepX = periods.length < 2 ? 0 : VIEW_WIDTH / (periods.length - 1);
  const shapes = providers.map((provider) => {
    const slot = PROVIDER_ORDER.indexOf(provider);
    if (loadingProviders.has(provider))
      return { provider, kind: "loading" as const, slot, total: 0 };
    const segments = smoothCurve(
      columns.map((column, periodIndex) => ({
        x: periodIndex * stepX,
        y: valueToY(column.bands[slot]?.value ?? 0, scale.max),
      })),
    );
    const line = curvePath(segments);
    return {
      provider,
      kind: "data" as const,
      slot,
      total: columns.reduce((sum, column) => sum + (column.bands[slot]?.value ?? 0), 0),
      segments,
      line,
    };
  });

  // Paint the heavier series first so the lighter one is not buried.
  return { columns, scale, stepX, shapes: shapes.toSorted((a, b) => b.total - a.total) };
}

type ChartShape = ReturnType<typeof buildChart>["shapes"][number];

/** One provider's drawn paths, its exact curve on the sample grid, and the morph moving it. */
interface DrawnSeries {
  readonly shape: ChartShape;
  readonly fill: SVGPathElement | null;
  readonly line: SVGPathElement | null;
  /** Null for a curve with fewer than two periods. */
  readonly curve: readonly number[] | null;
  motion: { readonly from: readonly number[]; readonly start: number } | null;
}

const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * What a series shows at `time`, so an interrupted morph continues from the
 * screen. Null when there is no curve to show.
 */
function shownSamples(series: DrawnSeries, time: number) {
  const { motion, curve: target } = series;
  if (motion === null || target === null || time >= motion.start + MORPH_MS) return target;
  const progress = Math.max(0, (time - motion.start) / MORPH_MS);
  return mixSamples(motion.from, target, easeOutCubic(progress));
}

function sameTarget(a: ChartShape, b: ChartShape) {
  return a.kind === "loading" ? b.kind === "loading" : b.kind === "data" && a.line === b.line;
}

/**
 * Writes one frame of a series straight to its paths and returns whether a
 * morph is still running. A settled curve gets its exact path.
 */
function drawSeries(series: DrawnSeries, time: number) {
  const moving = series.motion !== null && time < series.motion.start + MORPH_MS;
  const samples = shownSamples(series, time);
  const line = moving
    ? samples === null
      ? ""
      : polylinePath(SAMPLE_XS, samples)
    : series.shape.kind === "data"
      ? series.shape.line
      : FLAT_LINE;
  series.line?.setAttribute("d", line);
  series.fill?.setAttribute("d", areaPath(line));
  return moving;
}

/**
 * Drives the series paths outside React with short morphs between shapes. The
 * rAF loop runs only while a morph is in flight on a visible chart.
 */
function createSeriesAnimator() {
  let series: Map<UsageProviderKind, DrawnSeries> | null = null;
  let visible = true;
  let frame: number | null = null;
  let motionQuery: MediaQueryList | null = null;

  const reducedMotion = () => {
    motionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
    return motionQuery.matches;
  };
  const active = (entries: ReadonlyMap<UsageProviderKind, DrawnSeries>) =>
    [...entries.values()].some((entry) => entry.motion !== null);

  const tick = (time: number) => {
    frame = null;
    if (series === null) return;
    for (const entry of series.values()) {
      if (entry.motion !== null && !drawSeries(entry, time)) entry.motion = null;
    }
    if (active(series)) frame = requestAnimationFrame(tick);
  };

  const start = () => {
    if (frame === null && visible && series !== null && active(series)) {
      frame = requestAnimationFrame(tick);
    }
  };

  // A hidden chart lands every morph at once rather than resuming midway.
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    for (const entry of series?.values() ?? []) {
      entry.motion = null;
      drawSeries(entry, performance.now());
    }
  };

  return {
    /**
     * Points each provider's paths at its new shape. Changed series morph from
     * what is on screen; the first draw, an off-screen chart, and reduced
     * motion snap.
     */
    sync(shapes: readonly ChartShape[], svg: SVGSVGElement) {
      const now = performance.now();
      const animate = series !== null && visible && !reducedMotion();
      const next = new Map<UsageProviderKind, DrawnSeries>();
      for (const shape of shapes) {
        const kept = series?.get(shape.provider);
        if (kept !== undefined && sameTarget(kept.shape, shape)) {
          next.set(shape.provider, kept);
          continue;
        }
        const curve =
          shape.kind === "loading"
            ? FLAT_SAMPLES
            : shape.segments.length > 0
              ? sampleCurve(shape.segments, SAMPLE_XS)
              : null;
        // A provider that just appeared rises from the zero line.
        const from = !animate ? null : kept === undefined ? FLAT_SAMPLES : shownSamples(kept, now);
        const entry: DrawnSeries = {
          shape,
          fill: svg.querySelector<SVGPathElement>(`path[data-fill="${shape.provider}"]`),
          line: svg.querySelector<SVGPathElement>(`path[data-line="${shape.provider}"]`),
          curve,
          motion: from === null || curve === null ? null : { from, start: now },
        };
        next.set(shape.provider, entry);
        drawSeries(entry, now);
      }
      series = next;
      start();
    },
    setVisible(next: boolean) {
      visible = next;
      if (visible) start();
      else stop();
    },
    stop,
  };
}

export function UsageProviderChart({
  providers,
  loadingProviders = NONE_LOADING,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
}: UsageProviderChartProps) {
  const periods = resolution === "hour" ? hours : days;
  const byPeriod = useMemo(
    () =>
      resolution === "hour"
        ? new Map(hourly.map((entry) => [entry.hourStart, entry]))
        : new Map(daily.map((entry) => [entry.day, entry])),
    [daily, hourly, resolution],
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [animator] = useState(createSeriesAnimator);

  const { columns, scale, shapes, stepX } = useMemo(
    () => buildChart(periods, byPeriod, metric, providers, loadingProviders),
    [byPeriod, loadingProviders, metric, periods, providers],
  );
  const toY = (value: number) => valueToY(value, scale.max);
  // Once anything has answered, lines still loading fade back behind it.
  const fadeLoading = providers.some((provider) => !loadingProviders.has(provider));
  const seriesClassName = (kind: ChartShape["kind"]) =>
    cn("transition-opacity duration-300", fadeLoading && kind === "loading" && "opacity-30");

  // Series paths are written by the animator rather than rendered, so morphs
  // never re-render.
  useLayoutEffect(() => {
    if (svgRef.current !== null) animator.sync(shapes, svgRef.current);
  }, [animator, shapes]);

  // Morphs land at once while the chart is off screen or the tab is hidden.
  useEffect(() => {
    const plot = plotRef.current;
    let intersecting = true;
    const update = () =>
      animator.setVisible(intersecting && document.visibilityState === "visible");
    const observer =
      plot === null || typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            for (const entry of entries) intersecting = entry.isIntersecting;
            update();
          });
    if (plot !== null) observer?.observe(plot);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
      animator.stop();
    };
  }, [animator]);

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, positionTooltip]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (periods.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length, positionTooltip],
  );

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
  const hoveredTotal =
    hoveredColumn?.bands.reduce(
      (sum, band) => (loadingProviders.has(band.provider) ? sum : sum + band.value),
      0,
    ) ?? 0;
  const partial = providers.some((provider) => loadingProviders.has(provider));
  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, timeZone) : formatDayShort(period);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone)
      : formatPeriod(period);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {scale.labeled
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))
            : null}
        </div>

        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            ref={svgRef}
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "cost"} by provider`}
          >
            {scale.ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {shapes.map(({ provider, kind }) => (
              <path
                key={provider}
                data-fill={provider}
                className={seriesClassName(kind)}
                fill={PROVIDER_PRESENTATION[provider].color}
                fillOpacity={0.12}
              />
            ))}
            {shapes.map(({ provider, kind }) => (
              <path
                key={provider}
                data-line={provider}
                className={seriesClassName(kind)}
                fill="none"
                stroke={PROVIDER_PRESENTATION[provider].color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
              {providers.map((provider) => {
                const { label, driverKind } = PROVIDER_PRESENTATION[provider];
                return (
                  <div key={provider} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <ProviderInstanceIcon
                        driverKind={driverKind}
                        displayName={label}
                        iconClassName="size-3"
                      />
                      {label}
                    </span>
                    {loadingProviders.has(provider) ? (
                      <span className="text-muted-foreground">…</span>
                    ) : (
                      <span className="text-foreground tabular-nums">
                        {format(
                          hoveredColumn?.bands.find((band) => band.provider === provider)?.value ??
                            0,
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                {scale.labeled ? (
                  <span className="text-foreground tabular-nums">
                    {format(hoveredTotal)}
                    {partial ? <span className="text-muted-foreground">+</span> : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">…</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}
