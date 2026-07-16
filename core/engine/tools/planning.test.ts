import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanningTools } from "./planning.js";

async function exec(tools: ReturnType<typeof buildPlanningTools>, name: string, input: unknown): Promise<string> {
  const t = tools[name] as { execute: (input: unknown, opts: unknown) => Promise<string> };
  return t.execute(input, { toolCallId: "t1", messages: [] });
}

describe("planning tools", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-plan-tools-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("writes and reads roadmap, state, and phase notes", async () => {
    const tools = buildPlanningTools({ workspace: ws });
    expect(tools["plan_read"]).toBeDefined();
    expect(tools["plan_write_roadmap"]).toBeDefined();

    const wrote = await exec(tools, "plan_write_roadmap", {
      phases: [
        { n: 1, title: "setup", status: "done", endState: "ready" },
        { n: 2, title: "impl", status: "in_progress", endState: "tests green" },
      ],
    });
    expect(wrote).toContain("2 phase");

    await exec(tools, "plan_write_state", { roadmapId: "feat", currentPhase: 2 });
    await exec(tools, "plan_write_phase", { n: 2, content: "Wire planning tools" });

    const body = await exec(tools, "plan_read", {});
    expect(body).toContain("Phase 2: impl");
    expect(body).toContain("currentPhase: 2");
    expect(body).toContain("Wire planning tools");

    const roadmap = await readFile(join(ws, ".kyrei", "plan", "ROADMAP.md"), "utf8");
    expect(roadmap).toContain("setup");
  });

  it("returns empty markers when no plan exists yet", async () => {
    const tools = buildPlanningTools({ workspace: ws });
    const body = await exec(tools, "plan_read", {});
    expect(body).toContain("no ROADMAP.md yet");
    expect(body).toContain("no STATE.json yet");
  });
});
