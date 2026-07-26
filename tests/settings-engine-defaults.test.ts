import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_CONFIG } from "../core/engine/types.js";
import { ENGINE_FIELD_DEFAULTS } from "../src/lib/engine-field-defaults.js";

/**
 * The gateway persists `config.engine` raw, so a fresh install has most fields
 * absent and the Settings UI renders its own fallback. A fallback that
 * disagrees with the engine shows the user a value the engine is not using —
 * and the first edit writes that wrong value back as an explicit one.
 *
 * `permissions.protectedPaths` fell back to `[]`, which made the textarea look
 * empty and let one keystroke drop `.git/`, `mcp.json` and `kyrei-secrets.json`
 * out of write protection. `compression.summaryUseLlm` fell back to `false`
 * against an engine default of `true`.
 */
function engineDefaultAt(path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    DEFAULT_ENGINE_CONFIG,
  );
}

describe("Settings engine-field fallbacks", () => {
  it.each(Object.keys(ENGINE_FIELD_DEFAULTS))("matches DEFAULT_ENGINE_CONFIG for %s", (path) => {
    const expected = engineDefaultAt(path);
    expect(expected, `${path} is missing from DEFAULT_ENGINE_CONFIG`).toBeDefined();
    expect(ENGINE_FIELD_DEFAULTS[path as keyof typeof ENGINE_FIELD_DEFAULTS]).toEqual(expected);
  });

  it("keeps the security-relevant protected paths non-empty", () => {
    const paths = ENGINE_FIELD_DEFAULTS["permissions.protectedPaths"];
    expect(paths.length).toBeGreaterThan(0);
    for (const required of [".git/", "mcp.json", "kyrei-secrets.json"]) {
      expect(paths).toContain(required);
    }
  });
});
