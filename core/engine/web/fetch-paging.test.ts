import { describe, expect, it } from "vitest";
import { createWebBrowser, formatWebPage } from "./browser.js";

/**
 * ~6 000 chars that never repeat, so two adjacent windows are distinguishable.
 * A repeating filler would make chunk N and chunk N+1 byte-identical and hide a
 * paging bug rather than expose it.
 */
const LONG = Array.from({ length: 600 }, (_, i) => `seg${String(i).padStart(5, "0")}x`).join("");

function browserServing(body: string, contentType = "text/html") {
  return createWebBrowser({
    fetch: (async () => new Response(body, { headers: { "content-type": contentType } })) as typeof fetch,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
}

const page = (text: string) => `<!doctype html><html><head><title>Doc</title></head><body><main><p>${text}</p></main></body></html>`;

describe("web_fetch paging", () => {
  it("reports the window it returned when a page does not fit", async () => {
    // Regression: the page was sliced silently, so the model could not tell a
    // long reference page from one that simply ended, and had no way to ask for
    // the rest — read_skill has offered exactly this since it shipped.
    const browser = browserServing(page(LONG));

    const first = await browser.fetch("https://example.test/doc", 1_000);

    expect(first.text.length).toBe(1_000);
    expect(first.truncated).toMatchObject({ offset: 0, returned: 1_000 });
    expect(first.truncated!.total).toBeGreaterThan(1_000);
  });

  it("resumes from an offset", async () => {
    const browser = browserServing(page(LONG));

    const first = await browser.fetch("https://example.test/doc", 1_000);
    const next = await browser.fetch("https://example.test/doc", 1_000, first.truncated!.returned);

    expect(next.truncated).toMatchObject({ offset: 1_000 });
    expect(next.text).not.toBe(first.text);
    // The two windows are adjacent, not overlapping.
    const whole = await browser.fetch("https://example.test/doc", 60_000);
    expect(whole.text.startsWith(first.text + next.text)).toBe(true);
  });

  it("marks nothing when the page fits", async () => {
    const browser = browserServing(page("short enough"));
    const only = await browser.fetch("https://example.test/doc", 10_000);
    expect(only.truncated).toBeUndefined();
  });

  it("clamps an offset past the end instead of failing", async () => {
    const browser = browserServing(page("tiny"));
    const beyond = await browser.fetch("https://example.test/doc", 1_000, 999_999);
    expect(beyond.text).toBe("");
    expect(beyond.truncated?.offset).toBeLessThanOrEqual(beyond.truncated!.total);
  });

  it("tells the model the exact offset to use next", async () => {
    const rendered = formatWebPage({
      url: "https://example.test/doc",
      title: "Doc",
      text: "chunk",
      links: [],
      truncated: { offset: 0, returned: 1_000, total: 6_000 },
    });

    expect(rendered).toContain("showing characters 1-1000 of 6000");
    expect(rendered).toContain("offset 1000");
  });

  it("does not invite another call once the tail is reached", async () => {
    const rendered = formatWebPage({
      url: "https://example.test/doc",
      title: "Doc",
      text: "tail",
      links: [],
      truncated: { offset: 5_000, returned: 1_000, total: 6_000 },
    });

    expect(rendered).toContain("showing characters 5001-6000 of 6000");
    expect(rendered).not.toContain("call web_fetch again");
  });
});

describe("web_fetch paging on NON-HTML bodies", () => {
  // The original six tests all used text/html, so the non-HTML branch shipped
  // with zero coverage — and it was the broken one: it densified only as far as
  // the window needed, which made `total` the WINDOW size, not the document
  // size. The first page then reported no truncation at all (its length equalled
  // the cap exactly) and later pages announced the document had ended.
  const PLAIN = Array.from({ length: 540 }, (_, i) => `seg${String(i).padStart(5, "0")}x`).join("");
  const PLAIN_LEN = PLAIN.length; // 4 860 — asserted exactly so a wrong total cannot hide

  it("reports the real document size on the first page of a text/plain body", async () => {
    const browser = browserServing(PLAIN, "text/plain");

    const first = await browser.fetch("https://example.test/doc", 1_000);

    expect(first.text.length).toBe(1_000);
    expect(first.truncated).toBeDefined();
    expect(first.truncated!.total).toBe(PLAIN_LEN);
  });

  it("does not declare a text/plain document finished halfway through", async () => {
    const browser = browserServing(PLAIN, "text/plain");

    const second = await browser.fetch("https://example.test/doc", 1_000, 1_000);

    expect(second.truncated!.offset).toBe(1_000);
    // The killer symptom: total used to come out as offset+cap, so the model
    // was told it had reached the end at char 2000 of a 5400-char document.
    expect(second.truncated!.total).toBe(PLAIN_LEN);
    expect(formatWebPage(second)).toContain("call web_fetch again");
  });

  it("reports the real size for application/json too", async () => {
    const json = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item-${i}` })) });
    const browser = browserServing(json, "application/json");

    const first = await browser.fetch("https://example.test/api", 1_000);

    expect(first.truncated!.total).toBeGreaterThan(5_000);
  });

  it("pages a text/plain body to completion", async () => {
    const browser = browserServing(PLAIN, "text/plain");
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await browser.fetch("https://example.test/doc", 1_000, offset);
      assembled += page.text;
      if (!page.truncated || page.truncated.offset + page.truncated.returned >= page.truncated.total) break;
      offset = page.truncated.offset + page.truncated.returned;
    }
    const whole = await browser.fetch("https://example.test/doc", 60_000);
    expect(assembled).toBe(whole.text);
  });

  it("says the offset overshot instead of claiming the page is unreadable", async () => {
    const browser = browserServing("tiny body", "text/plain");
    const beyond = await browser.fetch("https://example.test/doc", 1_000, 999_999);

    const rendered = formatWebPage(beyond);
    expect(rendered).toContain("past the end");
    expect(rendered).not.toContain("No readable text was found");
  });
});
