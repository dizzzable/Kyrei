import { describe, expect, it } from "vitest";

import type { TerminalSessionSnapshot } from "@/lib/desktop";
import { emptyTerminalState, MAX_RENDERER_OUTPUT_CHARS, terminalViewReducer } from "./terminal-state";

function session(id: string, ownerId = "chat-a"): TerminalSessionSnapshot {
  return {
    id,
    ownerId,
    kind: "manual",
    title: id,
    cwd: "C:\\repo",
    status: "running",
    output: [],
    exitCode: null,
    signal: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("terminal view state", () => {
  it("isolates terminal tabs by chat or agent owner", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "hydrate",
      ownerId: "chat-a",
      sessions: [session("one"), session("foreign", "chat-b")],
    });
    state = terminalViewReducer(state, { type: "event", event: { type: "created", session: session("foreign-2", "chat-b") } });
    expect(state.sessions.map((entry) => entry.id)).toEqual(["one"]);
  });

  it("tracks output, exit state, rename and close without losing the active tab", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "hydrate",
      ownerId: "chat-a",
      sessions: [session("one"), session("two")],
    });
    state = terminalViewReducer(state, { type: "activate", sessionId: "two" });
    state = terminalViewReducer(state, {
      type: "event",
      event: { type: "output", sessionId: "two", stream: "stderr", text: "failure\n", updatedAt: "later" },
    });
    state = terminalViewReducer(state, {
      type: "event",
      event: { type: "exited", session: { ...session("two"), title: "tests", status: "exited", exitCode: 1 } },
    });
    expect(state.sessions.find((entry) => entry.id === "two")).toMatchObject({ title: "tests", status: "exited", exitCode: 1 });
    state = terminalViewReducer(state, { type: "event", event: { type: "closed", sessionId: "two", ownerId: "chat-a" } });
    expect(state.activeId).toBe("one");
  });

  it("bounds renderer output even if a compromised main process emits too much", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "hydrate",
      ownerId: "chat-a",
      sessions: [session("one")],
    });
    state = terminalViewReducer(state, {
      type: "event",
      event: {
        type: "output",
        sessionId: "one",
        stream: "stdout",
        text: "x".repeat(MAX_RENDERER_OUTPUT_CHARS + 20),
        updatedAt: "later",
      },
    });
    expect(state.sessions[0].output[0].text).toHaveLength(MAX_RENDERER_OUTPUT_CHARS);
  });

  it("does not erase early output when the create response follows the event stream", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "event",
      event: { type: "created", session: session("one") },
    });
    state = terminalViewReducer(state, {
      type: "event",
      event: { type: "output", sessionId: "one", stream: "stdout", text: "ready\n", updatedAt: "later" },
    });
    state = terminalViewReducer(state, { type: "ensure", session: session("one") });
    state = terminalViewReducer(state, { type: "rename", sessionId: "one", title: "build" });

    expect(state.sessions[0]).toMatchObject({ title: "build", output: [{ stream: "stdout", text: "ready\n" }] });
  });

  it("selects the adjacent tab when the active terminal closes", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "hydrate",
      ownerId: "chat-a",
      sessions: [session("one"), session("two"), session("three")],
    });
    state = terminalViewReducer(state, { type: "activate", sessionId: "two" });
    state = terminalViewReducer(state, {
      type: "event",
      event: { type: "closed", sessionId: "two", ownerId: "chat-a" },
    });
    expect(state.activeId).toBe("three");
  });
});
