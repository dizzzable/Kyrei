import { beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

describe("settings store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("fills new defaults when hydrating an older stored snapshot", async () => {
    localStorage.setItem("kyrei.ui-settings.v1", JSON.stringify({ density: "compact" }));

    const { getUiSettings } = await import("@/store/settings");

    expect(getUiSettings()).toMatchObject({
      density: "compact",
      toolView: "compact",
      showReasoning: true,
      notify: true,
    });
  });

  it("persists updates, including reasoning visibility, to localStorage", async () => {
    const { getUiSettings, setUiSetting } = await import("@/store/settings");

    setUiSetting("showReasoning", false);
    setUiSetting("voiceLang", "ru-RU");

    expect(getUiSettings().showReasoning).toBe(false);
    expect(JSON.parse(localStorage.getItem("kyrei.ui-settings.v1") ?? "{}")).toMatchObject({
      showReasoning: false,
      voiceLang: "ru-RU",
    });
  });

  it("resetUiSettings restores the shipped defaults", async () => {
    const { DEFAULT_UI_SETTINGS, getUiSettings, resetUiSettings, setUiSetting } = await import("@/store/settings");

    setUiSetting("showReasoning", false);
    setUiSetting("notify", false);
    resetUiSettings();

    expect(getUiSettings()).toEqual(DEFAULT_UI_SETTINGS);
    expect(JSON.parse(localStorage.getItem("kyrei.ui-settings.v1") ?? "{}")).toEqual(DEFAULT_UI_SETTINGS);
  });
});
