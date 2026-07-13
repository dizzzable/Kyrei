import { describe, expect, it } from "vitest";
import { SessionStore } from "../core/session-store.js";

describe("session store localization migration", () => {
  it("clears legacy localized placeholders only for empty sessions", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const migrated = store.migrate({
      schemaVersion: 1,
      sessions: [
        { id: "empty-ru", title: "Новый диалог" },
        { id: "empty-en", title: "New session" },
        { id: "used", title: "New session" },
        { id: "custom", title: "My session" },
      ],
      messages: { used: [{ role: "user", content: "Keep the explicit title" }] },
    });

    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.sessions).toEqual([
      { id: "empty-ru", title: "" },
      { id: "empty-en", title: "" },
      { id: "used", title: "New session" },
      { id: "custom", title: "My session" },
    ]);
  });

  it("preserves bounded provider and model overrides", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const migrated = store.migrate({
      schemaVersion: 2,
      sessions: [
        { id: "valid", title: "Chat", providerId: "provider", modelId: "model", providerAccountId: "backup-1" },
        { id: "invalid", title: "Chat", providerId: { nested: true }, modelId: "", providerAccountId: "../secret" },
      ],
      messages: {},
    });
    expect(migrated.sessions).toEqual([
      { id: "valid", title: "Chat", providerId: "provider", modelId: "model", providerAccountId: "backup-1" },
      { id: "invalid", title: "Chat" },
    ]);
  });

  it("clears a stale account binding without changing the provider target", () => {
    const store = new SessionStore({ runtimeDir: "." });
    store.upsertSession({
      id: "session",
      providerId: "provider",
      modelId: "model",
      providerAccountId: "backup",
    });
    store.upsertSession({ id: "session", providerAccountId: undefined });
    expect(store.getSession("session")).toEqual({
      id: "session",
      providerId: "provider",
      modelId: "model",
    });
  });
});
