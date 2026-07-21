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

  it("replaces an agent tab in place when the same session id is reused for the next command", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "event",
      event: {
        type: "created",
        session: {
          ...session("agent-1"),
          kind: "agent",
          actorId: "main",
          toolCallId: "tool-1",
          title: "Kyrei · main",
          status: "exited",
          exitCode: 0,
          output: [{ stream: "stdout", text: "old command\n" }],
        },
      },
    });
    state = terminalViewReducer(state, { type: "activate", sessionId: "agent-1" });
    state = terminalViewReducer(state, {
      type: "event",
      event: {
        type: "created",
        session: {
          ...session("agent-1"),
          kind: "agent",
          actorId: "main",
          toolCallId: "tool-2",
          title: "Kyrei · main",
          status: "running",
          exitCode: null,
          output: [],
        },
      },
    });
    expect(state.sessions).toHaveLength(1);
    expect(state.activeId).toBe("agent-1");
    expect(state.sessions[0]).toMatchObject({
      toolCallId: "tool-2",
      status: "running",
      output: [],
    });
  });

  it("focuses a newly started agent command even when another tab was active", () => {
    let state = terminalViewReducer(emptyTerminalState("chat-a"), {
      type: "hydrate",
      ownerId: "chat-a",
      sessions: [session("manual"), session("agent-1")],
    });
    state = terminalViewReducer(state, { type: "activate", sessionId: "manual" });
    state = terminalViewReducer(state, {
      type: "event",
      event: {
        type: "created",
        session: {
          ...session("agent-2"),
          kind: "agent",
          actorId: "main",
          toolCallId: "tool-9",
          title: "Kyrei · main",
          status: "running",
        },
      },
    });
    expect(state.activeId).toBe("agent-2");
  });
});
