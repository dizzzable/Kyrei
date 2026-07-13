import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG } from "./catalog";
import {
  createTranslator,
  resolveInitialLang,
  syncDocumentLang,
} from "./translate";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("createTranslator", () => {
  it("interpolates named parameters", () => {
    const t = createTranslator(CATALOG.en, "en");

    expect(t("common.welcome", { name: "Ada" })).toBe("Welcome, Ada");
  });

  it("selects English and Russian plural categories", () => {
    const en = createTranslator(CATALOG.en, "en");
    const ru = createTranslator(CATALOG.ru, "ru");

    expect(en("common.items", { count: 1 })).toBe("1 item");
    expect(en("common.items", { count: 2 })).toBe("2 items");
    expect(ru("common.items", { count: 1 })).toBe("1 элемент");
    expect(ru("common.items", { count: 2 })).toBe("2 элемента");
    expect(ru("common.items", { count: 5 })).toBe("5 элементов");
  });

  it("keeps unresolved placeholders visible instead of fabricating values", () => {
    const t = createTranslator(CATALOG.en, "en");

    expect(t("common.welcome")).toBe("Welcome, {name}");
  });
});

describe("startup locale", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers a valid persisted locale", () => {
    const storage = new MemoryStorage();
    storage.setItem("kyrei-lang", "ru");

    expect(resolveInitialLang(storage, ["en-US"])).toBe("ru");
  });

  it("ignores invalid persisted data and follows a supported system locale", () => {
    const storage = new MemoryStorage();
    storage.setItem("kyrei-lang", "javascript:alert(1)");

    expect(resolveInitialLang(storage, ["ru-RU", "en-US"])).toBe("ru");
  });

  it("falls back to English when the system locale is unsupported", () => {
    const storage = new MemoryStorage();

    expect(resolveInitialLang(storage, ["de-DE"])).toBe("en");
    expect(resolveInitialLang(undefined, [])).toBe("en");
  });

  it("synchronizes the html lang attribute", () => {
    const root = { lang: "" };

    syncDocumentLang("ru", { documentElement: root });

    expect(root.lang).toBe("ru");
  });

  it("synchronizes and persists the locale on startup and changes", async () => {
    const storage = new MemoryStorage();
    const root = { lang: "" };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("navigator", { languages: ["ru-RU"] });
    vi.stubGlobal("document", { documentElement: root });

    const { $lang, setLang } = await import("./index");

    expect($lang.get()).toBe("ru");
    expect(root.lang).toBe("ru");
    expect(storage.getItem("kyrei-lang")).toBe("ru");

    setLang("en");

    expect($lang.get()).toBe("en");
    expect(root.lang).toBe("en");
    expect(storage.getItem("kyrei-lang")).toBe("en");
  });
});
