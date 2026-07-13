import { describe, expect, it } from "vitest";

import { BudgetExceededError, BudgetLedger, BudgetReservationError } from "./budget.js";

const limits = {
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  maxTotalTokens: 1_500,
  maxCalls: 2,
  maxCostUsd: 1,
  maxWallTimeMs: 60_000,
  maxRepairCycles: 2,
  maxAssistanceRequests: 3,
  maxConcurrency: 1,
};

describe("BudgetLedger", () => {
  it("reserves every bounded resource and concurrency before a call", () => {
    const ledger = new BudgetLedger(limits);
    const reservation = ledger.reserve({
      inputTokens: 400,
      outputTokens: 200,
      wallTimeMs: 10_000,
    });

    expect(reservation).toMatchObject({
      id: "reservation-1",
      reserved: { inputTokens: 400, outputTokens: 200, totalTokens: 600, calls: 1 },
      concurrency: 1,
    });
    expect(ledger.snapshot()).toMatchObject({
      available: {
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        calls: 1,
        concurrency: 0,
      },
      activeReservations: 1,
      reservedConcurrency: 1,
    });
    expect(() => ledger.reserve({ inputTokens: 1, outputTokens: 1, wallTimeMs: 1 }))
      .toThrow(BudgetExceededError);
  });

  it.each([
    ["input", { maxInputTokens: 10 }, { inputTokens: 11 }],
    ["output", { maxOutputTokens: 10 }, { outputTokens: 11 }],
    ["total", { maxTotalTokens: 10 }, { inputTokens: 6, outputTokens: 5 }],
    ["calls", { maxCalls: 1 }, { calls: 2 }],
    ["cost", { maxCostUsd: 0.5 }, { costUsd: 0.51 }],
    ["wall", { maxWallTimeMs: 10 }, { wallTimeMs: 11 }],
    ["repair", { maxRepairCycles: 0 }, { repairCycles: 1 }],
    ["assistance", { maxAssistanceRequests: 0 }, { assistanceRequests: 1 }],
  ])("enforces the %s hard stop independently", (_name, oneLimit, request) => {
    const ledger = new BudgetLedger(oneLimit);
    expect(() => ledger.reserve(request)).toThrow(BudgetExceededError);
    expect(ledger.snapshot().activeReservations).toBe(0);
  });

  it("does not partially mutate when any reservation dimension fails", () => {
    const ledger = new BudgetLedger({ maxInputTokens: 1_000, maxCalls: 4 });
    ledger.reserve({ inputTokens: 900 });
    const before = ledger.snapshot();
    expect(() => ledger.reserve({ inputTokens: 101 })).toThrow(BudgetExceededError);
    expect(ledger.snapshot()).toEqual(before);
  });

  it("reconciles actual usage, refunds the reservation, and releases concurrency", () => {
    const ledger = new BudgetLedger(limits);
    const reservation = ledger.reserve({ inputTokens: 500, outputTokens: 300, wallTimeMs: 20_000 });
    const result = ledger.reconcile(reservation.id, {
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      calls: 1,
      costUsd: 0.25,
      wallTimeMs: 5_000,
      repairCycles: 0,
      assistanceRequests: 0,
    });

    expect(result.metering).toBe("metered");
    expect(result.snapshot).toMatchObject({
      spent: { inputTokens: 300, outputTokens: 100, totalTokens: 400, calls: 1, wallTimeMs: 5_000 },
      reservedConcurrency: 0,
      activeReservations: 0,
    });
  });

  it("charges conservative floors and records unmetered calls", () => {
    const ledger = new BudgetLedger(
      { maxInputTokens: 1_000, maxOutputTokens: 1_000, maxTotalTokens: 2_000, maxCalls: 2 },
      { conservativeUnmeteredCharge: { inputTokens: 300, outputTokens: 200, calls: 1 } },
    );
    const reservation = ledger.reserve({ inputTokens: 1, outputTokens: 1 });
    const result = ledger.reconcile(reservation.id);
    expect(result.metering).toBe("unmetered");
    expect(result.charged).toMatchObject({ inputTokens: 300, outputTokens: 200, totalTokens: 500, calls: 1 });
    expect(result.snapshot.unmeteredCalls).toBe(1);
  });

  it("records unavoidable actual overage instead of losing accounting", () => {
    const ledger = new BudgetLedger({ maxTotalTokens: 500, maxCalls: 1 });
    const reservation = ledger.reserve({ inputTokens: 200, outputTokens: 200 });
    const result = ledger.reconcile(reservation.id, {
      inputTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      calls: 1,
      costUsd: 1.25,
    });
    expect(result.snapshot.overdrawn).toBe(true);
    expect(result.snapshot.spent.totalTokens).toBe(600);
  });

  it("validates integer accounting and the total-token invariant", () => {
    const ledger = new BudgetLedger({ maxTotalTokens: 500 });
    expect(() => ledger.reserve({ inputTokens: 1.5 })).toThrow(RangeError);
    expect(() => ledger.reserve({ inputTokens: 200, outputTokens: 100, totalTokens: 299 })).toThrow(RangeError);
  });

  it("releases calls that never started and refuses double settlement", () => {
    const ledger = new BudgetLedger({ maxInputTokens: 500, maxConcurrency: 1 });
    const reservation = ledger.reserve({ inputTokens: 200 });
    expect(ledger.release(reservation.id)).toMatchObject({ reservedConcurrency: 0, activeReservations: 0 });
    expect(() => ledger.reconcile(reservation.id)).toThrow(BudgetReservationError);
  });
});
