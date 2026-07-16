import { ImportError } from "./errors.js";
import type { ImportAdapter, ImportDetectResult, ImportRawInput } from "./types.js";
import { IMPORT_DETECT_THRESHOLD } from "./types.js";
import { IMPORT_ADAPTERS } from "./adapters/registry.js";

export function detectImportFormat(
  input: ImportRawInput,
  adapters: readonly ImportAdapter[] = IMPORT_ADAPTERS,
): ImportDetectResult {
  const scored = adapters
    .map((adapter) => ({
      adapterId: adapter.id,
      confidence: Math.max(0, Math.min(1, adapter.detect(input))),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const top = scored[0];
  const second = scored[1];
  if (!top || top.confidence < 0.15) {
    throw new ImportError("import_format_unsupported", "no adapter matched the file", { scored });
  }

  // Only treat as ambiguous when the lead is weak and two adapters are nearly tied.
  if (
    second
    && top.confidence >= 0.5
    && second.confidence >= 0.5
    && top.confidence - second.confidence < 0.08
    && top.confidence < 0.85
  ) {
    throw new ImportError("import_format_ambiguous", "multiple adapters matched", {
      candidates: scored.slice(0, 3),
    });
  }

  if (top.confidence < IMPORT_DETECT_THRESHOLD && top.adapterId !== "generic-md") {
    // Allow generic-md slightly below threshold when it is the only candidate with content
    if (!(top.adapterId === "generic-md" && top.confidence >= 0.35)) {
      throw new ImportError("import_format_unsupported", `confidence ${top.confidence} below threshold`, {
        candidates: scored.slice(0, 3),
      });
    }
  }

  return {
    adapterId: top.adapterId,
    confidence: top.confidence,
    reasons: [`top adapter ${top.adapterId} confidence=${top.confidence.toFixed(2)}`],
    candidates: scored.slice(0, 5),
  };
}
