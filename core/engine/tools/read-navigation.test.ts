import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";

import { buildTools } from "./index.js";
import { createReadMemo } from "../context/read-memo.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

let ws = "";
let tools: ToolSet;

async function exec(name: string, args: unknown, toolCallId = "t"): Promise<string> {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return String(await tool.execute(args, { toolCallId, messages: [] }));
}

/** 120 numbered lines, so a slice is unambiguous. */
const LINES = Array.from({ length: 120 }, (_, i) => `line ${i + 1} content`);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kyrei-read-nav-"));
  await writeFile(join(ws, "big.txt"), `${LINES.join("\n")}\n`, "utf8");
  tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

describe("read_file line ranges", () => {
  it("returns only the requested slice, numbered", async () => {
    const out = await exec("read_file", { path: "big.txt", offset: 10, limit: 3 });

    expect(out).toContain("10\tline 10 content");
    expect(out).toContain("12\tline 12 content");
    expect(out).not.toContain("line 13 content");
    expect(out).not.toContain("line 9 content");
  });

  it("reports the slice position and how much remains", async () => {
    const out = await exec("read_file", { path: "big.txt", offset: 10, limit: 3 });

    expect(out).toContain("lines: 10-12 of 120");
    expect(out).toContain("108 lines after this slice");
    // The next call is spelled out so the model does not have to compute it.
    expect(out).toContain("offset 13");
  });

  it("warns that the numbers must not go into a patch", async () => {
    // edit_file is context-anchored: a pasted "12\t" prefix would never match.
    const out = await exec("read_file", { path: "big.txt", offset: 1, limit: 2 });
    expect(out).toContain("display-only");
  });

  it("clamps a range past the end of the file instead of failing", async () => {
    const out = await exec("read_file", { path: "big.txt", offset: 119, limit: 50 });

    expect(out).toContain("120\tline 120 content");
    expect(out).toContain("lines: 119-120 of 120");
    expect(out).not.toContain("after this slice");
  });

  it("leaves an unranged read unnumbered, because it feeds edit_file patches", async () => {
    const out = await exec("read_file", { path: "big.txt" });

    expect(out).toContain("line 1 content");
    expect(out).not.toContain("1\tline 1 content");
    expect(out).not.toContain("lines:");
  });

  it("marks file contents as untrusted, ranged or not", async () => {
    // No test asserted the banner was PRESENT, so the whole
    // security-motivated provenance line could have been deleted silently.
    // It is what tells the model that file text is data, not instructions.
    for (const args of [{ path: "big.txt" }, { path: "big.txt", offset: 1, limit: 2 }]) {
      const out = await exec("read_file", args);
      expect(out, JSON.stringify(args)).toContain("untrusted");
      expect(out, JSON.stringify(args)).toContain("file: big.txt");
    }
  });

  it("marks grep results as untrusted too", async () => {
    const out = await exec("grep_search", { query: "line 50 content" });
    expect(out).toContain("untrusted");
  });
});

describe("read_file ranges and the read memo", () => {
  it("does not answer a different slice with the already-read stub", async () => {
    // The memo keys by path; without a range-aware key the second call would be
    // told "content unchanged" and never see the lines it asked for.
    const readMemo = createReadMemo();
    const memoTools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), { readMemo });
    const call = (args: unknown) => {
      const tool = memoTools.read_file as { execute: (a: unknown, o: unknown) => Promise<unknown> };
      return tool.execute(args, { toolCallId: "t", messages: [] }).then(String);
    };

    const first = await call({ path: "big.txt", offset: 1, limit: 2 });
    expect(first).toContain("1\tline 1 content");

    const second = await call({ path: "big.txt", offset: 50, limit: 2 });
    expect(second).not.toContain("read-memo");
    expect(second).toContain("50\tline 50 content");

    // The identical slice is still deduplicated.
    const repeat = await call({ path: "big.txt", offset: 50, limit: 2 });
    expect(repeat).toContain("read-memo");
  });

  it("drops every memoized slice when the file is written", async () => {
    const readMemo = createReadMemo();
    readMemo.note("big.txt", "whole");
    readMemo.note("big.txt#1-2", "slice a");
    readMemo.note("other.txt#1-2", "unrelated");

    readMemo.invalidate("big.txt");

    expect(readMemo.get("big.txt")).toBeUndefined();
    expect(readMemo.get("big.txt#1-2")).toBeUndefined();
    // A file whose name merely shares a prefix must survive.
    expect(readMemo.get("other.txt#1-2")).toBeDefined();
  });
});

describe("grep_search context lines", () => {
  it("returns surrounding lines marked as context", async () => {
    const out = await exec("grep_search", { query: "line 50 content", context: 2 });

    expect(out).toMatch(/big\.txt:50: .*line 50 content/);
    // ripgrep's convention: '-' for context, ':' for the match itself.
    expect(out).toMatch(/big\.txt:48- /);
    expect(out).toMatch(/big\.txt:52- /);
  });

  it("returns no context by default, as before", async () => {
    const out = await exec("grep_search", { query: "line 50 content" });

    expect(out).toContain("line 50 content");
    expect(out).not.toMatch(/big\.txt:49- /);
  });

  it("does not let context lines consume the maxResults budget", async () => {
    // Context is the point of asking; charging it against the match budget
    // would silently return fewer matches than the model requested.
    const out = await exec("grep_search", { query: "line 2[0-9] content", maxResults: 3, context: 2 });

    const matchLines = out.split("\n").filter((line) => /big\.txt:\d+: /.test(line));
    expect(matchLines).toHaveLength(3);
    expect(out.split("\n").filter((line) => /big\.txt:\d+- /.test(line)).length).toBeGreaterThan(0);
  });

  it("still reports truncation when matches are capped", async () => {
    const out = await exec("grep_search", { query: "line 2[0-9] content", maxResults: 2, context: 1 });
    expect(out).toContain("more matches not shown");
  });
});

describe("read_file range edge cases", () => {
  it("reports an empty file as zero lines, not a phantom line 1", async () => {
    await writeFile(join(ws, "empty.txt"), "", "utf8");
    const out = await exec("read_file", { path: "empty.txt", offset: 1 });

    expect(out).toContain("0 lines");
    expect(out).not.toContain("1\t");
    expect(out).not.toContain("of 1");
  });

  it("says an offset past the end is past the end", async () => {
    // Clamping returned the LAST line as if it were the slice asked for, so a
    // paging loop re-received content it already had — under a fresh memo key
    // that could not dedupe it.
    const out = await exec("read_file", { path: "big.txt", offset: 999 });

    expect(out).toContain("past the end");
    expect(out).toContain("120-line");
    expect(out).not.toContain("120\tline 120 content");
  });

  it("honours a limit with no offset", async () => {
    const out = await exec("read_file", { path: "big.txt", limit: 2 });
    expect(out).toContain("lines: 1-2 of 120");
    expect(out).toContain("1\tline 1 content");
    expect(out).not.toContain("3\tline 3 content");
  });
});

describe("batch forwards read_file's arguments", () => {
  it("passes offset and limit through instead of returning the whole file", async () => {
    // grep/find legs forwarded the whole arg object; read_file forwarded only
    // `path`, so a batched ranged read silently returned everything and was
    // then chopped mid-line by the per-leg budget.
    const out = await exec("batch", {
      calls: [{ tool: "read_file", args: { path: "big.txt", offset: 10, limit: 2 } }],
    });

    expect(out).toContain("10\tline 10 content");
    expect(out).toContain("lines: 10-11 of 120");
    expect(out).not.toContain("line 40 content");
  });
});
