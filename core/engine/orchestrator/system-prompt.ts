/**
 * System prompt construction. The implementation now lives in the versioned
 * `prompt/` module (task 2.5); this file is a thin re-export to keep the
 * orchestrator import stable.
 */

export { buildSystemPrompt, PROMPT_VERSION, PROMPT_CHANGELOG } from "../prompt/system.js";
export type { SystemPromptInput } from "../prompt/system.js";
