import { describe, it, expect } from "vitest";
import { createHttpEmbedAdapter } from "./http-embed.js";
import { configureEmbedAdapterFromConfig, createLexicalEmbedAdapter, embedText, setEmbedAdapter } from "./embed-adapter.js";

describe("http embed adapter", () => {
  it("posts to OpenAI-compatible embeddings endpoint", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createHttpEmbedAdapter({
      baseURL: "http://127.0.0.1:9999/v1",
      model: "nomic-embed",
      apiKey: "k",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          text: async () => "",
        } as Response;
      },
    });
    const v = await adapter.embed("hello world");
    expect(v.length).toBe(3);
    expect(v[0]).toBeCloseTo(0.1, 5);
    expect(v[1]).toBeCloseTo(0.2, 5);
    expect(v[2]).toBeCloseTo(0.3, 5);
    expect(calls[0]?.url).toContain("/embeddings");
    expect(calls[0]?.body).toMatchObject({ model: "nomic-embed", input: "hello world" });
  });

  it("configureEmbedAdapterFromConfig falls back to lexical when http incomplete", async () => {
    setEmbedAdapter(createLexicalEmbedAdapter());
    configureEmbedAdapterFromConfig({ mode: "http" });
    const v = await embedText("abc");
    expect(v.length).toBeGreaterThan(0);
  });
});
