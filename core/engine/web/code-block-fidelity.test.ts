import { describe, expect, it } from "vitest";
import { extractWebPage } from "./browser.js";

/**
 * A coding agent reads documentation to copy commands out of it. Collapsing
 * whitespace in `<pre>`/`<code>` turned every multi-line block into one line,
 * so the agent saw `npm install foo cd foo npm run build` and had no way to
 * know where one command ended and the next began.
 */
const page = (body: string) => `<!doctype html><html><head><title>Docs</title></head><body><main>${body}</main></body></html>`;

describe("fetched code blocks keep their line structure", () => {
  it("preserves newlines inside a <pre> block", () => {
    const extracted = extractWebPage(
      "https://example.test/docs",
      page("<h1>Setup</h1><pre><code>npm install foo\ncd foo\nnpm run build</code></pre>"),
    );

    expect(extracted.text).toContain("npm install foo\ncd foo\nnpm run build");
    // The collapsed form is exactly what used to reach the model.
    expect(extracted.text).not.toContain("npm install foo cd foo");
  });

  it("emits a real fenced block rather than one run-on line", () => {
    const extracted = extractWebPage(
      "https://example.test/docs",
      page("<p>Run:</p><pre>line one\nline two\nline three</pre>"),
    );

    const fenced = extracted.text.split("```")[1] ?? "";
    expect(fenced.split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(3);
  });

  it("still treats a single-line <code> as inline, not as a block", () => {
    // The block/inline decision reads the same text; it must not start
    // fencing every inline mention now that newlines survive.
    const extracted = extractWebPage(
      "https://example.test/docs",
      page("<p>Call <code>npm ci</code> first.</p>"),
    );

    expect(extracted.text).toContain("`npm ci`");
    expect(extracted.text).not.toContain("```");
  });

  it("does not start splitting quotes on incidental source newlines", () => {
    // Whitespace significance is a property of `<pre>`, not of markup in
    // general: a newline inside a blockquote is just a space, so preserving it
    // would turn one sentence into two quote lines.
    const extracted = extractWebPage(
      "https://example.test/docs",
      page("<blockquote>first line\nsecond line</blockquote>"),
    );

    expect(extracted.text).toContain("> first line second line");
  });

  it("collapses ordinary prose whitespace as before", () => {
    // The fix must be scoped to code/quote nodes; prose with incidental
    // newlines should still read as one paragraph.
    const extracted = extractWebPage(
      "https://example.test/docs",
      page("<p>some prose\n   wrapped   across\nlines</p>"),
    );

    expect(extracted.text).toContain("some prose wrapped across lines");
  });
});
