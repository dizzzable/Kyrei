import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  SubagentEvent,
  SubagentEventBasePayload,
  SubagentEventMetadata,
  Usage,
} from "../types.js";
import { redact } from "../security/secrets.js";

const SUMMARY_MAX_CHARS = 1_200;

export interface DelegateTaskMetadata {
  model?: string;
  usage?: Usage;
  toolCount?: number;
  providerCalls?: number;
  filesRead?: readonly string[];
  filesWritten?: readonly string[];
}

export interface DelegateTaskResult extends DelegateTaskMetadata {
  summary: string;
}

export type DelegateProgress = string | ({ text: string } & DelegateTaskMetadata);

/**
 * Input passed to the injected child runner. `runTask` is the security
 * boundary: it MUST expose only read/search tools and MUST omit command,
 * write, approval, messaging, and delegation tools.
 */
export interface DelegateTaskRequest {
  childId: string;
  goal: string;
  index: number;
  signal?: AbortSignal;
  readOnly: true;
  allowDelegation: false;
  onProgress: (progress: DelegateProgress) => void;
}

/** Engine-only lifecycle details for bounded nested usage accounting. */
export interface DelegateTaskLifecycle {
  readonly childId: string;
  readonly index: number;
}

export type DelegateTaskRunner = (request: DelegateTaskRequest) => Promise<DelegateTaskResult>;

export type DelegateEvent = SubagentEvent;
type DelegateEventBase = SubagentEventBasePayload;
type DelegateEventMetadata = SubagentEventMetadata;

export interface DelegateToolOptions {
  enabled: boolean;
  maxTasks: number;
  maxParallel: number;
  abortSignal?: AbortSignal;
  emit: (event: DelegateEvent) => void;
  runTask: DelegateTaskRunner;
  /** Stable session/run namespace for globally tracked child event ids. */
  idPrefix?: string;
  /** Reserve one cumulative child slot before its model loop starts. */
  reserveTask?: () => void;
  /** Observers are engine-only and never alter model-facing tool output. */
  onTaskStarted?: (task: DelegateTaskLifecycle) => void;
  /** Fired after a child returns its bounded telemetry. */
  /** Receives cumulative child telemetry, including failed child attempts. */
  onTaskProgress?: (task: DelegateTaskLifecycle, metadata: DelegateTaskMetadata) => void;
  onTaskCompleted?: (task: DelegateTaskLifecycle, metadata: DelegateTaskMetadata) => void;
  /** Optional ancestry/provenance for a delegate tool exposed inside a Team role. */
  eventContext?: {
    depth: number;
    parentId: string | null;
    runId?: string;
    roleId?: string;
    providerId?: string;
    taskIdPrefix?: string;
  };
}

interface TaskOutcome {
  summary: string;
}

interface CombinedSignal {
  signal?: AbortSignal;
  cleanup: () => void;
}

export interface ConcurrencyGate {
  acquire: (signal?: AbortSignal) => Promise<() => void>;
}

interface SlotWaiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

function boundedInteger(value: number, upperBound?: number): number {
  const normalized = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  return upperBound === undefined ? normalized : Math.min(normalized, upperBound);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function compact(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const normalized = redact(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message =
    reason instanceof Error
      ? errorMessage(reason)
      : typeof reason === "string" && reason.trim()
        ? reason
        : "Delegation aborted";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): CombinedSignal {
  const signals = [...new Set([first, second].filter((signal): signal is AbortSignal => signal !== undefined))];
  if (signals.length === 0) return { cleanup: () => undefined };
  if (signals.length === 1) return { signal: signals[0], cleanup: () => undefined };

  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const listener = () => controller.abort(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

function waitForTask<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));

    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  let active = 0;
  const queue: SlotWaiter[] = [];

  const releaseSlot = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      dispatch();
    };
  };

  const cleanup = (waiter: SlotWaiter): void => {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  };

  const dispatch = (): void => {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        cleanup(waiter);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      cleanup(waiter);
      active += 1;
      waiter.resolve(releaseSlot());
    }
  };

  return {
    acquire: (signal) => {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (active < limit) {
        active += 1;
        return Promise.resolve(releaseSlot());
      }
      return new Promise<() => void>((resolve, reject) => {
        const waiter: SlotWaiter = { signal, resolve, reject };
        if (signal) {
          waiter.onAbort = () => {
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            cleanup(waiter);
            reject(abortError(signal));
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
          if (signal.aborted) {
            waiter.onAbort();
            return;
          }
        }
        queue.push(waiter);
      });
    },
  };
}

