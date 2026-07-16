import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tryParseFramedMessage, McpStdioClient } from "./stdio-client.js";
import { createMcpManager, normalizeMcpConfig } from "./manager.js";
import { buildMcpTools } from "../tools/mcp.js";
import { decide } from "../security/permissions.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

describe("MCP framing", () => {
  it("parses Content-Length framed JSON-RPC messages", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
    const parsed = tryParseFramedMessage(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.message).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(parsed!.rest.length).toBe(0);
  });
});

describe("normalizeMcpConfig", () => {
  it("disables by default and sanitizes servers", () => {
    const cfg = normalizeMcpConfig({
      enabled: true,
      servers: [
        { id: "fs!", command: "npx", args: ["-y", "x"] },
        { id: "fs", command: "npx", args: ["-y", "x"] },
        { id: "dup", command: "" },
      ],
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.servers.map((s) => s.id)).toEqual(["fs_", "fs"]);
  });
});

describe("MCP permissions", () => {
  it("defaults mcp_call to ask and mcp_list_tools to allow", () => {
    const cfg = DEFAULT_ENGINE_CONFIG.permissions;
    expect(decide(cfg, { tool: "mcp_list_tools" })).toBe("allow");
    expect(decide(cfg, { tool: "mcp_call", target: "fs:read_file" })).toBe("ask");
  });
});

describe("buildMcpTools", () => {
  it("is empty when disabled or no servers", () => {
    expect(buildMcpTools(normalizeMcpConfig({ enabled: false, servers: [] }))).toEqual({});
    expect(
      buildMcpTools(normalizeMcpConfig({ enabled: true, servers: [] })),
    ).toEqual({});
  });

  it("lists and calls tools through the manager", async () => {
    const manager = {
      config: normalizeMcpConfig({
        enabled: true,
        servers: [{ id: "demo", command: "echo" }],
      }),
      serverIds: () => ["demo"],
      listTools: vi.fn(async () => [
        { serverId: "demo", name: "ping", description: "Ping tool" },
      ]),
      callTool: vi.fn(async () => ({
        ok: true,
        serverId: "demo",
        tool: "ping",
        content: "pong",
      })),
      close: vi.fn(async () => undefined),
    };
    const tools = buildMcpTools(manager.config, { manager: manager as never });
    const list = tools["mcp_list_tools"] as {
      execute: (input: unknown, opts: unknown) => Promise<string>;
    };
    const listed = await list.execute({}, { toolCallId: "t", messages: [] });
    expect(listed).toContain("ping");
    expect(listed).toContain("[demo]");

    const call = tools["mcp_call"] as {
      execute: (input: unknown, opts: unknown) => Promise<string>;
    };
    const out = await call.execute(
      { serverId: "demo", tool: "ping", arguments: {} },
      { toolCallId: "t2", messages: [] },
    );
    expect(out).toContain("pong");
    expect(manager.callTool).toHaveBeenCalledWith("demo", "ping", {});
  });
});

describe("McpStdioClient integration (mock process)", () => {
  it("initializes and lists tools over framed stdio", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = { write: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
    });

    const spawnImpl = vi.fn(() => child) as never;
    const client = new McpStdioClient({
      server: { id: "mock", command: "mock-mcp" },
      timeoutMs: 2_000,
      spawnImpl,
    });

    // Respond to initialize then tools/list based on written requests.
    child.stdin.write.mockImplementation((buf: Buffer) => {
      const text = buf.toString("utf8");
      const bodyStart = text.indexOf("\r\n\r\n");
      if (bodyStart < 0) return true;
      const msg = JSON.parse(text.slice(bodyStart + 4)) as {
        id?: number;
        method?: string;
      };
      if (msg.method === "initialize" && msg.id != null) {
        const result = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock" } },
        });
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(`Content-Length: ${Buffer.byteLength(result)}\r\n\r\n${result}`),
          );
        });
      }
      if (msg.method === "tools/list" && msg.id != null) {
        const result = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "echo", description: "Echo" }] },
        });
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(`Content-Length: ${Buffer.byteLength(result)}\r\n\r\n${result}`),
          );
        });
      }
      return true;
    });

    const tools = await client.listTools();
    expect(tools).toEqual([{ name: "echo", description: "Echo" }]);
    await client.close();
    expect(child.kill).toHaveBeenCalled();
  });
});
