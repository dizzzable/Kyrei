import { createHash } from "node:crypto";
import type { ImportedTranscript } from "./types.js";

/** Stable content digest over redacted message role+text (design §9). */
export function contentDigest(transcript: ImportedTranscript): string {
  const payload = transcript.messages
    .map((m) => `${m.role}\n${m.text}`)
    .join("\n\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
