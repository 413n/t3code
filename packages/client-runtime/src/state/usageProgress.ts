import type { UsageProviderKind, UsageSummary } from "@t3tools/contracts";

interface UsageProgressEnvironment {
  readonly label: string;
  readonly isConnected: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Where one environment's answer stands for the usage on screen.
 *
 * - `inactive`: disconnected or failed, so waiting on it changes nothing.
 * - `loading`: no summary yet.
 * - `stale`: its summary on screen predates the current request.
 * - `partway`: answered this round while slow sources finish refreshing.
 * - `ready`: answered.
 *
 * `refreshingFrom` holds the summaries on screen when a manual refresh began.
 * They count as stale until replaced, since the refresh reaches each query only
 * after its environment refreshes pricing.
 */
export function usageEnvironmentProgress(
  environment: UsageProgressEnvironment,
  refreshingFrom: ReadonlySet<UsageSummary> | null = null,
) {
  const { summary } = environment;
  if (!environment.isConnected || environment.error !== null) return { phase: "inactive" } as const;
  if (summary === null) return { phase: "loading" } as const;
  if (refreshingFrom?.has(summary)) return { phase: "stale" } as const;
  // A refreshing source without a pending follow-up has nothing left to wait on.
  if (!environment.isPending) return { phase: "ready" } as const;
  const providers = [
    ...new Set(
      summary.sources.flatMap((source) => (source.refreshing ? [source.fingerprint.provider] : [])),
    ),
  ];
  return providers.length > 0
    ? ({ phase: "partway", providers } as const)
    : ({ phase: "stale" } as const);
}

export function updatingProvidersLabel(
  providers: readonly UsageProviderKind[],
  providerLabel: (provider: UsageProviderKind) => string,
) {
  return providers.length === 1
    ? `Updating ${providerLabel(providers[0]!)}…`
    : `Updating ${providers.length} providers…`;
}

/**
 * Loading state for the selected environments' merged usage.
 *
 * The page dims only while old numbers are all that is on screen. Once any
 * environment answers, the label carries what is still coming, so one slow
 * device never holds the page dimmed.
 */
export function usageProgress(
  environments: readonly UsageProgressEnvironment[],
  {
    refreshingFrom = null,
    providerLabel,
  }: {
    readonly refreshingFrom?: ReadonlySet<UsageSummary> | null;
    readonly providerLabel: (provider: UsageProviderKind) => string;
  },
) {
  const progress = environments.map((environment) => ({
    label: environment.label,
    ...usageEnvironmentProgress(environment, refreshingFrom),
  }));
  const waiting = progress.filter(({ phase }) => phase === "loading" || phase === "stale");
  const providers = [
    ...new Set(progress.flatMap((entry) => (entry.phase === "partway" ? entry.providers : []))),
  ];
  const answered = progress.some(({ phase }) => phase === "partway" || phase === "ready");
  return {
    dimmed: !answered && progress.some(({ phase }) => phase === "stale"),
    label:
      waiting.length === 0
        ? providers.length === 0
          ? null
          : updatingProvidersLabel(providers, providerLabel)
        : environments.length === 1
          ? "Updating…"
          : waiting.length === 1
            ? `Updating ${waiting[0]!.label}…`
            : `Updating ${waiting.length} environments…`,
  };
}

/**
 * Which figures in the merged usage on screen are still coming in, so clients
 * can mute just those.
 *
 * - `partial`: totals will change because some environment is still answering.
 * - `providers`: providers whose own figures will change. An environment that
 *   has not answered yet could add to any provider, so it sets `everyProvider`.
 */
export function usageLoadingState(
  environments: readonly UsageProgressEnvironment[],
  refreshingFrom: ReadonlySet<UsageSummary> | null = null,
) {
  const providers = new Set<UsageProviderKind>();
  let everyProvider = false;
  for (const environment of environments) {
    const progress = usageEnvironmentProgress(environment, refreshingFrom);
    if (progress.phase === "loading") everyProvider = true;
    if (progress.phase === "partway")
      for (const provider of progress.providers) providers.add(provider);
    if (progress.phase === "stale")
      for (const bucket of environment.summary?.buckets ?? []) providers.add(bucket.provider);
  }
  return { partial: everyProvider || providers.size > 0, everyProvider, providers };
}
