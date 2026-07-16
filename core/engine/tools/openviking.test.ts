import { describe, it, expect, vi } from "vitest";
import { buildOpenVikingTools } from "./openviking.js";
import type { OpenVikingClient } from "../memory/openviking.js";

async function exec(tools: ReturnType<typeof buildOpenVikingTools>, name: string, input: unknown): Promise<string> {
  const t = tools[name] as { execute: (input: unknown, opts: unknown) => Promise<string> };
  return t.execute(input, { toolCallId: "t1", messages: [] });
}

function mockClient(overrides: Partial<OpenVikingClient> = {}): OpenVikingClient {
  return {
    health: vi.fn(async () => ({ status: "ok" })),
    find: vi.fn(async (q: string) => ({ hits: [{ q }] })),
    addMessage: vi.fn(async () => ({ ok: true })),
    commitSession: vi.fn(async () => ({ committed: true })),
    ...overrides,
  };
}

describe("openviking tools", () => {
  it("is empty when disabled", () => {
    expect(buildOpenVikingTools({ enabled: false })).toEqual({});
  });

  it("exposes health/find without a session, and write tools with a session", async () => {
    const client = mockClient();
    const readOnly = buildOpenVikingTools({ enabled: true }, { client });
    expect(Object.keys(readOnly).sort()).toEqual(["openviking_find", "openviking_health"]);

    const health = await exec(readOnly, "openviking_health", {});
    expect(health).toContain("untrusted external knowledge");
    expect(health).toContain("ok");

    const found = await exec(readOnly, "openviking_find", { query: "architecture" });
    expect(found).toContain("architecture");
    expect(client.find).toHaveBeenCalledWith("architecture");

    const withSession = buildOpenVikingTools({ enabled: true }, { client, sessionId: "s1" });
    expect(withSession["openviking_add_message"]).toBeDefined();
    expect(withSession["openviking_commit_session"]).toBeDefined();

    await exec(withSession, "openviking_add_message", { role: "user", content: "hello" });
    expect(client.addMessage).toHaveBeenCalledWith("s1", "user", "hello");

    await exec(withSession, "openviking_commit_session", {});
    expect(client.commitSession).toHaveBeenCalledWith("s1");
  });

  it("returns structured errors without throwing", async () => {
    const client = mockClient({
      find: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const tools = buildOpenVikingTools({ enabled: true }, { client });
    const out = await exec(tools, "openviking_find", { query: "x" });
    expect(out).toContain("down");
    expect(out).toContain("find");
  });
});
