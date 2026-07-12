import { describe, expect, it } from "vitest";
import { buildToolView } from "@/lib/tool-view";
import type { ToolPart } from "@/lib/types";

const tool = (p: Partial<ToolPart>): ToolPart => ({
  type: "tool",
  toolCallId: "t1",
  name: "read_file",
  running: false,
  ...p,
});

describe("buildToolView", () => {
  it("maps a known tool to its label/icon/tone and subtitle from path arg", () => {
    const v = buildToolView(tool({ name: "read_file", args: { path: "src/App.tsx" }, result: "..." }));
    expect(v.title).toBe("Чтение файла");
    expect(v.icon).toBe("file-text");
    expect(v.tone).toBe("file");
    expect(v.subtitle).toBe("src/App.tsx");
    expect(v.status).toBe("success");
  });

  it("marks running/error status", () => {
    expect(buildToolView(tool({ running: true })).status).toBe("running");
    expect(buildToolView(tool({ error: "boom" })).status).toBe("error");
  });

  it("surfaces the error text as detail on failure", () => {
    const v = buildToolView(tool({ name: "run_command", args: { command: "ls" }, error: "exit 1" }));
    expect(v.status).toBe("error");
    expect(v.detail).toBe("exit 1");
    expect(v.subtitle).toBe("ls");
  });

  it("computes diff stats and flags file edits", () => {
    const v = buildToolView(
      tool({ name: "write_file", args: { path: "a.ts" }, inlineDiff: " keep\n-old\n+new\n+extra" }),
    );
    expect(v.isFileEdit).toBe(true);
    expect(v.diffStats).toEqual({ added: 2, removed: 1 });
  });

  it("shows a duration label only when finished", () => {
    expect(buildToolView(tool({ durationS: 1.53, result: "x" })).durationLabel).toBe("1.5s");
    expect(buildToolView(tool({ durationS: 1.5, running: true })).durationLabel).toBe("");
  });

  it("falls back to a prettified label for unknown tools", () => {
    const v = buildToolView(tool({ name: "custom_thing", result: "ok" }));
    expect(v.title).toBe("Custom Thing");
    expect(v.icon).toBe("wrench");
  });
});
