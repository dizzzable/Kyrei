import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { redactSensitiveText } from "../core/secret-redaction.js";

const MAX_OWNER_LENGTH = 160;
const MAX_TITLE_LENGTH = 80;
const MAX_CWD_LENGTH = 32_768;
const MAX_WRITE_LENGTH = 65_536;
const MAX_COMMAND_LENGTH = 262_144;
const MAX_OUTPUT_CHARS = 262_144;
const MAX_TERMINALS_PER_OWNER = 16;
const MAX_TERMINALS_PER_RENDERER = 32;
const MAX_TIMEOUT_MS = 3_600_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SECRET_ENV_NAME = /(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|PRIVATE_?KEY|SESSION_?KEY|COOKIE|KUBECONFIG|DOCKER_AUTH_CONFIG)/i;
const SAFE_AGENT_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM",
  "NO_COLOR", "FORCE_COLOR", "SHELL", "APPDATA", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);
const TRUNCATION_MARKER = "\n… [output truncated]";
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

function terminalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function abortError() {
  const error = new Error("Tool execution was aborted");
  error.name = "AbortError";
  return error;
}

function textField(value, code, maxLength) {
  if (typeof value !== "string") throw terminalError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) {
    throw terminalError(code);
  }
  return normalized;
}

function commandField(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_COMMAND_LENGTH || value.includes("\0")) {
    throw terminalError("terminal_command_invalid");
  }
  return value;
}

function cwdField(value, fallback) {
  const workingDirectory = typeof value === "string" && value ? value : fallback;
  if (
    typeof workingDirectory !== "string"
    || workingDirectory.length > MAX_CWD_LENGTH
    || !isAbsolute(workingDirectory)
    || CONTROL_CHARACTERS.test(workingDirectory)
  ) {
    throw terminalError("terminal_cwd_invalid");
  }
  return workingDirectory;
}

function rendererField(value, allowInternal = false) {
  if (!Number.isSafeInteger(value) || value < (allowInternal ? 0 : 1)) {
    throw terminalError("terminal_renderer_invalid");
  }
  return value;
}

function boundedText(value, limit = MAX_OUTPUT_CHARS) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  const keep = Math.max(0, limit - TRUNCATION_MARKER.length);
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

export function sanitizeTerminalEnvironment(source = process.env) {
  const safe = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || SECRET_ENV_NAME.test(name)) continue;
    safe[name] = value;
  }
  safe.TERM = "dumb";
  return safe;
}

export function sanitizeAgentEnvironment(source = process.env) {
  const safe = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value !== "string"
      || !SAFE_AGENT_ENV.has(name.toUpperCase())
      || redactSensitiveText(value) !== value
    ) continue;
    safe[name] = value;
  }
  safe.TERM = "dumb";
  return safe;
}

export function defaultShellSpec(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const systemRoot = typeof env.SystemRoot === "string" && isAbsolute(env.SystemRoot)
      ? env.SystemRoot
      : "C:\\Windows";
    return {
      executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"],
    };
  }

  const allowed = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);
  const configured = typeof env.SHELL === "string" && isAbsolute(env.SHELL) && allowed.has(basename(env.SHELL))
    ? env.SHELL
    : "/bin/sh";
  // This is intentionally a pipe-backed shell, not a PTY. Interactive flags
  // would produce job-control warnings and misleading prompts.
  return { executable: configured, args: [] };
}

