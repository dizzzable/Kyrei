/**
 * Refuse to execute tool calls from a response the model never finished.
 *
 * THE BUG THIS EXISTS FOR
 *
 * When a provider stops a response because it hit the output token limit, the
 * assistant message can still contain tool calls — and their arguments were cut
 * off mid-stream. The SDK finalises whatever arrived, so a call whose JSON
 * happens to close early parses, validates against the schema, and executes.
 *
 * Reproduced against the real tool loop: a `write_file` truncated to
 * `{"path":"a.txt","content":"TRUNCA"}` ran, and a file containing `ORIGINAL`
 * became `TRUNCA`. The model had been cut off mid-sentence; the write was
 * complete-looking and destructive.
 *
 * HOW IT IS CAUGHT
 *
 * A `finish` part carrying the length stop arrives on the model stream BEFORE
 * the SDK executes the tool calls it collected. So a middleware that watches
 * the stream can raise a flag that the tool layer reads a moment later, and the
 * whole turn's tool calls are refused with a message the model can act on.
 *
 * Refusing is deliberately cheap and reversible: the model is told the response
 * was truncated and to reissue the call, which is a normal recovery, whereas a
 * half-written file is not.
 */

import type { LanguageModel } from "ai";
import { wrapLanguageModel } from "ai";

/** Mutable per-turn flag, raised by the middleware and read by the tool layer. */
export interface TruncationSignal {
  /** True once the model reported it stopped at the output token limit. */
  truncated: boolean;
}

export function createTruncationSignal(): TruncationSignal {
  return { truncated: false };
}

/** The message a refused tool call returns. Written for the model to act on. */
export const TRUNCATED_TURN_REFUSAL =
  "Tool call not executed: the response hit the output token limit, so this call's arguments may be "
  + "silently truncated and acting on them could corrupt a file. Re-issue the call with complete arguments, "
  + "splitting the work into smaller steps if needed.";

/**
 * The stop reason arrives in different shapes across providers and SDK
 * versions — a bare string, or `{ unified, raw }`. Both are read rather than
 * assuming one, because getting this wrong fails OPEN: the guard would silently
 * never fire and the corruption it prevents would look like a model mistake.
 */
function isLengthStop(value: unknown): boolean {
  if (value === "length") return true;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["unified"] === "length"
    || record["raw"] === "length"
    || record["raw"] === "max_tokens"
    || record["raw"] === "MAX_TOKENS";
}

/**
 * Wrap a model so a length-stopped response raises `signal.truncated`.
 *
 * The stream is passed through untouched — text keeps streaming, and the tool
 * calls still reach the SDK. Only the flag is set; the refusal happens in the
 * tool layer, so the model receives a normal tool result explaining why rather
 * than a silently missing call.
 */
export function withTruncationGuard(model: LanguageModel, signal: TruncationSignal): LanguageModel {
  // `LanguageModel` also admits a model-id string, which the wrapper cannot
  // take; a string is resolved by the SDK later and carries no stream to
  // observe, so it is passed through rather than guarded.
  if (typeof model === "string") return model;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        return {
          ...rest,
          stream: stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              const record = part as unknown as Record<string, unknown>;
              if (record["type"] === "finish" && isLengthStop(record["finishReason"])) {
                signal.truncated = true;
              }
              controller.enqueue(part);
            },
          })),
        };
      },
    },
  });
}
