import { describe, expect, it } from "vitest";

import { rebaseImportedPipelines } from "./pipeline-import";
import type { PipelinesConfig } from "./types";

const definition = {
  id: "coding-org",
  name: "Coding organization",
  enabled: true,
  revision: 17,
  limits: {
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxTotalTokens: 200,
    maxCalls: 10,
    maxCostUsd: 5,
    maxWallTimeMs: 60_000,
    maxRepairCycles: 1,
    maxAssistanceRequests: 1,
    maxConcurrency: 1,
  },
  stages: [],
};

describe("pipeline backup import", () => {
  it("rebases local CAS metadata when restoring to a fresh install", () => {
    const current: PipelinesConfig = { version: 1, generation: 0, definitions: [] };
    expect(rebaseImportedPipelines({ version: 1, generation: 99, definitions: [definition] }, current))
      .toMatchObject({ generation: 0, definitions: [{ id: "coding-org", revision: 1 }] });
  });

  it("keeps an identical definition revision and advances a changed one exactly once", () => {
    const current: PipelinesConfig = {
      version: 1,
      generation: 8,
      definitions: [{ ...definition, revision: 4 }],
    };
    expect(rebaseImportedPipelines({ definitions: [definition] }, current))
      .toMatchObject({ generation: 8, definitions: [{ id: "coding-org", revision: 4 }] });
    expect(rebaseImportedPipelines({ definitions: [{ ...definition, name: "Changed" }] }, current))
      .toMatchObject({ generation: 8, definitions: [{ id: "coding-org", revision: 5 }] });
  });
});
