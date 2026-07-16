import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { KyreiEvent, RuntimeTeamRole, RuntimeTeamSpec } from "../types.js";
import { createConcurrencyGate } from "../orchestration/delegate.js";
import { redact } from "../security/secrets.js";
import { isPrivateAddress } from "../web/browser.js";
import { executeTeamTaskGraph } from "./execute.js";
import type {
  TeamArtifact,
  TeamArtifactMetrics,
  TeamSourceReceipt,
  TeamTaskExecutionContext,
  TeamTaskResult,
  TeamTaskSpec,
} from "./types.js";

const MAX_ARTIFACT_TEXT = 2_400;
const MAX_ARTIFACT_ITEMS = 16;
const MAX_ARTIFACT_ITEM_TEXT = 600;
const DEFAULT_MODEL_RESULT_CHARS = 12_000;

export interface TeamRoleRunRuntime {
  runId: string;
  subagentId: string;
  onProgress: (text: string) => void;
  /** Internal-only partial meter, used to charge a failed direct department safely. */
  onMetrics?: (metrics: TeamArtifactMetrics) => void;
  /** Cumulative run budget shared by every nested helper. */
  reserveNestedAgent: () => void;
}

export interface TeamRoleExecutor {
  role: RuntimeTeamRole;
  run: (
    context: TeamTaskExecutionContext,
    runtime: TeamRoleRunRuntime,
  ) => Promise<TeamArtifact>;
}

