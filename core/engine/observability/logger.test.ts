import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("logger", () => {
  it("emits structured JSON with session correlation and redaction", () => {
    const lines: string[] = [];
    const log = createLogger({ sessionId: "s1", sink: (l) => lines.push(l), minLevel: "debug" });
    log.info("tool.start", { name: "run_command", token: "sk-ABCDEFGHIJKLMNOPQRSTUVWX" });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.event).toBe("tool.start");
    expect(rec.sessionId).toBe("s1");
    expect(lines[0]).toContain("[REDACTED]");
    expect(lines[0]).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
  });

  it("respects minLevel", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), minLevel: "warn" });
    log.info("x");
    log.warn("y");
    expect(lines).toHaveLength(1);
  });
});
