import { describe, it, expect } from "vitest";

import { buildSessionExport, redactSecretsInExport } from "@/lib/session-export";
import type { ChatMessage, SessionInfo } from "@/lib/types";

const session: SessionInfo = {
  id: "sess-1",
  title: "My Session",
};

const messages: ChatMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi there" }] },
];

describe("buildSessionExport", () => {
  it("produces the expected structure", () => {
    const out = buildSessionExport(session, messages);
    expect(out).toMatchObject({
      session_id: "sess-1",
      title: "My Session",
      message_count: 2,
      messages,
    });
    expect(typeof out.exported_at).toBe("string");
    expect(Number.isNaN(Date.parse(out.exported_at))).toBe(false);
  });

  it("reports message_count matching the messages length", () => {
    expect(buildSessionExport(session, []).message_count).toBe(0);
    expect(buildSessionExport(session, messages).message_count).toBe(2);
  });

  it("keeps an untitled session locale-neutral", () => {
    expect(buildSessionExport({ id: "x" }, []).title).toBe("");
  });
});

describe("redactSecretsInExport", () => {
  it("masks sk- style API keys", () => {
    const input = { note: "key is sk-abcDEF1234567890ghijkl here" };
    const out = redactSecretsInExport(input);
    expect(out.note).toBe("key is [REDACTED] here");
  });

  it("masks Bearer tokens while keeping the prefix", () => {
    const input = { auth: "Authorization: Bearer abcDEF123456.tokEN_value" };
    const out = redactSecretsInExport(input);
    expect(out.auth).toBe("Authorization: Bearer [REDACTED]");
  });

  it("masks long hex tokens", () => {
    const input = { t: "0123456789abcdef0123456789abcdef" };
    const out = redactSecretsInExport(input);
    expect(out.t).toBe("[REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    const input = { msg: "Refactor the auth module and run tests." };
    const out = redactSecretsInExport(input);
    expect(out.msg).toBe("Refactor the auth module and run tests.");
  });

  it("recurses into nested structures without mutating the input", () => {
    const input = {
      messages: [{ parts: [{ text: "token sk-ABCDEFGH1234567890ij" }] }],
    };
    const out = redactSecretsInExport(input);
    expect(out.messages[0].parts[0].text).toBe("token [REDACTED]");
    // original untouched
    expect(input.messages[0].parts[0].text).toBe("token sk-ABCDEFGH1234567890ij");
  });
});
