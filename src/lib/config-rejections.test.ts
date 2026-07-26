import { describe, expect, it } from "vitest";
import {
  MAX_REJECTION_TEXT,
  MAX_RENDERED_REJECTIONS,
  sanitizeConfigRejections,
} from "./config-rejections";

describe("sanitizeConfigRejections", () => {
  it("returns nothing for a gateway that does not report rejections", () => {
    // An older gateway omits the field; one that could not load the engine
    // bundle sends an empty array. Both must render the settings dialog.
    expect(sanitizeConfigRejections(undefined)).toEqual([]);
    expect(sanitizeConfigRejections(null)).toEqual([]);
    expect(sanitizeConfigRejections([])).toEqual([]);
    expect(sanitizeConfigRejections({ path: "x", message: "y" })).toEqual([]);
  });

  it("keeps well-formed entries and trims them", () => {
    expect(sanitizeConfigRejections([
      { path: " memory.index.connectionString ", message: "  too small — using default  " },
    ])).toEqual([
      { path: "memory.index.connectionString", message: "too small — using default" },
    ]);
  });

  it("keeps a whole-config issue whose path is empty", () => {
    expect(sanitizeConfigRejections([{ path: "", message: "expected an object" }]))
      .toEqual([{ path: "", message: "expected an object" }]);
  });

  it("drops entries that would render as a blank row", () => {
    expect(sanitizeConfigRejections([
      { path: "a", message: "   " },
      { path: "b" },
      { message: "orphan" },
      { path: 7, message: "wrong type" },
      "not an object",
      null,
      { path: "ok", message: "kept" },
    ])).toEqual([{ path: "ok", message: "kept" }]);
  });

  it("de-duplicates identical rows", () => {
    const dupe = { path: "delegation.maxParallel", message: "clamped" };
    expect(sanitizeConfigRejections([dupe, { ...dupe }, dupe])).toHaveLength(1);
  });

  it("bounds the list and the text so one bad config cannot flood the dialog", () => {
    const many = Array.from({ length: MAX_RENDERED_REJECTIONS + 25 }, (_, i) => ({
      path: `mcp.servers.${i}.id`,
      message: "invalid",
    }));
    expect(sanitizeConfigRejections(many)).toHaveLength(MAX_RENDERED_REJECTIONS);

    const [long] = sanitizeConfigRejections([{ path: "p".repeat(900), message: "m".repeat(900) }]);
    expect(long!.path).toHaveLength(MAX_REJECTION_TEXT);
    expect(long!.message).toHaveLength(MAX_REJECTION_TEXT);
    expect(long!.message.endsWith("…")).toBe(true);
  });
});
