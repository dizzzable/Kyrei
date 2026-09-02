/**
 * Repair non-conforming `tool_calls[].index` values on an OpenAI-compatible
 * chat-completions SSE stream.
 *
 * THE BUG THIS EXISTS FOR
 *
 * `choices[].delta.tool_calls[].index` is a position in the *tool call list*,
 * so a response with one tool call must use index 0. Gateways that re-serve
 * Anthropic models over the OpenAI wire (krakenhub, and every proxy built the
 * same way) leak the Anthropic *content block* index instead: a turn that
 * thinks before calling a tool numbers the thinking block 0 and the first
 * `tool_use` block 1, so the very first tool call arrives as `index: 1`.
 *
 * `@ai-sdk/provider-utils` stores each call at `toolCalls[index]`, which leaves
 * a HOLE at 0. Its `flush()` walks that array with `for...of`, which visits
 * holes as `undefined`, and the turn dies on:
 *
 *   TypeError: Cannot read properties of undefined (reading 'hasFinished')
 *
 * The tool calls were already parsed correctly at that point — only the array
 * numbering was wrong — so the whole turn is lost to a cosmetic defect in a
 * field the SDK only uses to correlate deltas.
 *
 * HOW IT IS FIXED
 *
 * Indices are renumbered densely from 0 in order of first appearance, per
 * choice, before the SDK sees them. Correlation is preserved (every delta for
 * one provider index maps to the same dense index), so multi-call turns and
 * split argument fragments keep working.
 *
 * This FAILS OPEN by construction: anything that is not a parsable
 * chat-completion frame carrying tool calls is forwarded byte-for-byte. A
 * malformed line, a keep-alive comment, `data: [DONE]`, a multi-line `data:`
 * payload, or a provider that already numbers correctly all pass through
 * untouched. A stream that this module cannot understand is a stream it does
 * not modify — never a stream it breaks.
 */

/** JSON shape of one entry in `choices[].delta.tool_calls`. */
interface ToolCallDelta {
  index?: number | null;
  [key: string]: unknown;
}

interface ChoiceDelta {
  tool_calls?: ToolCallDelta[] | null;
  [key: string]: unknown;
}

interface Choice {
  index?: number | null;
  delta?: ChoiceDelta | null;
  [key: string]: unknown;
}

interface ChunkLike {
  choices?: Choice[] | null;
  [key: string]: unknown;
}

/**
 * Provider index -> dense 0-based index, per choice.
 *
 * Scoped to one response: `n > 1` gives each choice its own tool-call list, so
 * a shared map would collide their numbering.
 */
class ToolCallIndexRemap {
  private readonly perChoice = new Map<number, Map<number, number>>();

  resolve(choiceIndex: number, providerIndex: number): number {
    let seen = this.perChoice.get(choiceIndex);
    if (seen === undefined) {
      seen = new Map<number, number>();
      this.perChoice.set(choiceIndex, seen);
    }
    const existing = seen.get(providerIndex);
    if (existing !== undefined) return existing;
    // First sighting: append to this choice's dense list.
    const dense = seen.size;
    seen.set(providerIndex, dense);
    return dense;
  }
}

/**
 * Renumber the tool-call indices of one decoded chunk.
 * Returns `null` when nothing needed changing, so the caller can forward the
 * original bytes instead of a re-serialized copy.
 */
function normalizeChunk(chunk: ChunkLike, remap: ToolCallIndexRemap): ChunkLike | null {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return null;

  let changed = false;
  for (let position = 0; position < choices.length; position += 1) {
    const choice = choices[position];
    if (!choice || typeof choice !== "object") continue;
    const toolCalls = choice.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;

    // Prefer the wire `index`; fall back to array position so a provider that
    // omits it still gets a stable per-choice key.
    const choiceIndex = typeof choice.index === "number" ? choice.index : position;

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") continue;
      // A missing index is the documented Google shape; the SDK appends in that
      // case, which is already correct. Renumbering it would invent an index
      // the provider deliberately left out.
      if (typeof toolCall.index !== "number") continue;
      const dense = remap.resolve(choiceIndex, toolCall.index);
      if (dense !== toolCall.index) {
        toolCall.index = dense;
        changed = true;
      }
    }
  }
  return changed ? chunk : null;
}

/**
 * Rewrite one SSE line. Returns the original string when it does not need to
 * change, so the common case allocates nothing.
 */
export function normalizeSseLine(line: string, remap: ToolCallIndexRemap): string {
  // Cheap gate first: only `data:` frames that mention tool calls can matter.
  // This skips text deltas, reasoning deltas, comments and `[DONE]` without a
  // JSON parse.
  if (!line.startsWith("data:") || !line.includes("\"tool_calls\"")) return line;

  const payload = line.slice("data:".length);
  const trimmed = payload.trim();
  if (trimmed.length === 0 || trimmed === "[DONE]") return line;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not a JSON frame (or a multi-line `data:` payload): leave it alone.
    return line;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;

  let normalized: ChunkLike | null;
  try {
    normalized = normalizeChunk(parsed as ChunkLike, remap);
  } catch {
    return line;
  }
  if (normalized === null) return line;

  // Preserve the provider's spacing after `data:` so the frame keeps its
  // original shape apart from the numbers that were wrong.
  const leadingSpace = payload.startsWith(" ") ? " " : "";
  return `data:${leadingSpace}${JSON.stringify(normalized)}`;
}

/** Line-oriented SSE rewriter. Holds at most one incomplete line. */
export function createToolCallIndexTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const remap = new ToolCallIndexRemap();
  let carry = "";

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, text: string): void => {
    if (text.length > 0) controller.enqueue(encoder.encode(text));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      carry += decoder.decode(chunk, { stream: true });
      // Split on "\n" only: "\r\n" keeps its "\r" as the last character of the
      // line, which `trim()` removes before parsing and JSON.stringify never
      // reintroduces — so CRLF streams are rewritten as LF frames, which the
      // SSE parser accepts. Everything unmodified keeps its bytes.
      let newline = carry.indexOf("\n");
      while (newline !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        emit(controller, `${normalizeSseLine(line, remap)}\n`);
        newline = carry.indexOf("\n");
      }
    },
    flush(controller) {
      carry += decoder.decode();
      // A stream that ends without a trailing newline still gets its last
      // frame repaired.
      if (carry.length > 0) emit(controller, normalizeSseLine(carry, remap));
    },
  });
}

/**
 * Wrap a fetch implementation so OpenAI-compatible SSE responses get their
 * tool-call indices renumbered.
 *
 * Only `text/event-stream` success responses are touched. Errors, JSON
 * responses and bodiless responses are returned exactly as received, and a
 * failure to construct the wrapper returns the original response rather than
 * throwing — the guard must never be the reason a request fails.
 */
export function withNormalizedToolCallIndexes(inner?: typeof fetch): typeof fetch {
  const base: typeof fetch = inner ?? ((...args) => globalThis.fetch(...args));
  const normalizingFetch: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    try {
      const body = response.body;
      if (!response.ok || body === null) return response;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream")) return response;
      return new Response(body.pipeThrough(createToolCallIndexTransform()), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
  return normalizingFetch;
}

/** Exported for tests: a fresh remap for direct `normalizeSseLine` calls. */
export function createToolCallIndexRemap(): ToolCallIndexRemap {
  return new ToolCallIndexRemap();
}

export type { ToolCallIndexRemap };
