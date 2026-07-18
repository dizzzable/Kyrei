import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerEnvironment,
  CodexAppServerConnector,
  CodexAppServerError,
  resolveCodexAppServerExecutable,
} from "../core/codex-app-server-connector.js";

class FakeAppServerChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  constructor(onRequest: (message: Record<string, unknown>, send: (message: Record<string, unknown>) => void) => void) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        onRequest(JSON.parse(line), (message) => this.stdout.write(`${JSON.stringify(message)}\n`));
      }
    });
  }
}

const inertClock = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
};

describe("Codex App Server connector boundary", () => {
  it("resolves only absolute local Codex launchers", () => {
    const checked: string[] = [];
    const executable = resolveCodexAppServerExecutable({
      platform: "win32",
      environment: { PATH: ";.;relative;C:\\Safe\\bin;\\\\server\\share" },
      isExecutable(candidate: string) {
        checked.push(candidate);
        return candidate === "C:\\Safe\\bin\\codex.cmd";
      },
    });

    expect(executable).toBe("C:\\Safe\\bin\\codex.cmd");
    expect(checked).toEqual(["C:\\Safe\\bin\\codex.cmd"]);
    expect(() => new CodexAppServerConnector({ executable: "codex app-server" })).toThrow(CodexAppServerError);
  });

  it("inherits operational PATH without leaking generic secrets to the native agent", () => {
    const environment = buildCodexAppServerEnvironment({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/owner",
      LANG: "ru_RU.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
      NODE_OPTIONS: "--require malicious.js",
      RANDOM_SECRET: "must-not-leak",
    }, { platform: "linux" });

    expect(environment).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/owner",
      LANG: "ru_RU.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
    });
  });

  it("interrupts a newly created native thread instead of losing the cancel request", async () => {
    const controller = new AbortController();
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const child = new FakeAppServerChild((message, send) => {
      if (typeof message.method !== "string") return;
      requests.push({ method: message.method, params: message.params as Record<string, unknown> });
      if (message.method === "initialize") {
        send({ id: message.id, result: {} });
        return;
      }
      if (message.method === "thread/start") {
        send({ id: message.id, result: { thread: { id: "thr-new" } } });
        return;
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "turn-1" } } });
        queueMicrotask(() => controller.abort());
        return;
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
        queueMicrotask(() => send({ method: "turn/completed", params: { turn: { status: "interrupted" } } }));
      }
    });
    const spawn = vi.fn(() => child);
    const connector = new CodexAppServerConnector({
      executable: "/opt/codex/bin/codex",
      platform: "linux",
      spawn,
      clock: inertClock,
      environment: { PATH: "/usr/bin" },
    });

    await expect(connector.runTurn({ prompt: "cancel me", workspace: "/workspace", signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(requests).toContainEqual({ method: "turn/interrupt", params: { threadId: "thr-new" } });
  });
});
