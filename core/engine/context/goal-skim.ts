/**
 * Wave D1 — goal/focus-aware observation skimming.
 *
 * Lightweight, training-free: extract focus terms from the user goal / optional
 * tool focus string, then keep high-signal lines (matches + imports/signatures)
 * for large code/text observations. Full body stays in CCR when used with compress.
 */

const STOP = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "from", "by",
  "is", "are", "be", "this", "that", "it", "as", "at", "we", "you", "i", "my", "our",
  "please", "can", "could", "should", "would", "will", "just", "also", "into", "via",
  "using", "use", "make", "add", "fix", "fix", "update", "create", "implement",
  "file", "files", "code", "function", "class", "the", "then", "than", "when", "what",
  "how", "why", "not", "no", "yes", "do", "does", "did", "have", "has", "had",
  "и", "в", "на", "с", "по", "для", "из", "к", "о", "что", "как", "это", "не",
  "да", "нет", "или", "но", "же", "бы", "то", "так", "уже", "ещё", "еще", "нужно",
  "сделай", "добавь", "исправь", "файл", "код", "функция",
]);

/** Extract focus tokens from free text (goal, focus arg, recent user turn). */
export function extractFocusTerms(text: string, limit = 24): string[] {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const terms = new Set<string>();

  // Path-like and identifier-like tokens first
  for (const m of raw.matchAll(/[A-Za-z_][\w./\\-]{2,}|[\p{L}][\p{L}\p{N}_./\\-]{2,}/gu)) {
    const t = m[0].replace(/^[./\\]+|[./\\]+$/g, "");
    if (t.length < 3) continue;
    const lower = t.toLowerCase();
    if (STOP.has(lower)) continue;
    if (/^\d+$/.test(t)) continue;
    terms.add(lower);
    if (terms.size >= limit) break;
  }

  return [...terms];
}

/**
 * Heuristic long-horizon goal: multi-file / multi-step work that benefits from plan-first.
 * Short bugfix and one-liners stay free to act.
 */
export function isLongHorizonGoal(text: string): boolean {
  const t = String(text ?? "").trim();
  if (t.length < 80) return false;
  const lower = t.toLowerCase();
  // Explicit short-task cues
  if (/\b(typo|rename only|one line|quick fix|просто опечатк)/i.test(t) && t.length < 200) {
    return false;
  }
  const multiFile =
    /\b(across|multiple files|several files|entire|whole (codebase|project)|рефактор|миграц|архитектур)/i
      .test(t)
    || (t.match(/\.(ts|tsx|js|jsx|py|go|rs|java|md)\b/gi)?.length ?? 0) >= 2;
  const multiStep =
    /\b(implement|migrate|refactor|redesign|rewrite|pipeline|end-to-end|e2e|from scratch|пошаг|реализуй|перепиши)\b/i
      .test(lower)
    || (t.match(/\n[-*•]|\n\d+\./g)?.length ?? 0) >= 2;
  const longEnough = t.length >= 160 || t.split(/\s+/).length >= 28;
  return multiFile || (multiStep && longEnough) || (longEnough && multiStep);
}

/**
 * User messages that release plan-first gate (approve implement).
 * Bare "implement X" / "реализуй Y" is a long task request, NOT approval —
 * only explicit release phrases (or implement/build tied to "the plan").
 */
export function userAuthorizedBuild(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // Explicit approval / release phrases.
  if (
    /\b(build it|go ahead|approved|lgtm|ship it|execute the plan|start coding|приступай|одобряю|согласен)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // "Implement the plan" / "реализуй план" after planning — not bare task verbs.
  if (/\b(implement|build|реализуй|делай)\b[\s\S]{0,48}\b(the )?plan\b/i.test(t)) return true;
  if (/\b(the )?plan\b[\s\S]{0,48}\b(implement|build|реализуй)\b/i.test(t)) return true;
  return false;
}

export interface SkimOptions {
  maxChars: number;
  /** Focus query (goal or tool focus). */
  focus?: string;
  /** Lines of context around each match. */
  contextLines?: number;
  /** Max match clusters to keep. */
  maxMatches?: number;
}

/**
 * Line-level skim for large code/text. Always preserves imports/signatures when present.
 * Returns original text when already within budget or no useful focus.
 */
export function skimTextForFocus(text: string, options: SkimOptions): {
  text: string;
  skimmed: boolean;
  matchLines: number;
} {
  const maxChars = Math.max(400, Math.floor(options.maxChars));
  const raw = String(text ?? "");
  if (raw.length <= maxChars) {
    return { text: raw, skimmed: false, matchLines: 0 };
  }

  const terms = extractFocusTerms(options.focus ?? "", 20);
  const lines = raw.split("\n");
  const ctx = Math.max(0, Math.min(8, options.contextLines ?? 2));
  const maxMatches = Math.max(4, Math.min(80, options.maxMatches ?? 40));

  const keep = new Set<number>();
  // Always keep early imports / headers
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const l = lines[i] ?? "";
    if (/^\s*(import |export |from |#include |using |package |require\()/i.test(l)
      || /^(#!|\/\*|\/\/\s*@)/.test(l.trim())) {
      keep.add(i);
    }
  }

  let matchLines = 0;
  if (terms.length) {
    for (let i = 0; i < lines.length; i++) {
      const lower = (lines[i] ?? "").toLowerCase();
      if (!terms.some((t) => lower.includes(t))) continue;
      matchLines += 1;
      if (matchLines > maxMatches) break;
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        keep.add(j);
      }
    }
  }

  // Signature outline when focus sparse
  if (keep.size < 20) {
    for (let i = 0; i < lines.length; i++) {
      const l = (lines[i] ?? "").trim();
      if (/^(export )?(async )?(function|class|const|let|type|interface|def |fn |pub |struct )\b/
        .test(l)) {
        keep.add(i);
      }
    }
  }

  // Tail for recent context
  for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) keep.add(i);

  if (keep.size === 0 || keep.size >= lines.length * 0.85) {
    return { text: raw, skimmed: false, matchLines };
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const out: string[] = [
    `[goal-skim lines=${sorted.length}/${lines.length} matches=${matchLines}`
    + (terms.length ? ` focus=${terms.slice(0, 8).join(",")}` : "")
    + "]",
  ];
  let prev = -2;
  for (const idx of sorted) {
    if (idx > prev + 1) out.push(`… L${prev + 2}-${idx} omitted …`);
    out.push(`${idx + 1}| ${lines[idx] ?? ""}`);
    prev = idx;
  }
  let body = out.join("\n");
  if (body.length > maxChars) {
    body = `${body.slice(0, Math.floor(maxChars * 0.7))}\n…\n${body.slice(-Math.floor(maxChars * 0.25))}`;
  }
  return { text: body, skimmed: true, matchLines };
}

/** Last user-visible text from model message history (for goal/focus). */
export function lastUserTextFromMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      const parts = c
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && "text" in p) return String((p as { text?: unknown }).text ?? "");
          return "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join("\n").trim();
    }
  }
  return "";
}
