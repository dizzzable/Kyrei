import { describe, expect, it } from "vitest";

import {
  catalogReasonCode,
  dedupeCatalogForAuto,
  renderCatalogStatus,
  searchCatalog,
  summarizeRequirements,
} from "./catalog.js";
import type { RuntimeSkill } from "../types.js";

const skill = (overrides: Partial<RuntimeSkill> = {}): RuntimeSkill => ({
  id: "skill_a",
  name: "alpha",
  description: "review code",
  provenance: "global",
  ...overrides,
});

describe("skill catalog helpers", () => {
  it("prefers the best available duplicate for automatic selection", () => {
    const deduped = dedupeCatalogForAuto([
      skill({ id: "skill_global", name: "duplicate", provenance: "global", usage: 1 }),
      skill({ id: "skill_project", name: "duplicate", provenance: "project", usage: 1 }),
      skill({ id: "skill_disabled", name: "duplicate", provenance: "project", enabled: false }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("skill_project");
  });

  it("surfaces disabled and incompatible reason codes", () => {
    expect(catalogReasonCode(skill({ enabled: false, reasonCode: "skill_disabled" }))).toBe("skill_disabled");
    expect(catalogReasonCode(skill({ availability: "incompatible", reasonCode: "platform_mismatch" }))).toBe("platform_mismatch");
    expect(catalogReasonCode(undefined)).toBe("skill_not_found");
  });

  it("searches across ids, names, descriptions, and reason codes", () => {
    const results = searchCatalog([
      skill({ id: "skill_alpha", name: "alpha", description: "review code" }),
      skill({ id: "skill_beta", name: "beta", availability: "incompatible", reasonCode: "missing_capability" }),
    ], "missing");
    expect(results.map((entry) => entry.id)).toEqual(["skill_beta"]);
  });

  it("summarizes capability requirements compactly", () => {
    expect(summarizeRequirements(skill({
      metadata: {
        requirements: {
          tools: ["read_file"],
          capabilities: ["workspace.read"],
          platforms: ["linux"],
          network: true,
        },
      },
    }))).toContain("tools=read_file");
  });

  it("renders human-readable availability labels", () => {
    expect(renderCatalogStatus(skill())).toBe("ready");
    expect(renderCatalogStatus(skill({ enabled: false }))).toContain("disabled");
    expect(renderCatalogStatus(skill({ availability: "incompatible", reasonCode: "platform_mismatch" }))).toContain("incompatible");
  });
});