function mergeFiles(current?: readonly string[], incoming?: readonly string[]): string[] | undefined {
  if (!current && !incoming) return undefined;
  return [...new Set([...(current ?? []), ...(incoming ?? [])])];
}

function mergeMetadata(
  current: DelegateTaskMetadata,
  incoming: DelegateTaskMetadata,
): DelegateTaskMetadata {
  return {
    model: incoming.model ?? current.model,
    usage:
      current.usage || incoming.usage
        ? { ...current.usage, ...incoming.usage }
        : undefined,
    toolCount: incoming.toolCount ?? current.toolCount,
    providerCalls: nonNegativeInteger(incoming.providerCalls) ?? nonNegativeInteger(current.providerCalls),
    filesRead: mergeFiles(current.filesRead, incoming.filesRead),
    filesWritten: mergeFiles(current.filesWritten, incoming.filesWritten),
  };
}

function eventMetadata(metadata: DelegateTaskMetadata): DelegateEventMetadata {
  return {
    model: metadata.model,
    input_tokens: metadata.usage?.inputTokens,
    output_tokens: metadata.usage?.outputTokens,
    total_tokens: metadata.usage?.totalTokens,
    cost_usd: metadata.usage?.costUsd,
    tool_count: metadata.toolCount,
    provider_calls: nonNegativeInteger(metadata.providerCalls),
    files_read: metadata.filesRead ? [...metadata.filesRead] : undefined,
    files_written: metadata.filesWritten ? [...metadata.filesWritten] : undefined,
  };
}

export function delegateChildId(toolCallId: string, index: number): string {
  return `delegate-tool:${toolCallId}:${index}`;
}

/**
 * Build the model-facing read-only delegation tool. Provider creation and the
 * child tool allowlist stay in the injected `runTask`, keeping orchestration
 * deterministic, testable, and unable to grant itself additional capability.
 */
