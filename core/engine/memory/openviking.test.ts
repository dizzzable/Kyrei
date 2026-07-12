import { describe, expect, it } from "vitest";
import { createOpenVikingClient, type OpenVikingFetch } from "./openviking.js";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("OpenViking optional HTTP adapter", () => {
  it("uses loopback by default and keeps the health probe unauthenticated", async () => {
    const calls: Array<{ url: string; init: Parameters<OpenVikingFetch>[1] }> = [];
    const fetch: OpenVikingFetch = async (url, init) => {
      calls.push({ url, init });
      return response({ status: "ok" });
    };
    const client = createOpenVikingClient({ apiKey: "key", fetch });
    await client.health();
    await client.find("architecture");
    expect(calls[0]?.url).toBe("http://127.0.0.1:1933/health");
    expect(calls[0]?.init.headers["X-API-Key"]).toBeUndefined();
    expect(calls[1]?.init.headers["X-API-Key"]).toBe("key");
  });

  it("rejects a remote server until explicitly enabled", () => {
    expect(() => createOpenVikingClient({ baseURL: "https://memory.example.com" })).toThrow("loopback");
    expect(() => createOpenVikingClient({ baseURL: "https://memory.example.com", allowRemote: true })).not.toThrow();
  });
});
