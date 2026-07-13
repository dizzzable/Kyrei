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

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.sessions).toEqual([
      { id: "empty-ru", title: "" },
      { id: "empty-en", title: "" },
      { id: "used", title: "New session" },
      { id: "custom", title: "My session" },
    ]);
  });
});
