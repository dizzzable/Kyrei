import { describe, expect, it } from "vitest";
import {
  evaluateVerifyBeforeDone,
  turnHadFileMutations,
  turnHasVerifyEvidence,
} from "./verify-before-done.js";

describe("verify-before-done", () => {
  it("detects file mutations and missing verify", () => {
    const parts = [
      { type: "tool", name: "edit_file", result: "Файл обновлён: src/a.ts" },
    ];
    expect(turnHadFileMutations(parts)).toBe(true);
    expect(turnHasVerifyEvidence(parts)).toBe(false);
    expect(evaluateVerifyBeforeDone({
      enabled: true,
      status: "complete",
      parts,
    }).blocked).toBe(true);
  });

  it("accepts post-edit-verify appendix as evidence", () => {
    const parts = [
      {
        type: "tool",
        name: "edit_file",
        result: "Файл обновлён: a.ts\n[post-edit-verify ok] npx tsc --noEmit\n",
      },
    ];
    expect(turnHasVerifyEvidence(parts)).toBe(true);
    expect(evaluateVerifyBeforeDone({
      enabled: true,
      status: "complete",
      parts,
    }).blocked).toBe(false);
  });

  it("skips plan mode and non-complete status", () => {
    const parts = [{ type: "tool", name: "write_file", result: "Файл создан: x" }];
    expect(evaluateVerifyBeforeDone({
      enabled: true,
      status: "complete",
      codingMode: "plan",
      parts,
    }).blocked).toBe(false);
    expect(evaluateVerifyBeforeDone({
      enabled: true,
      status: "max_steps",
      parts,
    }).blocked).toBe(false);
  });

  it("accepts diagnostics tool", () => {
    const parts = [
      { type: "tool", name: "edit_file", result: "ok" },
      { type: "tool", name: "diagnostics", result: "tsc clean" },
    ];
    expect(turnHasVerifyEvidence(parts)).toBe(true);
  });
});
