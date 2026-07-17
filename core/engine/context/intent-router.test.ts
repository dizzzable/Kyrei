import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent-router.js";

describe("intent-router", () => {
  it("routes short fixes without plan force", () => {
    const d = classifyIntent("Fix typo in README title");
    expect(d.route).toBe("short_fix");
    expect(d.forcePlan).toBe(false);
  });

  it("routes long multi-file work to force plan", () => {
    const d = classifyIntent(
      "Refactor authentication across the gateway, UI providers, and session store: migrate to JWT, update middleware, and add end-to-end tests for login.",
    );
    expect(d.forcePlan).toBe(true);
    expect(d.route).toBe("long_feature");
  });

  it("routes research cues", () => {
    const d = classifyIntent("Investigate why the memory index is slow and compare SQLite vs Postgres options for us");
    expect(d.route).toBe("research");
  });

  it("releases plan when user authorizes build", () => {
    const d = classifyIntent("LGTM implement the plan as discussed for the multi-file migration");
    expect(d.forcePlan).toBe(false);
  });
});
