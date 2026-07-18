import { describe, expect, it } from "vitest";

import { FOLLOW_OUTPUT_EPSILON_PX, isNearBottom } from "./scroll-follow";

describe("scroll follow", () => {
  it("stays attached when the viewport is already at the bottom", () => {
    expect(isNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1_000 })).toBe(true);
  });

  it("allows a small gap without breaking follow mode", () => {
    expect(isNearBottom({
      scrollTop: 552,
      clientHeight: 400,
      scrollHeight: 1_000,
    }, FOLLOW_OUTPUT_EPSILON_PX)).toBe(true);
  });

  it("drops follow mode once the user scrolls materially away from the bottom", () => {
    expect(isNearBottom({
      scrollTop: 400,
      clientHeight: 400,
      scrollHeight: 1_000,
    }, FOLLOW_OUTPUT_EPSILON_PX)).toBe(false);
  });
});