function publicSession(session) {
  return {
    id: session.id,
    ownerId: session.ownerId,
    kind: session.kind,
    ...(session.kind === "agent" ? { actorId: session.actorId, toolCallId: session.toolCallId } : {}),
    title: session.title,
    cwd: session.cwd,
    status: session.status,
    output: session.output.map((chunk) => ({ ...chunk })),
    exitCode: session.exitCode,
    signal: session.signal,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function appendOutput(session, stream, text) {
  if (!text) return;
  session.output.push({ stream, text });
  session.outputChars += text.length;
  while (session.outputChars > MAX_OUTPUT_CHARS && session.output.length > 1) {
    const removed = session.output.shift();
    session.outputChars -= removed.text.length;
  }
  if (session.outputChars > MAX_OUTPUT_CHARS && session.output.length === 1) {
    const only = session.output[0];
    only.text = only.text.slice(-MAX_OUTPUT_CHARS);
    session.outputChars = only.text.length;
  }
}

function redactBounded(value, sensitiveValues, { truncated = false } = {}) {
  if (truncated && sensitiveValues.some((secret) => secret.includes("\n") || secret.includes("\r"))) {
    return `[REDACTED]${TRUNCATION_MARKER}`;
  }
  let source = String(value ?? "");
  if (truncated) {
    const lastCompleteLine = source.lastIndexOf("\n");
    source = lastCompleteLine >= 0 ? source.slice(0, lastCompleteLine + 1) : "";
  }
  let clean = redactSensitiveText(source, sensitiveValues);
  // The shared redactor intentionally matches complete private-key blocks.
  // A process killed or clipped mid-block must not expose the unmatched tail.
  const incompletePrivateKey = clean.search(PRIVATE_KEY_BEGIN);
  // Complete blocks have already been replaced by redactSensitiveText, so any
  // BEGIN marker still present is necessarily incomplete or malformed.
  if (incompletePrivateKey >= 0) {
    clean = `${clean.slice(0, incompletePrivateKey)}[REDACTED]`;
  }
  return boundedText(truncated ? `${clean}${TRUNCATION_MARKER}` : clean);
}

async function terminateProcess(session, force, platform = process.platform) {
  const signal = force ? "SIGKILL" : "SIGTERM";
  const pid = session.child?.pid;
  if (session.kind === "agent" && pid && platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process may have already exited or may not own a process group.
    }
  }
  if (session.kind === "agent" && pid && platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = nodeSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const finish = () => resolvePromise();
      killer.once("error", finish);
      killer.once("close", finish);
    });
    return;
  }
  try {
    session.child.kill(signal);
  } catch {
    // A close event racing this request remains authoritative.
  }
}

