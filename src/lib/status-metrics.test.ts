import { describe, expect, it } from "vitest";
import { contextMetric, formatCompactTokens, formatElapsed } from "./status-metrics";

describe("status metrics", () => {
  it("formats live durations without locale-owned words", () => {
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_665_000)).toBe("1:01:05");
  });

  it("formats compact token values", () => {
    expect(formatCompactTokens(999)).toBe("999");
    expect(formatCompactTokens(33_400)).toBe("33.4k");
    expect(formatCompactTokens(1_000_000)).toBe("1M");
  });

  it("clamps context usage and exposes ten deterministic meter cells", () => {
    expect(contextMetric(33_400, 1_000_000)).toEqual({
      used: 33_400,
      limit: 1_000_000,
      percent: 3,
      filledCells: 1,
    });
    expect(contextMetric(2_000, 1_000)).toMatchObject({ percent: 100, filledCells: 10 });
  });
});
