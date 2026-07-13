import type { ModelCost } from "../provider/registry.js";
import type { Usage } from "../types.js";
import type { TeamArtifactMetrics, TeamDepartmentMetrics } from "./types.js";

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cappedMaximum(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function saturatingAdd(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  const safeLeft = left ?? 0;
  const safeRight = right ?? 0;
  return safeLeft >= Number.MAX_SAFE_INTEGER - safeRight ? Number.MAX_SAFE_INTEGER : safeLeft + safeRight;
}

function usageField(value: unknown): number | undefined {
  return nonNegativeInteger(value);
}

/**
 * One SDK call can use multiple generation steps. The step cap is already
 * validated by Team configuration, so it safely bounds the reported count.
 * A completed generation always consumes at least one provider call even when
 * an adapter omits both steps and usage metadata.
 */
export function providerCallsFromSteps(steps: unknown, maxSteps: number): number {
  const maximum = cappedMaximum(maxSteps);
  const observed = Array.isArray(steps) ? steps.length : 0;
  const normalized = Number.isSafeInteger(observed) && observed > 0 ? observed : 1;
  return Math.min(maximum, normalized);
}

/** Use the final aggregate when available and retain step usage for omitted fields. */
export function mergeReportedUsage(stepUsage: Usage, finalUsage: Partial<Usage> | undefined): Usage {
  const final = finalUsage ?? {};
  return {
    inputTokens: usageField(final.inputTokens) ?? usageField(stepUsage.inputTokens),
    outputTokens: usageField(final.outputTokens) ?? usageField(stepUsage.outputTokens),
    totalTokens: usageField(final.totalTokens) ?? usageField(stepUsage.totalTokens),
  };
}

/**
 * Translate one model invocation into structured metrics. Calls without
 * complete input/output usage remain visible through unmeteredProviderCalls
 * rather than being silently treated as zero-cost work.
 */
export function metricsForUsage(
  usage: Usage | undefined,
  cost: Pick<ModelCost, "inputPerM" | "outputPerM">,
  providerCalls: number,
  toolCount = 0,
): TeamDepartmentMetrics {
  const calls = boundedProviderCalls(providerCalls, Number.MAX_SAFE_INTEGER);
  const inputTokens = usageField(usage?.inputTokens);
  const outputTokens = usageField(usage?.outputTokens);
  const reportedTotal = usageField(usage?.totalTokens);
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined
    ? saturatingAdd(inputTokens, outputTokens)
    : reportedTotal;
  const hasCompleteTokenUsage = inputTokens !== undefined && outputTokens !== undefined;
  const normalizedToolCount = nonNegativeInteger(toolCount) ?? 0;
  const tokenUsageKnown = inputTokens !== undefined || outputTokens !== undefined;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(tokenUsageKnown
      ? { costUsd: ((inputTokens ?? 0) * cost.inputPerM + (outputTokens ?? 0) * cost.outputPerM) / 1_000_000 }
      : {}),
    toolCount: normalizedToolCount,
    providerCalls: calls,
    unmeteredProviderCalls: hasCompleteTokenUsage ? 0 : calls,
  };
}

/**
 * Keep an externally reported count inside the local invocation cap. A nested
 * helper that completed without telemetry still reserves one provider call.
 */
export function boundedProviderCalls(value: unknown, maximum: number, fallback = 1): number {
  const ceiling = cappedMaximum(maximum);
  const normalizedFallback = Math.min(ceiling, Math.max(1, Math.floor(fallback)));
  const reported = nonNegativeInteger(value);
  if (reported === undefined || reported < normalizedFallback) return normalizedFallback;
  return Math.min(ceiling, reported);
}

/**
 * Aggregate task metrics without exposing model text or provider payloads.
 * `minimumCallsPerSample` is used at a department boundary to charge opaque
 * executors that completed but omitted metrics entirely.
 */
export function aggregateTeamMetrics(
  metrics: readonly (TeamArtifactMetrics | undefined)[],
  minimumCallsPerSample = 0,
): TeamDepartmentMetrics {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reportedTotalTokens: number | undefined;
  let costUsd: number | undefined;
  let toolCount: number | undefined;
  let providerCalls = 0;
  let unmeteredProviderCalls = 0;

  for (const metric of metrics) {
    const fallbackCalls = Math.max(0, Math.floor(minimumCallsPerSample));
    const reportedCalls = nonNegativeInteger(metric?.providerCalls);
    const calls = reportedCalls === undefined
      ? fallbackCalls
      : Math.max(fallbackCalls, reportedCalls);
    providerCalls = saturatingAdd(providerCalls, calls) ?? Number.MAX_SAFE_INTEGER;

    const metricInput = usageField(metric?.inputTokens);
    const metricOutput = usageField(metric?.outputTokens);
    inputTokens = saturatingAdd(inputTokens, metricInput);
    outputTokens = saturatingAdd(outputTokens, metricOutput);
    reportedTotalTokens = saturatingAdd(reportedTotalTokens, usageField(metric?.totalTokens));
    costUsd = saturatingAdd(costUsd, nonNegativeFinite(metric?.costUsd));
    toolCount = saturatingAdd(toolCount, nonNegativeInteger(metric?.toolCount));

    const reportedUnmetered = nonNegativeInteger(metric?.unmeteredProviderCalls);
    const incomplete = metricInput === undefined || metricOutput === undefined;
    const unmetered = reportedUnmetered === undefined
      ? (incomplete ? calls : 0)
      : Math.min(calls, reportedUnmetered);
    unmeteredProviderCalls = saturatingAdd(unmeteredProviderCalls, unmetered) ?? Number.MAX_SAFE_INTEGER;
  }

  const totalTokens = inputTokens !== undefined && outputTokens !== undefined
    ? saturatingAdd(inputTokens, outputTokens)
    : reportedTotalTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    providerCalls,
    unmeteredProviderCalls,
  };
}
