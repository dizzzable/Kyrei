import { describe, expect, it } from "vitest";
import {
  assertPublicWebUrl,
  createWebBrowser,
  extractWebPage,
  formatWebSearchResults,
  isPrivateAddress,
  type BrowserResponse,
  type HostResolver,
} from "./browser.js";

const publicResolver: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const privateResolver: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];

function response(body: string, init: { status?: number; contentType?: string; location?: string } = {}): BrowserResponse {
  const headers = new Map<string, string>();
  headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  if (init.location) headers.set("location", init.location);
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

describe("agent web reader — SSRF boundary", () => {
  it("rejects local/private targets before fetch", async () => {
    await expect(assertPublicWebUrl("file:///etc/passwd", publicResolver)).rejects.toThrow("http or https");
    await expect(assertPublicWebUrl("http://localhost:8080", publicResolver)).rejects.toThrow("local host");
    await expect(assertPublicWebUrl("http://127.0.0.1", publicResolver)).rejects.toThrow("private network");
    await expect(assertPublicWebUrl("http://[::ffff:7f00:1]", publicResolver)).rejects.toThrow("private network");
    await expect(assertPublicWebUrl("https://example.test", privateResolver)).rejects.toThrow("private network");
  });

  it("accepts public targets and classifies reserved address ranges", async () => {
    await expect(assertPublicWebUrl("https://example.com/docs", publicResolver)).resolves.toMatchObject({ hostname: "example.com" });
    expect(isPrivateAddress("10.0.0.5")).toBe(true);
    expect(isPrivateAddress("172.24.2.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.5")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:0a00:1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("agent web reader — extraction", () => {
  it("keeps readable content and links while dropping active/navigation markup", () => {
    const page = extractWebPage(
      "https://example.com/guide",
      "<html><head><title>Guide</title><script>ignore me</script></head><body><nav>menu</nav><main><h1>Welcome</h1><p>Useful documentation.</p><a href='/next'>Continue</a></main><footer>footer</footer></body></html>",
    );
    expect(page.title).toBe("Guide");
    expect(page.text).toContain("Useful documentation.");
    expect(page.text).not.toContain("ignore me");
    expect(page.text).not.toContain("menu");
    expect(page.links).toEqual([{ title: "Continue", url: "https://example.com/next" }]);
  });

  it("parses public HTML-search results without using a live network", async () => {
    const html = "<a class='result__a' href='https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs'>Example docs</a><a class='result__snippet'>A concise reference.</a>";
    const browser = createWebBrowser({ resolveHost: publicResolver, fetch: async () => response(html) });
    const results = await browser.search("example", 3);
    expect(results).toEqual([{ title: "Example docs", url: "https://example.com/docs", snippet: "A concise reference." }]);
    expect(formatWebSearchResults(results)).toContain("untrusted reference material");
  });

  it("revalidates a redirect target before following it", async () => {
    const browser = createWebBrowser({
      resolveHost: publicResolver,
      fetch: async () => response("", { status: 302, location: "http://127.0.0.1/private" }),
    });
    await expect(browser.fetch("https://example.com/start")).rejects.toThrow("private network");
  });

  it("passes the validated address into the transport for DNS-rebinding resistance", async () => {
    let pinned: { address: string; family: 4 | 6 } | undefined;
    const browser = createWebBrowser({
      resolveHost: publicResolver,
      fetch: async (_url, _init, address) => {
        pinned = address;
        return response("<title>Safe</title>");
      },
    });
    await browser.fetch("https://example.com/pinned");
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("keeps the request deadline active while a response body is streaming", async () => {
    const browser = createWebBrowser({
      resolveHost: publicResolver,
      timeoutMs: 5,
      fetch: async (_url, init) => ({
        ...response(""),
        body: {
          getReader: () => ({
            read: () => new Promise<never>((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
          }),
        },
      }),
    });
    await expect(browser.fetch("https://example.com/slow")).rejects.toThrow("timed out");
  });
});