export function buildDelegateTool(options: DelegateToolOptions): ToolSet {
  if (!options.enabled) return {};

  const maxTasks = boundedInteger(options.maxTasks);
  const maxParallel = boundedInteger(options.maxParallel, maxTasks);
  // One gate is shared by every invocation of this tool instance, preventing
  // several parallel delegate_read calls from multiplying the configured cap.
  const childSlots = createConcurrencyGate(maxParallel);
  const taskSchema = z.object({
    goal: z.string().trim().min(1).describe("A specific, self-contained read-only research goal."),
  });
  const inputSchema = z.object({
    tasks: z.array(taskSchema).min(1).max(maxTasks),
  });

  return {
    delegate_read: tool({
      description:
        "Run independent read-only research tasks in isolated child contexts. " +
        "Children can read and search, but cannot write, run commands, message, or delegate again. " +
        "Only compact ordered summaries return to this context.",
      inputSchema,
      execute: async (input, executionOptions) => {
        // AI SDK validates model calls before execution. Parsing again keeps
        // the injected boundary safe for direct/internal invocations as well.
        const { tasks } = inputSchema.parse(input);
        const combined = combineSignals(options.abortSignal, executionOptions.abortSignal);
        try {
          throwIfAborted(combined.signal);
          const outcomes: Array<TaskOutcome | undefined> = new Array(tasks.length);
          let nextIndex = 0;

          const runOneWithoutLimit = async (index: number): Promise<TaskOutcome> => {
            const task = tasks[index];
            if (!task) throw new Error(`Missing delegated task at index ${index}.`);

            const localChildId = delegateChildId(executionOptions.toolCallId, index);
            const idPrefix = options.eventContext?.parentId ?? options.idPrefix;
            const childId = idPrefix
              ? `${idPrefix}:${localChildId}`
              : localChildId;
            const base: DelegateEventBase = {
              depth: options.eventContext?.depth ?? 0,
              goal: task.goal,
              parent_id: options.eventContext?.parentId ?? null,
              parent_tool_call_id: executionOptions.toolCallId,
              subagent_id: childId,
              task_count: tasks.length,
              task_index: index,
              ...(options.eventContext?.runId ? { run_id: options.eventContext.runId } : {}),
              ...(options.eventContext?.roleId ? { role_id: options.eventContext.roleId } : {}),
              ...(options.eventContext?.providerId ? { provider_id: options.eventContext.providerId } : {}),
              ...(options.eventContext?.taskIdPrefix
                ? { task_id: `${options.eventContext.taskIdPrefix}:${index}` }
                : {}),
            };
            const startedAt = Date.now();
            let metadata: DelegateTaskMetadata = {};
            let terminal = false;

            options.emit({
              type: "subagent.start",
              payload: { ...base, status: "running" },
            });

            const onProgress = (progress: DelegateProgress): void => {
              if (terminal || combined.signal?.aborted) return;
              const update = typeof progress === "string" ? { text: progress } : progress;
              if (typeof progress !== "string") {
                metadata = mergeMetadata(metadata, progress);
                try {
                  options.onTaskProgress?.({ childId, index }, metadata);
                } catch {
                  // Accounting observers must never change delegation semantics.
                }
              }
              const text = compact(update.text);
              if (!text) return;
              options.emit({
                type: "subagent.progress",
                payload: {
                  ...base,
                  ...eventMetadata(metadata),
                  status: "running",
                  text,
                },
              });
            };

            try {
              options.reserveTask?.();
              try {
                options.onTaskStarted?.({ childId, index });
              } catch {
                // Accounting observers must never change delegation semantics.
              }
              const result = await waitForTask(
                options.runTask({
                  childId,
                  goal: task.goal,
                  index,
                  signal: combined.signal,
                  readOnly: true,
                  allowDelegation: false,
                  onProgress,
                }),
                combined.signal,
              );
              throwIfAborted(combined.signal);
              terminal = true;
              metadata = mergeMetadata(metadata, result);
              try {
                options.onTaskCompleted?.({ childId, index }, metadata);
              } catch {
                // Accounting observers must never change delegation semantics.
              }
              const summary = compact(result.summary) || "No summary returned.";
              options.emit({
                type: "subagent.complete",
                payload: {
                  ...base,
                  ...eventMetadata(metadata),
                  duration_seconds: (Date.now() - startedAt) / 1_000,
                  status: "completed",
                  summary,
                },
              });
              return { summary };
            } catch (error) {
              terminal = true;
              const interrupted = combined.signal?.aborted === true;
              const message = compact(
                interrupted && combined.signal ? errorMessage(abortError(combined.signal)) : errorMessage(error),
                1_000,
              );
              const summary = compact(`${interrupted ? "Interrupted" : "Failed"}: ${message}`);
              options.emit({
                type: "subagent.failed",
                payload: {
                  ...base,
                  ...eventMetadata(metadata),
                  duration_seconds: (Date.now() - startedAt) / 1_000,
                  error: message,
                  status: interrupted ? "interrupted" : "failed",
                  summary,
                },
              });
              if (interrupted && combined.signal) throw abortError(combined.signal);
              return { summary };
            }
          };

          const runOne = async (index: number): Promise<TaskOutcome> => {
            const release = await childSlots.acquire(combined.signal);
            try {
              return await runOneWithoutLimit(index);
            } finally {
              release();
            }
          };

          const worker = async (): Promise<void> => {
            while (true) {
              throwIfAborted(combined.signal);
              const index = nextIndex;
              nextIndex += 1;
              if (index >= tasks.length) return;
              outcomes[index] = await runOne(index);
            }
          };

          const workerCount = Math.min(maxParallel, tasks.length);
          await Promise.all(Array.from({ length: workerCount }, () => worker()));
          throwIfAborted(combined.signal);

          return outcomes
            .map((outcome, index) => `[${index + 1}] ${outcome?.summary ?? "Failed: no result returned."}`)
            .join("\n");
        } finally {
          combined.cleanup();
        }
      },
    }),
  };
}
