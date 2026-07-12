import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanStore } from "./plan.js";
import { reviewDiff, runReadSwarm } from "./reviewer.js";

describe("plan-as-files", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-plan-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("roundtrips roadmap/state/phase (resumable)", async () => {
    const plan = createPlanStore(ws);
    await plan.writeRoadmap([
      { n: 1, title: "setup", status: "done", endState: "deps installed" },
      { n: 2, title: "impl", status: "in_progress", endState: "tests green" },
    ]);
    await plan.writeState({ roadmapId: "r1", currentPhase: 2, updatedAt: new Date().toISOString() });
    await plan.writePhase(2, "detailed steps");

    expect(await plan.readRoadmap()).toContain("Phase 2: impl");
    expect((await plan.readState())?.currentPhase).toBe(2);
    expect(await plan.readPhase(2)).toBe("detailed steps");
  });
});

describe("reviewer (clean context)", () => {
  it("empty diff auto-approves", async () => {
    const r = await reviewDiff("", async () => ({ approved: false, issues: ["x"] }));
    expect(r.approved).toBe(true);
  });
  it("delegates real diff to judge", async () => {
    const r = await reviewDiff("+bug", async (d) => ({ approved: !d.includes("bug"), issues: d.includes("bug") ? ["bug found"] : [] }));
    expect(r.approved).toBe(false);
    expect(r.issues).toContain("bug found");
  });
});

describe("read swarm (single-writer safe, read-only)", () => {
  it("runs specs in parallel and returns summaries", async () => {
    const summaries = await runReadSwarm(
      [
        { goal: "find auth", readOnly: true },
        { goal: "find db", readOnly: true },
      ],
      async (s) => ({ summary: `done: ${s.goal}` }),
    );
    expect(summaries).toEqual(["done: find auth", "done: find db"]);
  });
});
