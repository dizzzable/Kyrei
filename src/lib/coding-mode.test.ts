import { describe, expect, it } from "vitest";
import {
  codingModeForPipelineStage,
  detectCodingModeSwitch,
  effectiveCodingModeFromMessages,
  normalizeCodingMode,
  parseCodingModeArg,
} from "./coding-mode";

describe("parseCodingModeArg", () => {
  it("parses aliases", () => {
    expect(parseCodingModeArg("plan")).toBe("plan");
    expect(parseCodingModeArg("deep")).toBe("deepreep");
    expect(parseCodingModeArg("research")).toBe("deepreep");
    expect(parseCodingModeArg("balanced")).toBe("auto");
    expect(parseCodingModeArg("")).toBeNull();
    expect(parseCodingModeArg("nope")).toBeNull();
  });

  it("normalizes legacy balanced", () => {
    expect(normalizeCodingMode("balanced")).toBe("auto");
  });
});

describe("detectCodingModeSwitch", () => {
  it("parses Effective phase / MODE_SWITCH / [[mode]] / /mode", () => {
    expect(detectCodingModeSwitch("Effective phase: polish — audit tests.")).toBe("polish");
    expect(detectCodingModeSwitch("MODE_SWITCH: plan")).toBe("plan");
    expect(detectCodingModeSwitch("[[ mode: build ]]")).toBe("build");
    expect(detectCodingModeSwitch("/mode deepreep next")).toBe("deepreep");
    expect(detectCodingModeSwitch("we should plan carefully")).toBeNull();
  });

  it("last match wins across patterns", () => {
    expect(
      detectCodingModeSwitch("Effective phase: plan\n\n[[mode: deepreep]]"),
    ).toBe("deepreep");
  });
});

describe("codingModeForPipelineStage", () => {
  it("maps default coding-product pipeline stages", () => {
    expect(codingModeForPipelineStage({ id: "research" })).toBe("deepreep");
    expect(codingModeForPipelineStage({ id: "planning" })).toBe("plan");
    expect(codingModeForPipelineStage({ id: "implementation" })).toBe("build");
    expect(codingModeForPipelineStage({ id: "verification" })).toBe("polish");
  });
});

describe("effectiveCodingModeFromMessages", () => {
  it("scans assistant text only when configured mode is auto", () => {
    expect(effectiveCodingModeFromMessages([
      { role: "assistant", content: "Effective phase: deepreep — survey first." },
    ], "auto")).toBe("deepreep");
    expect(effectiveCodingModeFromMessages([
      { role: "assistant", content: "Effective phase: build" },
    ], "polish")).toBe("polish");
  });
});
