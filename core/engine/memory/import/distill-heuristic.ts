import type { HandoffArtifact } from "../handoff.js";
import { HandoffSchema } from "../handoff.js";
import type { ImportedMessage, ImportedTranscript } from "./types.js";

const MAX_LIST = 20;
const MAX_ITEM = 300;
const MAX_INTENT = 500;
const MAX_KEY_FILES = 20;

const PATH_RE = /(?:^|[\s`"'(])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[\w]{1,12})/g;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function lastUserIntent(messages: readonly ImportedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m.text.trim().length >= 20) {
      return clip(m.text, MAX_INTENT);
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m.text.trim()) return clip(m.text, MAX_INTENT);
  }
  return "Imported conversation";
}

function extractKeyFiles(messages: readonly ImportedMessage[]): Array<{ path: string; why: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; why: string }> = [];
  for (const m of messages) {
    PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PATH_RE.exec(m.text)) !== null) {
      const path = match[1]!.replaceAll("\\", "/").replace(/^\.\//, "");
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, why: "mentioned in import" });
      if (out.length >= MAX_KEY_FILES) return out;
    }
  }
  return out;
}

function collectMatchingLines(
  messages: readonly ImportedMessage[],
  roles: ReadonlySet<string>,
  test: (line: string) => boolean,
  limit: number,
): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (!m || !roles.has(m.role)) continue;
    for (const line of m.text.split(/\r?\n/)) {
      const t = line.replace(/^[-*•]\s*/, "").trim();
      if (t.length < 4 || t.length > MAX_ITEM) continue;
      if (test(t)) {
        out.push(clip(t, MAX_ITEM));
        if (out.length >= limit) break;
      }
    }
  }
  return out.reverse();
}

export function heuristicDistill(
  transcript: ImportedTranscript,
  opts: { sessionId: string; now?: () => string },
): HandoffArtifact {
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const id = `handoff_import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const messages = transcript.messages;

  const done = collectMatchingLines(
    messages,
    new Set(["assistant", "user"]),
    (line) => /^(done|completed|fixed|implemented|merged)\b/i.test(line),
    MAX_LIST,
  );
  const nextActions = collectMatchingLines(
    messages,
    new Set(["assistant", "user"]),
    (line) => /^(todo|next|should|need to|FIXME|TODO)\b/i.test(line),
    MAX_LIST,
  );
  const openQuestions = collectMatchingLines(
    messages,
    new Set(["user"]),
    (line) => line.includes("?") && line.length >= 8,
    10,
  );
  const decisionLines = collectMatchingLines(
    messages,
    new Set(["assistant", "user"]),
    (line) => /^(decided|decision|we will|going with)\b/i.test(line),
    MAX_LIST,
  );
  const constraints = collectMatchingLines(
    messages,
    new Set(["user", "assistant"]),
    (line) => /^(must not|don't|do not|never|constraint)\b/i.test(line),
    MAX_LIST,
  );

  const artifact = {
    id,
    createdAt: now,
    sessionId: opts.sessionId,
    trigger: "explicit" as const,
    intent: lastUserIntent(messages),
    constraints,
    done,
    nextActions,
    keyFiles: extractKeyFiles(messages),
    decisions: decisionLines.map((decision) => ({
      decision,
      rationale: "from import",
    })),
    openQuestions,
  };

  return HandoffSchema.parse(artifact);
}
