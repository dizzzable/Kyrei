import { describe, expect, it } from "vitest";

import {
  countDiffLineStats,
  diffKind,
  parseDiff,
  parseFullFileDiff,
  stripDiffFileHeaders,
  stripDiffMarker,
} from "./diff";

describe("diffKind", () => {
  it("classifies add/remove/context and ignores +++/--- headers", () => {
    expect(diffKind("+added")).toBe("add");
    expect(diffKind("-removed")).toBe("remove");
    expect(diffKind(" context")).toBe("context");
    expect(diffKind("+++ b/file.ts")).toBe("context");
    expect(diffKind("--- a/file.ts")).toBe("context");
  });
});

describe("stripDiffMarker", () => {
  it("drops the leading +/-/space gutter, keeping the rest of the indentation", () => {
    expect(stripDiffMarker("+foo")).toBe("foo");
    expect(stripDiffMarker("-bar")).toBe("bar");
    expect(stripDiffMarker(" baz")).toBe("baz");
    expect(stripDiffMarker("   deep")).toBe("  deep");
  });
});

describe("stripDiffFileHeaders", () => {
  it("strips git/index/---/+++/arrow headers up to the first @@ hunk", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "index 1111111..2222222 100644",
      "--- a/file.ts",
      "+++ b/file.ts",
      "a/file.ts → b/file.ts",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+new",
    ].join("\n");

    expect(stripDiffFileHeaders(diff)).toBe(["@@ -1,2 +1,2 @@", " context", "-old", "+new"].join("\n"));
  });

  it("keeps everything from the first @@ onward", () => {
    const diff = [
      "diff --git a/x b/x",
      "new file mode 100644",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");

    expect(stripDiffFileHeaders(diff)).toBe(["@@ -0,0 +1,1 @@", "+hello"].join("\n"));
  });
});

describe("parseDiff", () => {
  it("marks add/remove/context and strips markers", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " tail",
    ].join("\n");

    const lines = parseDiff(diff);

    expect(lines).toEqual([
      { kind: "context", text: "keep", oldNo: 1, newNo: 1 },
      { kind: "remove", text: "old", oldNo: 2 },
      { kind: "add", text: "new", newNo: 2 },
      { kind: "context", text: "tail", oldNo: 3, newNo: 3 },
    ]);
  });

  it("inserts a blank separator between hunks", () => {
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -10,1 +10,1 @@",
      "-c",
      "+d",
    ].join("\n");

    const lines = parseDiff(diff);

    expect(lines.map((l) => l.kind)).toEqual(["remove", "add", "context", "remove", "add"]);
    // The separator is a blank context row carrying no line numbers.
    const separator = lines[2];
    expect(separator).toEqual({ kind: "context", text: "" });
  });
});

describe("countDiffLineStats", () => {
  it("counts +N/-M excluding the +++/--- file headers", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-removed one",
      "-removed two",
      "+added one",
      "+added two",
      "+added three",
    ].join("\n");

    expect(countDiffLineStats(diff)).toEqual({ added: 3, removed: 2 });
  });

  it("returns zeros for a header-only diff", () => {
    const diff = ["--- a/file.ts", "+++ b/file.ts"].join("\n");

    expect(countDiffLineStats(diff)).toEqual({ added: 0, removed: 0 });
  });
});

describe("parseFullFileDiff", () => {
  it("anchors to current text and inserts removed lines between context (base case)", () => {
    const fullText = ["line1", "line2-new", "line3"].join("\n");
    const diff = ["@@ -1,3 +1,3 @@", " line1", "-line2-old", "+line2-new", " line3"].join("\n");

    const lines = parseFullFileDiff(diff, fullText);

    expect(lines).toEqual([
      { kind: "context", newNo: 1, oldNo: 1, text: "line1" },
      { kind: "remove", oldNo: 2, text: "line2-old" },
      { kind: "add", newNo: 2, oldNo: undefined, text: "line2-new" },
      { kind: "context", newNo: 3, oldNo: 3, text: "line3" },
    ]);
  });

  it("emits every current line as context when there are no hunks", () => {
    const lines = parseFullFileDiff("", ["a", "b"].join("\n"));

    expect(lines).toEqual([
      { kind: "context", newNo: 1, oldNo: 1, text: "a" },
      { kind: "context", newNo: 2, oldNo: 2, text: "b" },
    ]);
  });
});
