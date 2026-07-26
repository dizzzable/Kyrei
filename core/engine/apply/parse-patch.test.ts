import { describe, it, expect } from "vitest";
import { parsePatch, sanitizePatch } from "./parse-patch.js";

const lines = (...l: string[]) => l.join("\n");

describe("parsePatch — blank lines inside a hunk", () => {
  it("keeps every hunk when a bare empty line separates them", () => {
    // Regression: a wholly empty line (what a trailing-whitespace stripper
    // leaves behind instead of " ") used to end parseHunks, and the outer
    // loop then discarded the remaining hunks as junk — silently applying
    // half the patch and reporting success.
    const patch = lines(
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " ctx1",
      "-old1",
      "+new1",
      "",
      "@@",
      " ctx2",
      "-old2",
      "+new2",
      "*** End Patch",
    );
    const [file] = parsePatch(patch);
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[1]?.needle).toEqual(["ctx2", "old2"]);
  });

  it("treats an empty line between hunk lines as a blank context line", () => {
    const patch = lines(
      "*** Update File: a.ts",
      " line1",
      "",
      " line3",
      "-old",
      "+new",
    );
    const [file] = parsePatch(patch);
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]?.needle).toEqual(["line1", "", "line3", "old"]);
  });

  it("does not absorb trailing blank padding into the needle", () => {
    const patch = lines(
      "*** Begin Patch",
      "*** Update File: a.ts",
      " ctx",
      "-old",
      "+new",
      "",
      "",
      "*** End Patch",
    );
    const [file] = parsePatch(patch);
    expect(file?.hunks[0]?.needle).toEqual(["ctx", "old"]);
  });

  it("does not absorb blank padding before the first hunk line", () => {
    const patch = lines("*** Update File: a.ts", "", " ctx", "-old", "+new");
    const [file] = parsePatch(patch);
    expect(file?.hunks[0]?.needle).toEqual(["ctx", "old"]);
  });

  it("still parses a correctly-formatted blank context line", () => {
    const patch = lines("*** Update File: a.ts", " line1", " ", " line3", "-old", "+new");
    const [file] = parsePatch(patch);
    expect(file?.hunks[0]?.needle).toEqual(["line1", "", "line3", "old"]);
  });
});

describe("parsePatch — blank lines in an Add File body", () => {
  it("keeps the whole body when an empty line appears mid-file", () => {
    // Regression: the body used to be truncated at the first "" and the file
    // was created with only the preceding lines.
    const patch = lines(
      "*** Begin Patch",
      "*** Add File: b.ts",
      "+const a = 1;",
      "",
      "+const b = 2;",
      "*** End Patch",
    );
    const [file] = parsePatch(patch);
    expect(file?.addBody).toEqual(["const a = 1;", "", "const b = 2;"]);
  });

  it("drops trailing blank padding after the body", () => {
    const patch = lines("*** Begin Patch", "*** Add File: b.ts", "+x", "", "*** End Patch");
    const [file] = parsePatch(patch);
    expect(file?.addBody).toEqual(["x"]);
  });

  it("still honours an explicit '+' empty line", () => {
    const patch = lines("*** Add File: b.ts", "+a", "+", "+c");
    const [file] = parsePatch(patch);
    expect(file?.addBody).toEqual(["a", "", "c"]);
  });
});

describe("parsePatch — multi-file and directives", () => {
  it("parses several files in one patch", () => {
    const patch = lines(
      "*** Begin Patch",
      "*** Update File: a.ts",
      " ctx",
      "-old",
      "+new",
      "",
      "*** Add File: b.ts",
      "+hello",
      "",
      "*** Delete File: c.ts",
      "*** End Patch",
    );
    const files = parsePatch(patch);
    expect(files.map((f) => [f.op, f.file])).toEqual([
      ["update", "a.ts"],
      ["add", "b.ts"],
      ["delete", "c.ts"],
    ]);
  });

  it("parses a move with hunks", () => {
    const patch = lines("*** Move File: a.ts -> sub/b.ts", " ctx", "-old", "+new");
    const [file] = parsePatch(patch);
    expect(file?.op).toBe("move");
    expect(file?.file).toBe("a.ts");
    expect(file?.dest).toBe("sub/b.ts");
    expect(file?.hunks).toHaveLength(1);
  });

  it("captures the @@ anchor text", () => {
    const patch = lines("*** Update File: a.ts", "@@ function myFunction() {", " ctx", "-old", "+new");
    const [file] = parsePatch(patch);
    expect(file?.hunks[0]?.anchor).toBe("function myFunction() {");
  });

  it("normalizes backslash paths and a leading ./", () => {
    const [file] = parsePatch(lines("*** Update File: ./src\\a.ts", " ctx", "-old", "+new"));
    expect(file?.file).toBe("src/a.ts");
  });

  it("stops a hunk at an unknown marker rather than swallowing it", () => {
    const patch = lines("*** Update File: a.ts", " ctx", "-old", "+new", "narrative text");
    const [file] = parsePatch(patch);
    expect(file?.hunks[0]?.ops).toHaveLength(3);
  });
});

describe("sanitizePatch", () => {
  it("strips a markdown fence", () => {
    const s = sanitizePatch("```diff\n*** Begin Patch\n*** End Patch\n```");
    expect(s.startsWith("*** Begin Patch")).toBe(true);
    expect(s.includes("```")).toBe(false);
  });

  it("strips a BOM and shell prompt prefixes", () => {
    const s = sanitizePatch("\uFEFF$ *** Begin Patch\nPS C:\\> *** End Patch");
    expect(s).toBe("*** Begin Patch\n*** End Patch");
  });

  it("truncates anything after the end marker", () => {
    const s = sanitizePatch("*** Begin Patch\n*** End Patch\nchatty trailer");
    expect(s.endsWith("*** End Patch")).toBe(true);
  });

  it("unwraps a heredoc", () => {
    const s = sanitizePatch("cat <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF");
    expect(s).toBe("*** Begin Patch\n*** End Patch");
  });
});
