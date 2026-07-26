import { describe, expect, it } from "vitest";
import { buildMcpTools } from "../tools/mcp.js";
import { createMcpManager, normalizeMcpConfig } from "./manager.js";

type CallResult = {
  ok: boolean;
  serverId: string;
  tool: string;
  content?: string;
  error?: string;
  isError?: boolean;
};

function toolsWith(result: CallResult) {
  const manager = {
    listTools: async () => [],
    inspectServers: async () => [],
    callTool: async () => result,
    close: async () => undefined,
  };
  return buildMcpTools(
    normalizeMcpConfig({ enabled: true, servers: [{ id: "srv", command: "node" }] }),
    { manager: manager as never, sensitiveValues: [], maxModelOutputChars: 8_000 },
  );
}

async function callMcp(result: CallResult): Promise<string> {
  const tools = toolsWith(result);
  const tool = tools.mcp_call as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return String(await tool.execute(
    { serverId: "srv", tool: "do_thing", arguments: {} },
    { toolCallId: "t", messages: [] },
  ));
}

describe("a failed MCP call tells the model what actually went wrong", () => {
  it("surfaces a tool-level error, which the manager reports in `content`", async () => {
    // Regression: `isError: true` sets `content` and leaves `error` UNSET, so
    // the tool printed "error: unknown" and discarded the server's own
    // explanation. The model could then only retry the identical call.
    const out = await callMcp({
      ok: false,
      serverId: "srv",
      tool: "do_thing",
      isError: true,
      content: "path parameter must be absolute",
    });

    expect(out).toContain("path parameter must be absolute");
    expect(out).not.toContain("unknown");
  });

  it("still surfaces a transport error, which is reported in `error`", async () => {
    const out = await callMcp({
      ok: false,
      serverId: "srv",
      tool: "do_thing",
      error: "mcp_server_exited: ENOENT",
    });

    expect(out).toContain("mcp_server_exited: ENOENT");
  });

  it("tells the model not to repeat the call when there is no detail at all", async () => {
    const out = await callMcp({ ok: false, serverId: "srv", tool: "do_thing" });

    expect(out).toContain("without any detail");
    expect(out).not.toMatch(/error:\s*$/m);
  });

  it("keeps the untrusted-source marking on the failure path", async () => {
    const out = await callMcp({ ok: false, serverId: "srv", tool: "do_thing", error: "boom" });
    expect(out).toContain("untrusted external system");
  });
});

describe("the MCP catalog fan-out is concurrent and cached", () => {
  function slowManagerConfig(servers: number, delayMs: number) {
    let listCalls = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const config = normalizeMcpConfig({
      enabled: true,
      servers: Array.from({ length: servers }, (_, i) => ({ id: `srv${i}`, command: "node" })),
    });
    const manager = createMcpManager({
      config,
      createClient: () => ({
        listTools: async () => {
          listCalls += 1;
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1;
          return [{ name: "do_thing", description: "d" }];
        },
        callTool: async () => ({}),
        close: async () => undefined,
      }),
    });
    return { manager, calls: () => listCalls, peak: () => peakInFlight };
  }

  it("queries every server at once rather than one after another", async () => {
    // Sequential fan-out meant maxServers x timeoutMs (8 x 30s) could elapse
    // inside ONE tool call while the model waited.
    //
    // Asserted by counting SIMULTANEOUS in-flight calls rather than wall time:
    // a clock-based bound flakes on a loaded CI runner and, worse, can pass on
    // a serial implementation that simply ran fast.
    const { manager, peak } = slowManagerConfig(6, 20);
    const tools = await manager.listTools();

    expect(tools).toHaveLength(6);
    expect(peak()).toBe(6); // a serial loop would peak at 1
  });

  it("does not re-list every server for each catalog page", async () => {
    const { manager, calls } = slowManagerConfig(3, 0);
    await manager.listTools();
    const afterFirst = calls();
    await manager.listTools();

    expect(afterFirst).toBe(3);
    expect(calls()).toBe(3);
  });

  it("preserves configured server order so page offsets are stable", async () => {
    // Concurrency must not let a fast server jump ahead of a slow one, or the
    // same offset would return different tools between pages.
    const config = normalizeMcpConfig({
      enabled: true,
      servers: [{ id: "slow", command: "node" }, { id: "fast", command: "node" }],
    });
    const manager = createMcpManager({
      config,
      createClient: (server) => ({
        listTools: async () => {
          if (server.id === "slow") await new Promise((resolve) => setTimeout(resolve, 40));
          return [{ name: "t", description: "d" }];
        },
        callTool: async () => ({}),
        close: async () => undefined,
      }),
    });

    expect((await manager.listTools()).map((t) => t.serverId)).toEqual(["slow", "fast"]);
  });
});
