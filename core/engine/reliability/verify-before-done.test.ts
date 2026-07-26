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

describe("mutation detection reads the strings the tools actually emit", () => {
  // Regression: success was inferred by NOT finding `denied|failed|error`
  // anywhere in the result. `Updated src/components/AppErrorBoundary.tsx`
  // contains "Error" in the FILENAME, so the gate concluded no file had
  // changed and skipped verification for a real edit.
  it("counts a write whose path contains a scary word", () => {
    for (const rel of [
      "src/components/AppErrorBoundary.tsx",
      "src/lib/failed-request.ts",
      "tests/denied-access.test.ts",
    ]) {
      expect(turnHadFileMutations([
        { type: "tool", name: "write_file", result: `Updated ${rel}` },
      ]), rel).toBe(true);
    }
  });

  it("counts the diff-header shape edit_file returns", () => {
    expect(turnHadFileMutations([
      { type: "tool", name: "edit_file", result: "M  src/error-handler.ts (+3 −1)" },
    ])).toBe(true);
  });

  it("does NOT count a patch that never applied", () => {
    // The malformed-patch message contains none of the old marker words, so it
    // used to be counted as a successful mutation.
    expect(turnHadFileMutations([
      { type: "tool", name: "edit_file", result: "edit_file could not parse the patch: the patch was empty. Nothing was executed — the file is unchanged." },
    ])).toBe(false);

    expect(turnHadFileMutations([
      { type: "tool", name: "edit_file", result: "Edit rejected [MISSING]: File not found: a.ts" },
    ])).toBe(false);
  });

  it("does not let a post-edit-verify appendix hide the write", () => {
    expect(turnHadFileMutations([
      { type: "tool", name: "write_file", result: "Updated a.ts\n[post-edit-verify failed] npx tsc --noEmit\nerror TS1005" },
    ])).toBe(true);
  });
});
