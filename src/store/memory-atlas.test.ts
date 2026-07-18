import { beforeEach, describe, expect, it } from "vitest";
import { loadMemoryAtlasPreferences, saveMemoryAtlasPreferences } from "./memory-atlas";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

describe("memory atlas preferences", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips bounded workspace UI state", () => {
    saveMemoryAtlasPreferences("C:/repo", {
      viewport: { scale: 2, x: 10, y: -20 },
      expandedTreeIds: ["tree:code", "tree:code:src"],
      pinned: { "code:src/main.ts": { x: 12, y: 18 } },
      paneWidths: { left: 260, right: 320 },
    });
    expect(loadMemoryAtlasPreferences("C:/repo")).toMatchObject({
      viewport: { scale: 2, x: 10, y: -20 },
      expandedTreeIds: ["tree:code", "tree:code:src"],
      paneWidths: { left: 260, right: 320 },
    });
  });

  it("normalizes corrupt values instead of throwing", () => {
    localStorage.setItem("kyrei.memory-atlas.v2", JSON.stringify({
      workspaces: { "C:/repo": { viewport: { scale: 99, x: "bad" }, paneWidths: { left: -1, right: 9999 } } },
    }));
    expect(loadMemoryAtlasPreferences("C:/repo")).toMatchObject({
      viewport: { scale: 4, x: 0, y: 0 },
      paneWidths: { left: 180, right: 520 },
    });
  });
});
