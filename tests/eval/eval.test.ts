import { describe, it, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvalTask, type EvalCategory, type EvalMetrics } from "./harness.js";
import { EVAL_TASKS } from "./tasks.js";
import { aggregate, checkRegression, type Aggregate } from "./metrics.js";

/** Every capability the suite claims to cover. Adding one here forces a task. */
const REQUIRED_CATEGORIES: EvalCategory[] = ["edit", "reject", "safety", "intel", "search", "recover"];

async function runAll(): Promise<EvalMetrics[]> {
  const metrics: EvalMetrics[] = [];
  for (const task of EVAL_TASKS) metrics.push(await runEvalTask(task));
  return metrics;
}

describe("eval harness (deterministic, Requirement 13)", () => {
  it("every task states why it exists", () => {
    // The selection rule for this suite is "a real defect got through". A task
    // without a rationale is decoration, and decoration is how a suite drifts
    // into passing while measuring nothing.
    for (const task of EVAL_TASKS) {
      expect(task.rationale.length, `${task.id} has no rationale`).toBeGreaterThan(40);
      expect(new Set(EVAL_TASKS.map((t) => t.id)).size).toBe(EVAL_TASKS.length);
    }
  });

  it("covers every category it claims to", () => {
    const present = new Set(EVAL_TASKS.map((t) => t.category));
    for (const category of REQUIRED_CATEGORIES) {
      expect(present.has(category), `no task covers "${category}"`).toBe(true);
    }
  });

  it("all tasks succeed and metrics are recorded", async () => {
    const metrics = await runAll();

    // Named, so a failure says WHICH capability broke rather than "pass rate
    // dropped".
    for (const m of metrics) {
      expect(m.editSuccess, `${m.id} [${m.category}] failed its oracle`).toBe(true);
      expect(m.steps).toBeGreaterThan(0);
    }
    const agg = aggregate(metrics);
    expect(agg.passRate).toBe(1);

    // Persist a report artifact for the release record (Req 13.6).
    await mkdir(join(process.cwd(), "tests", "eval", "out"), { recursive: true });
    await writeFile(
      join(process.cwd(), "tests", "eval", "out", "report.json"),
      JSON.stringify({ ts: new Date().toISOString(), engine: "v2", agg, metrics }, null, 2),
      "utf8",
    );
  }, 120_000);

  it("current run does not regress against committed baseline.json", async () => {
    const current = aggregate(await runAll());
    const baseline = JSON.parse(await readFile(join(process.cwd(), "tests", "eval", "baseline.json"), "utf8")) as {
      v2: Aggregate;
    };
    const r = checkRegression(baseline.v2, current);
    expect(r.regressed, r.reasons.join("; ")).toBe(false);
  }, 120_000);

  it("regression check flags worse metrics", () => {
    const baseline: Aggregate = { passRate: 1, medSteps: 2, medTokens: 60, byCategory: { edit: 1, safety: 1 } };
    expect(checkRegression(baseline, { ...baseline }).regressed).toBe(false);
    expect(checkRegression(baseline, { ...baseline, passRate: 0.8 }).regressed).toBe(true);
    expect(checkRegression(baseline, { ...baseline, medTokens: 100 }).regressed).toBe(true); // >20% tokens
  });

  it("regression check catches a category collapsing while the total holds", () => {
    // The failure this exists for: safety goes from 1.0 to 0.5, editing picks
    // up the slack, and the headline pass rate never moves.
    const baseline: Aggregate = { passRate: 1, medSteps: 2, medTokens: 60, byCategory: { edit: 1, safety: 1 } };
    const current: Aggregate = { passRate: 1, medSteps: 2, medTokens: 60, byCategory: { edit: 1, safety: 0.5 } };
    const r = checkRegression(baseline, current);
    expect(r.regressed).toBe(true);
    expect(r.reasons.join(" ")).toContain("safety");
  });

  it("regression check notices a category that stopped running entirely", () => {
    // Deleting the safety tasks would otherwise be indistinguishable from
    // passing them.
    const baseline: Aggregate = { passRate: 1, medSteps: 2, medTokens: 60, byCategory: { edit: 1, safety: 1 } };
    const r = checkRegression(baseline, { passRate: 1, medSteps: 2, medTokens: 60, byCategory: { edit: 1 } });
    expect(r.regressed).toBe(true);
    expect(r.reasons.join(" ")).toContain("disappeared");
  });
});
