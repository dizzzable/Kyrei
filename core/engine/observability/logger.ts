/**
 * Structured, redacted engine logging (Requirements §8.5, §12.5). Correlates by
 * session; never logs secret values. Emits JSON lines to an optional sink.
 */

import { redact } from "../security/secrets.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export type LogSink = (line: string) => void;

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export function createLogger(opts: { sessionId?: string; sink?: LogSink; minLevel?: LogLevel } = {}): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[opts.minLevel ?? "info"];
  const sink: LogSink = opts.sink ?? ((l) => console.error(l));

  const emit = (level: LogLevel, event: string, data?: Record<string, unknown>) => {
    if (order[level] < min) return;
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(data ? { data } : {}),
    };
    // Redact any secret values that slipped into structured data.
    sink(redact(JSON.stringify(rec)));
  };

  return {
    log: emit,
    debug: (e, d) => emit("debug", e, d),
    info: (e, d) => emit("info", e, d),
    warn: (e, d) => emit("warn", e, d),
    error: (e, d) => emit("error", e, d),
  };
}
