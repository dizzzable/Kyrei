import type { ImportedMessage, ImportedTranscript } from "./types.js";

const REDACTED = "[REDACTED]";

/** Secret-like tokens — aligned with session-export client patterns + common cloud keys. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[0-9a-fA-F]{32,}\b/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export function redactImportedText(text: string): { text: string; replacementCount: number } {
  let out = text;
  let replacementCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns reused across calls.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => {
      replacementCount += 1;
      if (/^Bearer\s+/i.test(match)) {
        return match.replace(/^(Bearer\s+).*/i, `$1${REDACTED}`);
      }
      return REDACTED;
    });
  }
  return { text: out, replacementCount };
}

export function redactTranscript(transcript: ImportedTranscript): {
  transcript: ImportedTranscript;
  redactionCount: number;
} {
  let redactionCount = 0;
  const messages: ImportedMessage[] = transcript.messages.map((message) => {
    const { text, replacementCount } = redactImportedText(message.text);
    redactionCount += replacementCount;
    const parts = message.parts?.map((part) => {
      if (typeof part.text !== "string") return part;
      const r = redactImportedText(part.text);
      redactionCount += r.replacementCount;
      return { ...part, text: r.text };
    });
    return {
      ...message,
      text,
      ...(parts ? { parts } : {}),
    };
  });
  return {
    transcript: { ...transcript, messages },
    redactionCount,
  };
}
