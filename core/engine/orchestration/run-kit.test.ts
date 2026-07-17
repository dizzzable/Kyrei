import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRunId,
  createRunStore,
  formatPhaseVerifyTable,
  protocolMarkdown,
  RUN_MARKERS,
} from "./run-kit.js";

describe("run-kit", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-run-kit-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("claims safe run ids", () => {
    const id = claimRunId("My Feature!!!");
    expect(id).toMatch(/^my-feature-[a-f0-9]{6}$/);
  });

  it("persists roadmap, state, phase, fix, and protocol", async () => {
    const store = createRunStore(ws, "demo-abc123");
    await store.ensure();
    await store.writeRoadmap([
      { n: 1, title: "one", status: "in_progress", endState: "ready" },
    ]);
    await store.writeState({
      runId: "demo-abc123",
      roadmapId: "demo-abc123",
      currentPhase: 1,
      status: "running",
      strike: 1,
      auditRound: 0,
      updatedAt: new Date().toISOString(),
    });
    await store.writePhase(1, "# Phase 1\n");
    await store.writeFixSpec(1, "# Fix\n");

    const roadmap = await store.readRoadmap();
    expect(roadmap).toContain("Phase 1: one");
    const state = await store.readState();
    expect(state?.strike).toBe(1);
    expect(state?.status).toBe("running");
    expect(await store.readPhase(1)).toContain("Phase 1");
    expect(await store.readFixSpec(1)).toContain("Fix");
    expect(await store.listPhaseFiles()).toEqual(["phase-1.fix.md", "phase-1.md"]);

    const protocol = await readFile(join(ws, ".kyrei", "run", "demo-abc123", "PROTOCOL.md"), "utf8");
    expect(protocol).toContain(RUN_MARKERS.phaseVerify);
    expect(protocolMarkdown()).toContain(RUN_MARKERS.finalAudit);
  });

  it("formats phase verify tables", () => {
    const table = formatPhaseVerifyTable([
      { criterion: "a|b", pass: true, evidence: "ok" },
      { criterion: "tests", pass: false },
    ]);
    expect(table.startsWith(RUN_MARKERS.phaseVerify)).toBe(true);
    expect(table).toContain("| a/b | yes | ok |");
    expect(table).toContain("| tests | no | — |");
  });
});