export interface TeamDelegateToolOptions {
  spec: RuntimeTeamSpec;
  executors: readonly TeamRoleExecutor[];
  emit: (event: KyreiEvent) => void;
  abortSignal?: AbortSignal;
  /** Maximum JSON characters returned to the acting model by one tool call. */
  maxResultChars?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function compact(value: unknown, max = MAX_ARTIFACT_TEXT): string {
  return typeof value === "string" ? redact(value.trim()).slice(0, max) : "";
}

function publicWebUrl(value: unknown): string {
  const candidate = compact(value, 1_000);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return "";
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "";
    if (isIP(host) && isPrivateAddress(host)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ARTIFACT_ITEMS).flatMap((item) => {
    const text = compact(item, MAX_ARTIFACT_ITEM_TEXT);
    return text ? [text] : [];
  });
}

function sourceReceipts(value: unknown): TeamSourceReceipt[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const receipts: TeamSourceReceipt[] = [];
  for (const item of value.slice(0, MAX_ARTIFACT_ITEMS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const id = compact(source.id, 80);
    const requestedUrl = publicWebUrl(source.requestedUrl);
    const finalUrl = publicWebUrl(source.finalUrl);
    const title = compact(source.title, 300);
    const contentDigest = compact(source.contentDigest, 128).toLowerCase();
    const fetchedAt = compact(source.fetchedAt, 40);
    if (!id || seen.has(id) || !requestedUrl || !finalUrl || !title
      || !/^[a-f0-9]{64}$/u.test(contentDigest) || Number.isNaN(Date.parse(fetchedAt))) continue;
    seen.add(id);
    receipts.push({ id, requestedUrl, finalUrl, title, contentDigest, fetchedAt });
  }
  return receipts;
}

const MAX_APPLICABLE_PATCH_BYTES = 64 * 1_024;

function normalizedArtifact(taskId: string, role: RuntimeTeamRole, value: TeamArtifact): TeamArtifact {
  const sources = sourceReceipts(value?.sources);
  const applicablePatch = typeof value?.applicablePatch === "string"
    && value.applicablePatch.length > 0
    && Buffer.byteLength(value.applicablePatch, "utf8") <= MAX_APPLICABLE_PATCH_BYTES
    ? value.applicablePatch
    : undefined;
  return {
    taskId,
    summary: compact(value?.summary) || "No summary returned.",
    provenance: [
      `engine:role:${role.id}`,
      `engine:provider:${role.target.providerId}`,
      `engine:model:${role.target.model}`,
      ...stringList(value?.provenance).map((item) => `reported:${item}`),
    ].slice(0, MAX_ARTIFACT_ITEMS),
    confidence: Number.isFinite(value?.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : 0.5,
    evidence: stringList(value?.evidence).map((item) => (
      item.startsWith("observed:") || item.startsWith("reported:") ? item : `reported:${item}`
    )),
    validation: stringList(value?.validation),
    uncertainties: stringList(value?.uncertainties),
    whatWasNotChecked: stringList(value?.whatWasNotChecked),
    ...(applicablePatch ? { applicablePatch } : {}),
    ...(sources.length ? { sources } : {}),
    ...(value?.metrics
      ? {
          metrics: {
            inputTokens: value.metrics.inputTokens,
            outputTokens: value.metrics.outputTokens,
            totalTokens: value.metrics.totalTokens,
            costUsd: value.metrics.costUsd,
            toolCount: value.metrics.toolCount,
            providerCalls: value.metrics.providerCalls,
            unmeteredProviderCalls: value.metrics.unmeteredProviderCalls,
          },
        }
      : {}),
  };
}

function combineSignals(...candidates: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const signals = [...new Set(candidates.filter((signal): signal is AbortSignal => Boolean(signal)))];
  if (signals.length === 0) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => undefined };
  }
  if (signals.length === 1) return { signal: signals[0]!, cleanup: () => undefined };
  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const listener = () => controller.abort(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach(({ signal, listener }) => signal.removeEventListener("abort", listener)),
  };
}

function taskResultForModel(result: TeamTaskResult, summaryChars = 600): Record<string, unknown> {
  switch (result.status) {
    case "succeeded":
      return {
        id: result.task.id,
        status: result.status,
        summary: compact(result.artifact.summary, summaryChars),
        confidence: result.artifact.confidence,
        provenance: result.artifact.provenance.slice(0, 4).map((item) => compact(item, 200)),
        evidence: result.artifact.evidence.slice(0, 4).map((item) => compact(item, 300)),
        sources: (result.artifact.sources ?? []).slice(0, 3).map((source) => ({
          id: source.id,
          finalUrl: source.finalUrl,
          title: source.title,
          contentDigest: source.contentDigest,
          fetchedAt: source.fetchedAt,
        })),
        validation: result.artifact.validation.slice(0, 3).map((item) => compact(item, 300)),
        uncertainties: result.artifact.uncertainties.slice(0, 2).map((item) => compact(item, 300)),
        whatWasNotChecked: result.artifact.whatWasNotChecked.slice(0, 2).map((item) => compact(item, 300)),
      };
    case "failed":
      return { id: result.task.id, status: result.status, error: compact(errorMessage(result.error), 2_000) };
    case "blocked":
      return { id: result.task.id, status: result.status, blockedBy: result.blockedBy };
    case "aborted":
      return { id: result.task.id, status: result.status, reason: compact(errorMessage(result.reason ?? "aborted"), 1_000) };
  }
}

function serializeTeamResult(
  runId: string,
  workflow: RuntimeTeamSpec["workflow"],
  results: readonly TeamTaskResult[],
  maxChars: number,
): string {
  const limit = Math.max(500, Math.min(200_000, Math.floor(maxChars) || DEFAULT_MODEL_RESULT_CHARS));
  const completedTasks = results.filter((result) => result.status === "succeeded").length;
  const base = {
    runId,
    workflow,
    completedTasks,
    failedTasks: results.length - completedTasks,
  };
  const tasks: Record<string, unknown>[] = [];
  for (const [index, result] of results.entries()) {
    const detailed = taskResultForModel(result);
    const remaining = results.length - index - 1;
    const candidate = JSON.stringify({ ...base, tasks: [...tasks, detailed], ...(remaining ? { omittedTaskCount: remaining } : {}) });
    if (candidate.length <= limit) {
      tasks.push(detailed);
      continue;
    }
    const minimal = taskResultForModel(result, 120);
    if ("evidence" in minimal) delete minimal.evidence;
    if ("sources" in minimal) delete minimal.sources;
    if ("validation" in minimal) delete minimal.validation;
    if ("uncertainties" in minimal) delete minimal.uncertainties;
    if ("whatWasNotChecked" in minimal) delete minimal.whatWasNotChecked;
    const compactCandidate = JSON.stringify({ ...base, tasks: [...tasks, minimal], ...(remaining ? { omittedTaskCount: remaining } : {}) });
    if (compactCandidate.length <= limit) tasks.push(minimal);
    break;
  }
  const omittedTaskCount = results.length - tasks.length;
  const serialized = JSON.stringify({ ...base, tasks, ...(omittedTaskCount ? { omittedTaskCount } : {}) });
  if (serialized.length <= limit) return serialized;
  return JSON.stringify({ ...base, tasks: [], omittedTaskCount: results.length });
}

export function buildTeamDelegateTool(options: TeamDelegateToolOptions): ToolSet {
  if (!options.executors.length || !options.spec.roles.length) return {};
  const executorById = new Map(options.executors.map((executor) => [executor.role.id, executor]));
  // One gate is shared by every invocation of this tool instance. Parallel
  // tool calls must not multiply the configured provider-call concurrency.
  const taskSlots = createConcurrencyGate(options.spec.limits.maxParallel);
  const taskSchema = z.object({
    id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    goal: z.string().trim().min(1).max(20_000),
    memberId: z.string().trim().min(1).max(64).optional(),
    dependsOn: z.array(z.string().trim().min(1).max(80)).max(options.spec.limits.maxTasks).optional(),
  });
  const inputSchema = z.object({
    tasks: z.array(taskSchema).min(1).max(options.spec.limits.maxTasks),
  });
  const description = options.spec.workflow === "consensus"
    ? "Ask every configured Team role the same bounded question independently. Do not set memberId or dependsOn. " +
      "Kyrei fans each question out across providers; compare provenance and evidence instead of counting votes."
    : "Run a bounded dependency graph through the configured multi-provider Team. " +
      "Assign memberId when a particular role is required. Independent nodes run in parallel; " +
      "dependsOn artifacts are passed to downstream nodes. Use evidence and verifier nodes instead of majority vote.";

  return {
    team_delegate: tool({
      description,
      inputSchema,
      execute: async (input, executionOptions) => {
        const parsed = inputSchema.parse(input);
        const tasks: TeamTaskSpec[] = options.spec.workflow === "consensus"
          ? parsed.tasks.flatMap((task, taskIndex) => {
              if (task.memberId || task.dependsOn?.length) throw new Error("consensus_task_shape_invalid");
              return options.executors.map((executor, roleIndex) => ({
                id: `c${taskIndex}-${roleIndex}-${task.id.slice(0, 30)}-${executor.role.id.slice(0, 30)}`.slice(0, 80),
                goal: task.goal,
                memberId: executor.role.id,
                dependsOn: [],
              }));
            })
          : parsed.tasks.map((task, index) => {
              const memberId = task.memberId ?? options.executors[index % options.executors.length]!.role.id;
              if (!executorById.has(memberId)) throw new Error(`team_role_unavailable:${memberId}`);
              return { id: task.id, goal: task.goal, memberId, dependsOn: task.dependsOn ?? [] };
            });
        if (tasks.length > options.spec.limits.maxTasks) throw new Error("team_task_budget_exceeded");
        if (tasks.length > options.spec.limits.maxAgents) {
          throw new Error("team_agent_budget_exceeded");
        }
        const taskIndex = new Map(tasks.map((task, index) => [task.id, index]));
        const runId = `team:${options.spec.profileId}:${randomUUID()}`;
        let agentsUsed = tasks.length;
        const reserveNestedAgent = () => {
          if (agentsUsed >= options.spec.limits.maxAgents) throw new Error("team_agent_budget_exceeded");
          agentsUsed += 1;
        };

        const timeout = new AbortController();
        const timeoutId = setTimeout(
          () => timeout.abort(new Error("team_run_timeout")),
          options.spec.limits.timeoutMs,
        );
        const combined = combineSignals(options.abortSignal, executionOptions.abortSignal, timeout.signal);

        options.emit({
          type: "team.start",
          payload: {
            run_id: runId,
            profile_id: options.spec.profileId,
            workflow: options.spec.workflow,
            task_count: tasks.length,
          },
        });

        let terminalEmitted = false;
        const emitTerminal = (
          status: "completed" | "failed" | "interrupted",
          completedTasks: number,
          failedTasks: number,
        ) => {
          if (terminalEmitted) return;
          terminalEmitted = true;
          options.emit({
            type: "team.complete",
            payload: {
              run_id: runId,
              profile_id: options.spec.profileId,
              status,
              completed_tasks: completedTasks,
              failed_tasks: failedTasks,
            },
          });
        };

        try {
          const startedTaskIds = new Set<string>();
          const results = await executeTeamTaskGraph(
            tasks,
            async (context) => {
              const executor = executorById.get(context.task.memberId!);
              if (!executor) throw new Error(`team_role_unavailable:${context.task.memberId}`);
              const index = taskIndex.get(context.task.id) ?? 0;
              const subagentId = `${runId}:${context.task.id}`;
              const base = {
                depth: 0,
                goal: context.task.goal,
                parent_id: null,
                parent_tool_call_id: executionOptions.toolCallId,
                subagent_id: subagentId,
                task_count: tasks.length,
                task_index: index,
                run_id: runId,
                task_id: context.task.id,
                role_id: executor.role.id,
                provider_id: executor.role.target.providerId,
              } as const;
              const release = await taskSlots.acquire(combined.signal);
              const startedAt = Date.now();
              startedTaskIds.add(context.task.id);
              options.emit({ type: "subagent.start", payload: { ...base, status: "running" } });
              try {
                const rawArtifact = await executor.run(context, {
                  runId,
                  subagentId,
                  reserveNestedAgent,
                  onProgress: (text) => {
                    const progress = compact(text, 1_200);
                    if (!progress || combined.signal.aborted) return;
                    options.emit({
                      type: "subagent.progress",
                      payload: {
                        ...base,
                        model: executor.role.target.model,
                        status: "running",
                        text: progress,
                      },
                    });
                  },
                });
                if (combined.signal.aborted) {
                  const reason = combined.signal.reason;
                  const error = reason instanceof Error ? reason : new Error(errorMessage(reason ?? "team run interrupted"));
                  error.name = "AbortError";
                  throw error;
                }
                const artifact = normalizedArtifact(
                  context.task.id,
                  executor.role,
                  rawArtifact,
                );
                options.emit({
                  type: "subagent.complete",
                  payload: {
                    ...base,
                    model: executor.role.target.model,
                    duration_seconds: (Date.now() - startedAt) / 1_000,
                    status: "completed",
                    summary: artifact.summary,
                    confidence: artifact.confidence,
                    input_tokens: artifact.metrics?.inputTokens,
                    output_tokens: artifact.metrics?.outputTokens,
                    total_tokens: artifact.metrics?.totalTokens,
                    cost_usd: artifact.metrics?.costUsd,
                    provider_calls: artifact.metrics?.providerCalls,
                    tool_count: artifact.metrics?.toolCount,
                    files_read: artifact.evidence
                      .filter((item) => item.startsWith("observed:file:"))
                      .map((item) => item.slice("observed:file:".length)),
                    evidence: [...artifact.evidence],
                    sources: (artifact.sources ?? []).map((source) => ({
                      id: source.id,
                      requested_url: source.requestedUrl,
                      final_url: source.finalUrl,
                      title: source.title,
                      content_digest: source.contentDigest,
                      fetched_at: source.fetchedAt,
                    })),
                    provenance: [...artifact.provenance],
                    uncertainties: [...artifact.uncertainties],
                    validation: [...artifact.validation],
                    what_was_not_checked: [...artifact.whatWasNotChecked],
                  },
                });
                return artifact;
              } catch (error) {
                const interrupted = combined.signal.aborted;
                const message = compact(errorMessage(interrupted ? combined.signal.reason ?? error : error), 2_000);
                options.emit({
                  type: "subagent.failed",
                  payload: {
                    ...base,
                    model: executor.role.target.model,
                    duration_seconds: (Date.now() - startedAt) / 1_000,
                    error: message,
                    status: interrupted ? "interrupted" : "failed",
                    summary: `${interrupted ? "Interrupted" : "Failed"}: ${message}`.slice(0, 1_200),
                  },
                });
                throw error;
              } finally {
                release();
              }
            },
            { maxConcurrency: options.spec.limits.maxParallel, signal: combined.signal },
          );
          for (const result of results) {
            if (startedTaskIds.has(result.task.id) || result.status === "succeeded") continue;
            const executor = executorById.get(result.task.memberId!);
            if (!executor) continue;
            const interrupted = result.status === "aborted";
            const detail = result.status === "blocked"
              ? `Blocked by: ${result.blockedBy.join(", ")}`
              : result.status === "failed"
                ? errorMessage(result.error)
                : errorMessage(result.reason ?? "team run interrupted");
            options.emit({
              type: "subagent.failed",
              payload: {
                depth: 0,
                goal: result.task.goal,
                parent_id: null,
                parent_tool_call_id: executionOptions.toolCallId,
                subagent_id: `${runId}:${result.task.id}`,
                task_count: tasks.length,
                task_index: taskIndex.get(result.task.id) ?? 0,
                run_id: runId,
                task_id: result.task.id,
                role_id: executor.role.id,
                provider_id: executor.role.target.providerId,
                model: executor.role.target.model,
                duration_seconds: 0,
                error: compact(detail, 2_000),
                status: interrupted ? "interrupted" : "failed",
                summary: compact(interrupted ? `Interrupted: ${detail}` : detail, 1_200),
              },
            });
          }
          const completed = results.filter((result) => result.status === "succeeded").length;
          const failed = results.length - completed;
          emitTerminal(combined.signal.aborted ? "interrupted" : failed ? "failed" : "completed", completed, failed);
          return serializeTeamResult(
            runId,
            options.spec.workflow,
            results,
            options.maxResultChars ?? DEFAULT_MODEL_RESULT_CHARS,
          );
        } catch (error) {
          emitTerminal(combined.signal.aborted ? "interrupted" : "failed", 0, tasks.length);
          throw error;
        } finally {
          clearTimeout(timeoutId);
          combined.cleanup();
        }
      },
    }),
  };
}