export class TerminalSessionManager {
  constructor({
    spawnImpl = nodeSpawn,
    terminateImpl = terminateProcess,
    clock = () => new Date().toISOString(),
    createId = randomUUID,
    platform = process.platform,
    environment = process.env,
    defaultCwd,
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.terminateImpl = terminateImpl;
    this.clock = clock;
    this.createId = createId;
    this.platform = platform;
    this.environment = environment;
    this.defaultCwd = defaultCwd;
    this.sessions = new Map();
    this.listeners = new Set();
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw terminalError("terminal_listener_invalid");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Renderer delivery cannot change process ownership or lifecycle.
      }
    }
  }

  list(rendererId, ownerId) {
    const renderer = rendererField(rendererId, true);
    const owner = textField(ownerId, "terminal_owner_invalid", MAX_OWNER_LENGTH);
    return [...this.sessions.values()]
      .filter((session) => session.rendererId === renderer && session.ownerId === owner)
      .map(publicSession);
  }

  assertCapacity(rendererId, ownerId) {
    const rendererSessions = [...this.sessions.values()].filter((session) => session.rendererId === rendererId);
    if (rendererSessions.length >= MAX_TERMINALS_PER_RENDERER) throw terminalError("terminal_renderer_limit");
    if (rendererSessions.filter((session) => session.ownerId === ownerId).length >= MAX_TERMINALS_PER_OWNER) {
      throw terminalError("terminal_owner_limit");
    }
  }

  nextSessionId() {
    const sessionId = textField(this.createId(), "terminal_session_invalid", 128);
    if (this.sessions.has(sessionId)) throw terminalError("terminal_session_collision");
    return sessionId;
  }

  create(input = {}) {
    return this.createManual(input);
  }

  createManual({ rendererId, ownerId, title = "Terminal", cwd } = {}) {
    const renderer = rendererField(rendererId);
    const owner = textField(ownerId, "terminal_owner_invalid", MAX_OWNER_LENGTH);
    const displayTitle = textField(title, "terminal_title_invalid", MAX_TITLE_LENGTH);
    const workingDirectory = cwdField(cwd, this.defaultCwd);
    this.assertCapacity(renderer, owner);
    const sessionId = this.nextSessionId();
    const shell = defaultShellSpec(this.platform, this.environment);
    const child = this.spawnImpl(shell.executable, shell.args, {
      cwd: workingDirectory,
      env: sanitizeTerminalEnvironment(this.environment),
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const now = this.clock();
    const session = {
      id: sessionId,
      rendererId: renderer,
      ownerId: owner,
      kind: "manual",
      title: displayTitle,
      cwd: workingDirectory,
      status: "running",
      output: [],
      outputChars: 0,
      exitCode: null,
      signal: null,
      createdAt: now,
      updatedAt: now,
      child,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      terminated: false,
      closePromise: null,
      stopPromise: null,
      stopReason: null,
    };
    this.sessions.set(session.id, session);

    const publish = (stream, text) => {
      if (!this.sessions.has(session.id) || !text) return;
      session.updatedAt = this.clock();
      appendOutput(session, stream, text);
      this.emit({ rendererId: renderer, type: "output", sessionId: session.id, stream, text, updatedAt: session.updatedAt });
    };
    child.stdout?.on("data", (value) => publish("stdout", typeof value === "string" ? value : session.stdoutDecoder.write(value)));
    child.stderr?.on("data", (value) => publish("stderr", typeof value === "string" ? value : session.stderrDecoder.write(value)));
    child.on("error", (error) => {
      if (!this.sessions.has(session.id)) return;
      session.status = "failed";
      session.updatedAt = this.clock();
      appendOutput(session, "stderr", `${error instanceof Error ? error.message : String(error)}\n`);
      this.emit({ rendererId: renderer, type: "failed", session: publicSession(session) });
    });
    child.on("exit", (code, signal) => {
      if (!this.sessions.has(session.id)) return;
      session.status = session.status === "failed" ? "failed" : "exited";
      session.exitCode = Number.isInteger(code) ? code : null;
      session.signal = typeof signal === "string" ? signal : null;
      session.updatedAt = this.clock();
      this.emit({ rendererId: renderer, type: "exited", session: publicSession(session) });
    });
    child.on("close", () => {
      if (session.terminated) return;
      publish("stdout", session.stdoutDecoder.end());
      publish("stderr", session.stderrDecoder.end());
      session.terminated = true;
    });

    const snapshot = publicSession(session);
    this.emit({ rendererId: renderer, type: "created", session: snapshot });
    return snapshot;
  }

  async runAgentCommand({
    rendererId,
    ownerId,
    actorId = "main",
    toolCallId,
    command,
    cwd,
    timeoutMs,
    abortSignal,
    sensitiveValues = [],
  } = {}) {
    if (abortSignal?.aborted) throw abortError();
    const renderer = rendererField(rendererId, true);
    const owner = textField(ownerId, "terminal_owner_invalid", MAX_OWNER_LENGTH);
    const actor = textField(actorId, "terminal_actor_invalid", MAX_OWNER_LENGTH);
    const callId = textField(toolCallId, "terminal_tool_call_invalid", MAX_OWNER_LENGTH);
    const exactCommand = commandField(command);
    const workingDirectory = cwdField(cwd, this.defaultCwd);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw terminalError("terminal_timeout_invalid");
    }
    this.assertCapacity(renderer, owner);
    const sessionId = this.nextSessionId();
    let child;
    try {
      child = this.spawnImpl(exactCommand, {
        cwd: workingDirectory,
        env: sanitizeAgentEnvironment(this.environment),
        shell: true,
        detached: this.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`Command failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }

    const now = this.clock();
    const session = {
      id: sessionId,
      rendererId: renderer,
      ownerId: owner,
      kind: "agent",
      actorId: actor,
      toolCallId: callId,
      title: `Kyrei · ${actor}`.slice(0, MAX_TITLE_LENGTH),
      cwd: workingDirectory,
      status: "running",
      output: [],
      outputChars: 0,
      streamState: {
        stdout: { pending: "", overflowed: false },
        stderr: { pending: "", overflowed: false },
      },
      resultRaw: "",
      resultTruncated: false,
      liveOutputChars: 0,
      sensitiveValues: Array.isArray(sensitiveValues)
        ? sensitiveValues.filter((value) => typeof value === "string" && value.length > 0)
        : [],
      exitCode: null,
      signal: null,
      createdAt: now,
      updatedAt: now,
      child,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      terminated: false,
      closePromise: null,
      stopPromise: null,
      stopReason: null,
      startError: null,
      runnerSettled: false,
      acceptingOutput: true,
      finishAgent: null,
    };
    this.sessions.set(session.id, session);

    const result = new Promise((resolvePromise, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
      };
      const publish = (stream, text) => {
        if (!text || session.liveOutputChars >= MAX_OUTPUT_CHARS) return;
        const remaining = MAX_OUTPUT_CHARS - session.liveOutputChars;
        const bounded = text.slice(0, remaining);
        if (!bounded) return;
        session.liveOutputChars += bounded.length;
        session.updatedAt = this.clock();
        appendOutput(session, stream, bounded);
        this.emit({
          rendererId: renderer,
          type: "output",
          sessionId: session.id,
          stream,
          text: bounded,
          updatedAt: session.updatedAt,
        });
      };
      const collectResult = (text) => {
        if (!text) return;
        const remaining = MAX_OUTPUT_CHARS - session.resultRaw.length;
        if (remaining <= 0) {
          session.resultTruncated = true;
          return;
        }
        session.resultRaw += text.slice(0, remaining);
        if (text.length > remaining) session.resultTruncated = true;
      };
      const completeLineBoundary = (pending) => {
        let boundary = pending.lastIndexOf("\n") + 1;
        if (boundary <= 0) return 0;
        const beforeBoundary = pending.slice(0, boundary);
        let cursor = 0;
        let unmatchedBegin = -1;
        while (cursor < beforeBoundary.length) {
          const beginMatch = PRIVATE_KEY_BEGIN.exec(beforeBoundary.slice(cursor));
          if (!beginMatch || beginMatch.index == null) break;
          const beginAt = cursor + beginMatch.index;
          const afterBeginAt = beginAt + beginMatch[0].length;
          const endMatch = PRIVATE_KEY_END.exec(beforeBoundary.slice(afterBeginAt));
          if (!endMatch || endMatch.index == null) {
            unmatchedBegin = beginAt;
            break;
          }
          cursor = afterBeginAt + endMatch.index + endMatch[0].length;
        }
        if (unmatchedBegin < 0) return boundary;
        // Hold the complete line containing BEGIN as well, so no fragment of
        // an unfinished private-key block can reach the renderer.
        boundary = beforeBoundary.lastIndexOf("\n", Math.max(0, unmatchedBegin - 1)) + 1;
        return boundary;
      };
      const drainStream = (stream, final = false) => {
        const state = session.streamState[stream];
        if (state.overflowed) {
          if (final) publish(stream, TRUNCATION_MARKER);
          return;
        }
        if (session.sensitiveValues.some((secret) => secret.includes("\n") || secret.includes("\r")) && !final) {
          return;
        }
        const boundary = final ? state.pending.length : completeLineBoundary(state.pending);
        if (boundary <= 0) return;
        const ready = state.pending.slice(0, boundary);
        state.pending = state.pending.slice(boundary);
        publish(stream, redactBounded(ready, session.sensitiveValues));
      };
      const receive = (stream, value) => {
        if (!session.acceptingOutput) return;
        const text = typeof value === "string" ? value : String(value ?? "");
        if (!text) return;
        collectResult(text);
        const state = session.streamState[stream];
        if (state.overflowed) return;
        state.pending += text;
        drainStream(stream);
        if (state.pending.length > MAX_OUTPUT_CHARS) {
          // An unterminated line or private-key block cannot be streamed
          // safely. Drop it and every later byte from this stream.
          state.pending = "";
          state.overflowed = true;
        }
      };
      const flushStreams = () => {
        drainStream("stdout", true);
        drainStream("stderr", true);
        const cleanResult = redactBounded(session.resultRaw, session.sensitiveValues, {
          truncated: session.resultTruncated,
        });
        session.resultRaw = "";
        session.sensitiveValues = [];
        return cleanResult;
      };
      const finish = (forcedError) => {
        if (session.runnerSettled) return;
        session.runnerSettled = true;
        cleanup();
        receive("stdout", session.stdoutDecoder.end());
        receive("stderr", session.stderrDecoder.end());
        session.acceptingOutput = false;
        const clean = flushStreams();
        session.updatedAt = this.clock();

        let failure = forcedError;
        if (!failure && (session.stopReason === "abort" || session.stopReason === "close")) failure = abortError();
        if (!failure && session.stopReason === "timeout") failure = new Error("Command timed out");
        if (!failure && session.startError) {
          failure = new Error(`Command failed to start: ${session.startError.message ?? String(session.startError)}`);
        }
        if (!failure && session.exitCode !== 0) {
          failure = new Error(`Command exited with code ${session.exitCode}\n${boundedText(clean, 2_000)}`);
        }
        session.status = session.startError || session.stopReason || forcedError ? "failed" : "exited";
        this.emit({
          rendererId: renderer,
          type: session.status === "failed" ? "failed" : "exited",
          session: publicSession(session),
        });
        if (failure) reject(failure);
        else resolvePromise(`(exit code: ${session.exitCode})\n${clean}`.trim());
      };
      session.finishAgent = finish;

      const requestStop = (reason) => {
        if (!session.stopReason) session.stopReason = reason;
        void this.stopProcess(session).catch((error) => finish(error));
      };
      const onAbort = () => requestStop("abort");
      const timer = setTimeout(() => requestStop("timeout"), timeoutMs);
      timer.unref?.();
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (value) => receive(
        "stdout",
        typeof value === "string" ? value : session.stdoutDecoder.write(value),
      ));
      child.stderr?.on("data", (value) => receive(
        "stderr",
        typeof value === "string" ? value : session.stderrDecoder.write(value),
      ));
      child.on("error", (error) => {
        session.startError = error instanceof Error ? error : new Error(String(error));
      });
      child.on("exit", (code, signal) => {
        session.exitCode = Number.isInteger(code) ? code : null;
        session.signal = typeof signal === "string" ? signal : null;
      });
      child.on("close", (code, signal) => {
        if (session.exitCode == null && Number.isInteger(code)) session.exitCode = code;
        if (session.signal == null && typeof signal === "string") session.signal = signal;
        session.terminated = true;
        finish();
      });
      if (abortSignal?.aborted) requestStop("abort");
    });

    this.emit({ rendererId: renderer, type: "created", session: publicSession(session) });
    return result;
  }

  write(rendererId, sessionId, value) {
    const session = this.ownedSession(rendererId, sessionId);
    if (session.kind !== "manual") throw terminalError("terminal_read_only");
    if (session.closePromise) throw terminalError("terminal_closing");
    if (session.status !== "running" || !session.child.stdin?.writable) throw terminalError("terminal_not_running");
    if (typeof value !== "string" || !value || value.length > MAX_WRITE_LENGTH || value.includes("\0")) {
      throw terminalError("terminal_input_invalid");
    }
    session.child.stdin.write(value);
    return true;
  }

  rename(rendererId, sessionId, value) {
    const session = this.ownedSession(rendererId, sessionId);
    if (session.closePromise) throw terminalError("terminal_closing");
    session.title = textField(value, "terminal_title_invalid", MAX_TITLE_LENGTH);
    session.updatedAt = this.clock();
    const snapshot = publicSession(session);
    this.emit({ rendererId, type: "renamed", session: snapshot });
    return snapshot;
  }

  close(rendererId, sessionId) {
    const session = this.ownedSession(rendererId, sessionId);
    if (session.closePromise) return session.closePromise;
    if (!session.stopReason) session.stopReason = "close";
    session.closePromise = (async () => {
      await this.stopProcess(session);
      this.sessions.delete(session.id);
      this.emit({ rendererId, type: "closed", sessionId: session.id, ownerId: session.ownerId });
      return true;
    })().catch((error) => {
      session.closePromise = null;
      throw error;
    });
    return session.closePromise;
  }

  async closeRenderer(rendererId) {
    const owned = [...this.sessions.values()].filter((session) => session.rendererId === rendererId);
    await Promise.all(owned.map((session) => this.close(rendererId, session.id)));
  }

  async closeAll() {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.close(session.rendererId, session.id)));
  }

  ownedSession(rendererId, sessionId) {
    rendererField(rendererId, true);
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
      throw terminalError("terminal_session_invalid");
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.rendererId !== rendererId) throw terminalError("terminal_session_not_found");
    return session;
  }

  stopProcess(session) {
    if (session.stopPromise) return session.stopPromise;
    session.child.stdin?.end?.();
    if (session.terminated) return Promise.resolve(true);
    const stopping = new Promise((resolvePromise, reject) => {
      let forceTimer;
      let failTimer;
      const finish = () => {
        clearTimeout(forceTimer);
        clearTimeout(failTimer);
        session.child.removeListener("close", finish);
        resolvePromise(true);
      };
      session.child.once("close", finish);
      void Promise.resolve(this.terminateImpl(session, false, this.platform)).catch(() => {});
      forceTimer = setTimeout(() => {
        void Promise.resolve(this.terminateImpl(session, true, this.platform)).catch(() => {});
      }, 750);
      failTimer = setTimeout(() => {
        session.child.removeListener("close", finish);
        reject(terminalError("terminal_close_timeout"));
      }, 2_000);
      forceTimer.unref?.();
      failTimer.unref?.();
    });
    session.stopPromise = stopping.catch((error) => {
      session.stopPromise = null;
      throw error;
    });
    return session.stopPromise;
  }
}

export { MAX_OUTPUT_CHARS, MAX_TERMINALS_PER_OWNER, MAX_TERMINALS_PER_RENDERER };
