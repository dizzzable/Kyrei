import { describe, it, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvalTask, type EvalMetrics } from "./harness.js";
import { EVAL_TASKS } from "./tasks.js";
import { aggregate, checkRegression, type Aggregate } from "./metrics.js";

describe("eval harness (deterministic, Requirement 13)", () => {
  it("all tasks succeed and metrics are recorded", async () => {
    const metrics: EvalMetrics[] = [];
    for (const task of EVAL_TASKS) metrics.push(await runEvalTask(task));

    for (const m of metrics) {
      expect(m.editSuccess, `${m.id} edit_success`).toBe(true);
      expect(m.steps).toBeGreaterThan(0);
    }
    const agg = aggregate(metrics);
    expect(agg.passRate).toBe(1); // Req 13.1: edit_success ≥ 95% → here 100%

    // Persist a report artifact for the release record (Req 13.6).
    await mkdir(join(process.cwd(), "tests", "eval", "out"), { recursive: true });
    await writeFile(
      join(process.cwd(), "tests", "eval", "out", "report.json"),
      JSON.stringify({ ts: new Date().toISOString(), engine: "v2", agg, metrics }, null, 2),
      "utf8",
    );
  });

  it("current run does not regress against committed baseline.json", async () => {
    const metrics: EvalMetrics[] = [];
    for (const task of EVAL_TASKS) metrics.push(await runEvalTask(task));
    const current = aggregate(metrics);
    const baseline = JSON.parse(await readFile(join(process.cwd(), "tests", "eval", "baseline.json"), "utf8")) as {
      v2: Aggregate;
    };
    const r = checkRegression(baseline.v2, current);
    expect(r.regressed, r.reasons.join("; ")).toBe(false);
  });

  it("regression check flags worse metrics", () => {
    const baseline = { passRate: 1, medSteps: 2, medTokens: 60 };
    expect(checkRegression(baseline, { passRate: 1, medSteps: 2, medTokens: 60 }).regressed).toBe(false);
    expect(checkRegression(baseline, { passRate: 0.8, medSteps: 2, medTokens: 60 }).regressed).toBe(true);
    expect(checkRegression(baseline, { passRate: 1, medSteps: 2, medTokens: 100 }).regressed).toBe(true); // >20% tokens
  });
});
