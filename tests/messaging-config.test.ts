import { describe, it, expect } from "vitest";
import {
  normalizeMessagingConfig,
  publicMessagingStatus,
  generateMessagingToken,
} from "../core/messaging-config.js";

describe("messaging-config", () => {
  it("defaults to disabled webhook", () => {
    expect(normalizeMessagingConfig(undefined)).toEqual({
      enabled: false,
      autoRun: false,
      maxBodyChars: 8_000,
    });
  });

  it("clamps maxBodyChars", () => {
    expect(normalizeMessagingConfig({ enabled: true, maxBodyChars: 50 }).maxBodyChars).toBe(1_000);
    expect(normalizeMessagingConfig({ enabled: true, maxBodyChars: 99_999 }).maxBodyChars).toBe(20_000);
  });

  it("never exposes token in public status", () => {
    const status = publicMessagingStatus(
      { enabled: true, autoRun: true },
      { messaging: { webhookToken: "super-secret-token-value-16" } },
      [{ id: "1", at: "t", sessionId: "s", preview: "hello world", autoRun: false, status: "accepted" }],
    );
    expect(status.hasToken).toBe(true);
    expect(JSON.stringify(status)).not.toContain("super-secret");
    expect(status.recent[0]?.preview).toBe("hello world");
  });

  it("generates long random tokens", () => {
    const a = generateMessagingToken();
    const b = generateMessagingToken();
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
    expect(a).not.toBe(b);
  });
});
