import { describe, expect, it } from "vitest";

import { extractToolErrorMessage, formatToolResultSummary } from "@/lib/tool-result-summary";

describe("formatToolResultSummary", () => {
  it("passes a plain string through", () => {
    expect(formatToolResultSummary("hello world")).toBe("hello world");
  });

  it("parses a JSON string before summarizing", () => {
    expect(formatToolResultSummary('{"message":"done"}')).toBe("done");
  });

  it("renders an array of objects as a bulleted list", () => {
    const value = [
      { title: "First", status: "open" },
      { title: "Second", status: "closed" },
    ];

    expect(formatToolResultSummary(value)).toBe("- First (open)\n- Second (closed)");
  });

  it("caps long arrays with a '… N more items' line", () => {
    const value = Array.from({ length: 9 }, (_, i) => ({ name: `item-${i}` }));

    const summary = formatToolResultSummary(value);
    const lines = summary.split("\n");

    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("- item-0");
    expect(lines[6]).toBe("- … 3 more items");
  });

  it("unwraps common payload wrappers", () => {
    expect(formatToolResultSummary({ data: { message: "wrapped" } })).toBe("wrapped");
  });

  it("returns an empty string for an empty object", () => {
    expect(formatToolResultSummary({})).toBe("");
  });

  it("skips success:true and renders remaining fields", () => {
    expect(formatToolResultSummary({ success: true, count: 5 })).toBe("- Count: 5");
  });
});

describe("extractToolErrorMessage", () => {
  it("extracts a string error field", () => {
    expect(extractToolErrorMessage({ error: "boom" })).toBe("boom");
  });

  it("extracts a nested error message", () => {
    const value = { result: { data: { error: { message: "nested failure" } } } };

    expect(extractToolErrorMessage(value)).toBe("nested failure");
  });

  it("derives an error message from success:false", () => {
    expect(extractToolErrorMessage({ success: false, message: "it failed" })).toBe("it failed");
  });

  it("returns an empty string when there is no error signal", () => {
    expect(extractToolErrorMessage({ success: true, value: 42 })).toBe("");
  });
});
