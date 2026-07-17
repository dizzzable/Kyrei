import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanningTools } from "./planning.js";
import { RUN_MARKERS } from "../orchestration/run-kit.js";

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

  it("claims a namespaced run kit and round-trips roadmap/state/phase/fix", async () => {
    const tools = buildPlanningTools({ workspace: ws });
    expect(tools["run_claim"]).toBeDefined();
    expect(tools["run_final_audit"]).toBeDefined();

    const claimed = await exec(tools, "run_claim", {
      slug: "wave-a",
      phases: [
        { n: 1, title: "kit", status: "in_progress", endState: "files exist" },
        { n: 2, title: "audit", status: "pending", endState: "final green" },
      ],
    });
    expect(claimed).toMatch(/Claimed run wave-a-[a-f0-9]+/);
    const runId = claimed.match(/Claimed run (\S+)/)?.[1];
    expect(runId).toBeTruthy();

    const protocol = await readFile(join(ws, ".kyrei", "run", runId!, "PROTOCOL.md"), "utf8");
    expect(protocol).toContain("KYREI_PHASE_VERIFY");

    await exec(tools, "run_write_state", {
      runId,
      currentPhase: 1,
      status: "running",
      strike: 1,
    });
    await exec(tools, "run_write_phase", {
      runId,
      n: 1,
      content: "# Phase 1\n\nDo the work.\n",
    });
    await exec(tools, "run_write_fix", {
      runId,
      n: 1,
      content: "# Fix\n\nDifferent approach.\n",
    });

    const body = await exec(tools, "run_read", { runId, phase: 1, includeFix: true });
    expect(body).toContain("strike: 2"); // write_fix bumps strike
    expect(body).toContain("Do the work");
    expect(body).toContain("Different approach");
    expect(body).toContain("phase-1.md");

    const verify = await exec(tools, "run_phase_verify", {
      phase: 1,
      rows: [
        { criterion: "files on disk", pass: true, evidence: "read_file ok" },
        { criterion: "tests", pass: false, evidence: "exit 1" },
      ],
    });
    expect(verify).toContain(RUN_MARKERS.phaseVerify);
    expect(verify).toContain("files on disk");
    expect(verify).toContain("do not print KYREI_PHASE_DONE");

    const audit = await exec(tools, "run_final_audit", {
      runId,
      criteria: [{ criterion: "kit ready", pass: true }],
      commands: [{ name: "npm run gate", exitCode: 0 }],
      deliverables: [{ path: ".kyrei/run/" + runId + "/PROTOCOL.md", present: true }],
    });
    expect(audit).toContain(RUN_MARKERS.finalAudit);
    expect(audit).toContain(RUN_MARKERS.runComplete);

    const stateRaw = await readFile(join(ws, ".kyrei", "run", runId!, "STATE.json"), "utf8");
    const state = JSON.parse(stateRaw) as { status: string; auditRound: number };
    expect(state.status).toBe("complete");
    expect(state.auditRound).toBeGreaterThanOrEqual(1);
  });
});
