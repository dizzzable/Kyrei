import type { ImportAdapter } from "../types.js";
import { claudeCodeJsonlAdapter } from "./claude-code-jsonl.js";
import { claudeCodeMdAdapter, genericMdAdapter } from "./markdown.js";
import { kyreiExportAdapter } from "./kyrei-export.js";
import { opencodeJsonAdapter } from "./opencode-json.js";

/** Priority order: structured first, generic last. */
export const IMPORT_ADAPTERS: readonly ImportAdapter[] = [
  kyreiExportAdapter,
  opencodeJsonAdapter,
  claudeCodeJsonlAdapter,
  claudeCodeMdAdapter,
  genericMdAdapter,
];

export function getAdapterById(id: string): ImportAdapter | undefined {
  return IMPORT_ADAPTERS.find((adapter) => adapter.id === id);
}
