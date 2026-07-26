/**
 * Fallbacks the Settings UI uses when a config field is absent from the stored
 * engine block.
 *
 * The gateway persists `config.engine` raw — no zod defaults are ever
 * materialised on disk — so on a fresh install most fields simply are not
 * there and the UI renders whatever fallback it passes to `getEngineField`.
 * When that fallback disagrees with `DEFAULT_ENGINE_CONFIG`, the control shows
 * a value the engine is not using, and the first edit writes the UI's lie back
 * as an explicit value.
 *
 * Two of these were wrong and one was security-relevant: `protectedPaths` fell
 * back to `[]`, so the textarea looked empty and one keystroke replaced the
 * real defaults with an empty list — silently removing `.git/`, `mcp.json` and
 * `kyrei-secrets.json` from write protection.
 *
 * `tests/settings-engine-defaults.test.ts` binds every entry here to
 * `DEFAULT_ENGINE_CONFIG` so they cannot drift again.
 */
export const ENGINE_FIELD_DEFAULTS = {
  "permissions.protectedPaths": [
    ".git/",
    ".git",
    ".vscode/",
    "mcp.json",
    ".kyrei/secrets",
    "kyrei-secrets.json",
  ] as readonly string[],
  "compression.summaryUseLlm": true,
  "compression.protectFirstN": 2,
  "compression.protectLastN": 6,
  "compression.pruneToChars": 500,
  "compression.alwaysMaskToolBodies": false,
} as const;
