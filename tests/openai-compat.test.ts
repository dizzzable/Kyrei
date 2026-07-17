import { describe, expect, it } from "vitest";
import {
  formatChatCompletionResponse,
  formatChatCompletionSseFrames,
  listCompatModels,
  normalizeProxyConfig,
  openAiMessagesToModelMessages,
  parseChatCompletionRequest,
  resolveCompatModelRef,
} from "../core/openai-compat.js";

describe("openai-compat helpers", () => {
  it("normalizes proxy config with LAN implying requireAccessToken", () => {
    expect(normalizeProxyConfig({})).toEqual({
      enabled: true,
      listenLan: false,
      requireAccessToken: false,
    });
    expect(normalizeProxyConfig({ listenLan: true })).toMatchObject({
      listenLan: true,
      requireAccessToken: true,
    });
  });

  it("lists compound model ids and bare active model", () => {
    const listed = listCompatModels({
      activeProviderId: "openai",
      activeModelId: "gpt-4o-mini",
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          enabled: true,
          models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
        },
        {
          id: "anthropic",
          enabled: true,
          models: [{ id: "claude-sonnet" }],
        },
      ],
    });
    const ids = listed.data.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o-mini");
    expect(ids).toContain("gpt-4o-mini");
    expect(ids).toContain("anthropic/claude-sonnet");
  });

  it("resolves model refs", () => {
    const config = {
      activeProviderId: "openai",
      activeModelId: "gpt-4o-mini",
      providers: [
        { id: "openai", enabled: true, models: [{ id: "gpt-4o-mini" }] },
        { id: "anthropic", enabled: true, models: [{ id: "claude" }] },
      ],
    };
    expect(resolveCompatModelRef("anthropic/claude", config)).toEqual({
      providerId: "anthropic",
      modelId: "claude",
    });
    expect(resolveCompatModelRef("claude", config)).toEqual({
      providerId: "anthropic",
      modelId: "claude",
    });
  });

  it("converts OpenAI messages to model messages", () => {
    const msgs = openAiMessagesToModelMessages([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: "Hello" },
    ]);
    expect(msgs).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("parses and formats chat completion payloads", () => {
    expect(parseChatCompletionRequest({ messages: [] }).ok).toBe(false);
    const parsed = parseChatCompletionRequest({
      model: "openai/gpt",
      messages: [{ role: "user", content: "x" }],
      stream: true,
    });
    expect(parsed).toMatchObject({ ok: true, stream: true, model: "openai/gpt" });

    const body = formatChatCompletionResponse({
      id: "chatcmpl_test",
      model: "openai/gpt",
      text: "ok",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    expect(body.choices[0].message.content).toBe("ok");
    expect(body.usage.total_tokens).toBe(5);

    const frames = formatChatCompletionSseFrames({
      id: "chatcmpl_test",
      model: "m",
      text: "hi",
    });
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
    expect(frames.some((f) => f.includes("\"content\":\"hi\""))).toBe(true);
  });
});
