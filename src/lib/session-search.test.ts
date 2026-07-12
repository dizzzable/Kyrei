import { describe, it, expect } from "vitest";

import { sessionMatchesSearch, sessionTitle } from "@/lib/session-search";
import type { SessionInfo } from "@/lib/types";

const session: SessionInfo = {
  id: "sess-ABC123",
  title: "Refactor Auth Module",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("sessionTitle", () => {
  it("returns the title when present", () => {
    expect(sessionTitle(session)).toBe("Refactor Auth Module");
  });

  it("falls back to Untitled when title is missing or blank", () => {
    expect(sessionTitle({ id: "x" })).toBe("Untitled");
    expect(sessionTitle({ id: "x", title: "   " })).toBe("Untitled");
  });
});

describe("sessionMatchesSearch", () => {
  it("returns true for an empty or whitespace-only query", () => {
    expect(sessionMatchesSearch(session, "")).toBe(true);
    expect(sessionMatchesSearch(session, "   ")).toBe(true);
  });

  it("matches by title (case-insensitive)", () => {
    expect(sessionMatchesSearch(session, "refactor")).toBe(true);
    expect(sessionMatchesSearch(session, "AUTH")).toBe(true);
  });

  it("matches by id (case-insensitive)", () => {
    expect(sessionMatchesSearch(session, "abc123")).toBe(true);
    expect(sessionMatchesSearch(session, "SESS-")).toBe(true);
  });

  it("requires all query words to match (AND)", () => {
    expect(sessionMatchesSearch(session, "refactor auth")).toBe(true);
    expect(sessionMatchesSearch(session, "refactor missing")).toBe(false);
  });

  it("returns false when nothing matches", () => {
    expect(sessionMatchesSearch(session, "database")).toBe(false);
  });

  it("uses the Untitled fallback for matching", () => {
    expect(sessionMatchesSearch({ id: "id-1" }, "untitled")).toBe(true);
  });
});
