import { describe, expect, it } from "vitest";
import { buildToolView } from "@/lib/tool-view";
import type { ToolPart } from "@/lib/types";
import { createTranslator } from "@/i18n/translate";
import { enChat } from "@/i18n/locales/en/chat";
import { ruChat } from "@/i18n/locales/ru/chat";

const en = createTranslator(enChat, "en");
const ru = createTranslator(ruChat, "ru");

const tool = (p: Partial<ToolPart>): ToolPart => ({
  type: "tool",
  toolCallId: "t1",
  name: "read_file",
  running: false,
  ...p,
});

describe("buildToolView", () => {
  it("maps a known tool to its label/icon/tone and subtitle from path arg", () => {
    const v = buildToolView(tool({ name: "read_file", args: { path: "src/App.tsx" }, result: "..." }), en);
    expect(v.title).toBe("Read file");
    expect(v.icon).toBe("file-text");
    expect(v.tone).toBe("file");
    expect(v.subtitle).toBe("src/App.tsx");
    expect(v.status).toBe("success");
  });

  it("marks running/error status", () => {
    expect(buildToolView(tool({ running: true }), en).status).toBe("running");
    expect(buildToolView(tool({ error: "boom" }), en).status).toBe("error");
  });

  it("surfaces the error text as detail on failure", () => {
    const v = buildToolView(tool({ name: "run_command", args: { command: "ls" }, error: "exit 1" }), en);
    expect(v.status).toBe("error");
    expect(v.detail).toBe("exit 1");
    expect(v.subtitle).toBe("ls");
  });

  it("computes diff stats and flags file edits", () => {
    const v = buildToolView(
      tool({ name: "write_file", args: { path: "a.ts" }, inlineDiff: " keep\n-old\n+new\n+extra" }),
      en,
    );
    expect(v.isFileEdit).toBe(true);
    expect(v.diffStats).toEqual({ added: 2, removed: 1 });
  });

  it("shows a duration label only when finished", () => {
    expect(buildToolView(tool({ durationS: 1.53, result: "x" }), en).durationLabel).toBe("1.5s");
    expect(buildToolView(tool({ durationS: 1.5, running: true }), en).durationLabel).toBe("");
  });

  it("falls back to a prettified label for unknown tools", () => {
    const v = buildToolView(tool({ name: "custom_thing", result: "ok" }), ru);
    expect(v.title).toBe("Инструмент: Custom Thing");
    expect(v.icon).toBe("wrench");
  });

  it("maps isolated web and GBrain tools without exposing a browser surface", () => {
    expect(buildToolView(tool({ name: "web_search", args: { query: "Kyrei" } }), en)).toMatchObject({
      title: "Web search",
      icon: "globe-search",
      tone: "web",
      subtitle: "Kyrei",
    });
    expect(buildToolView(tool({ name: "web_fetch", args: { url: "https://example.com" } }), en)).toMatchObject({
      title: "Fetch web page",
      icon: "globe",
      tone: "web",
    });
    expect(buildToolView(tool({ name: "brain_search", args: { query: "project" } }), en)).toMatchObject({
      title: "Search GBrain memory",
      icon: "brain",
      tone: "agent",
    });
  });

  it("describes skill activity with localized labels and relevant inputs", () => {
    expect(buildToolView(tool({ name: "search_skills", args: { query: "react" } }), en)).toMatchObject({
      title: "Find assigned skills",
      icon: "search",
      tone: "search",
      subtitle: "react",
    });
    expect(buildToolView(tool({ name: "read_skill", args: { id: "skill_react" } }), en)).toMatchObject({
      title: "Load skill instructions",
      icon: "book-open",
      tone: "agent",
      subtitle: "skill_react",
    });
    expect(buildToolView(tool({ name: "read_skill_document", args: { skillId: "skill_react", documentId: "doc_hooks" } }), ru)).toMatchObject({
      title: "Чтение документа skill",
      icon: "file-text",
      tone: "agent",
      subtitle: "doc_hooks",
    });
    expect(buildToolView(tool({ name: "search_skill_documents", args: { skillId: "skill_react", query: "hooks" } }), en)).toMatchObject({
      title: "Search skill documents",
      icon: "search",
      tone: "search",
      subtitle: "hooks",
    });
  });
});
