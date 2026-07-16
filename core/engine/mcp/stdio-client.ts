/**
 * Minimal MCP stdio client (JSON-RPC 2.0 + Content-Length framing).
 * Implements initialize → tools/list → tools/call. No SDK dependency.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "./types.js";

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface McpStdioClientOptions {
  server: McpServerConfig;
  timeoutMs?: number;
  /** Test seam. */
  spawnImpl?: typeof spawn;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly timeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly options: McpStdioClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  get serverId(): string {
    return this.options.server.id;
  }

  async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("mcp_client_closed");
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.start();
    return this.initPromise;
  }

  private async start(): Promise<void> {
    const server = this.options.server;
    if (!server.command?.trim()) throw new Error("mcp_command_required");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(server.env ?? {}),
    };
    // Never inherit Electron renderer tokens into MCP children.
    delete env.ELECTRON_RUN_AS_NODE;

    this.child = this.spawnImpl(server.command, server.args ?? [], {
      cwd: server.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", () => {
      /* ignore noisy server logs; errors surface via RPC */
    });
    this.child.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });
    this.child.on("close", () => {
      this.failAll(new Error("mcp_server_exited"));
      this.child = null;
      this.initPromise = null;
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kyrei", version: "2.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.ensureStarted();
    const result = (await this.request("tools/list", {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
    };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .filter((t) => typeof t?.name === "string" && t.name.trim())
      .map((t) => ({
        name: String(t.name),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureStarted();
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("mcp_client_closed"));
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.child = null;
    this.initPromise = null;
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params } satisfies McpJsonRpcNotification);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin) return Promise.reject(new Error("mcp_not_started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_timeout:${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params } satisfies McpJsonRpcRequest);
    });
  }

  private write(message: object): void {
    if (!this.child?.stdin) throw new Error("mcp_not_started");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Drop one line and retry (tolerant of noise).
        const nl = this.buffer.indexOf("\n");
        this.buffer = nl >= 0 ? this.buffer.subarray(nl + 1) : Buffer.alloc(0);
        continue;
      }
      const length = Number(match[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString("utf8");
      this.buffer = this.buffer.subarray(total);
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* ignore malformed */
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (msg.id == null) return; // notification from server
    const id = Number(msg.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (msg.error) {
      const err = msg.error as { message?: string; code?: number };
      pending.reject(new Error(err.message ?? `mcp_error:${err.code ?? "unknown"}`));
      return;
    }
    pending.resolve(msg.result);
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}

/** Parse a single framed MCP message from a buffer (test helper). */
export function tryParseFramedMessage(buffer: Buffer): { message: unknown; rest: Buffer } | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) return null;
  const length = Number(match[1]);
  const total = headerEnd + 4 + length;
  if (buffer.length < total) return null;
  const body = buffer.subarray(headerEnd + 4, total).toString("utf8");
  return { message: JSON.parse(body), rest: buffer.subarray(total) };
}

