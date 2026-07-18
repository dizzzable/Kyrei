import { describe, expect, it } from "vitest";

import {
  isNearConversationBottom,
  shouldPauseFollowingForKey,
  shouldPauseFollowingForTouch,
  shouldPauseFollowingForWheel,
} from "@/components/conversation/useConversationScroll";

describe("conversation scroll helpers", () => {
  it("treats a small remaining gap as still following output", () => {
    expect(isNearConversationBottom({
      scrollTop: 876,
      clientHeight: 400,
      scrollHeight: 1_300,
    })).toBe(true);

    expect(isNearConversationBottom({
      scrollTop: 820,
      clientHeight: 400,
      scrollHeight: 1_300,
    })).toBe(false);
  });

  it("pauses following only for explicit upward navigation intents", () => {
    expect(shouldPauseFollowingForWheel(-3)).toBe(true);
    expect(shouldPauseFollowingForWheel(12)).toBe(false);

    expect(shouldPauseFollowingForKey("PageUp")).toBe(true);
    expect(shouldPauseFollowingForKey("ArrowUp")).toBe(true);
    expect(shouldPauseFollowingForKey("End")).toBe(false);

    expect(shouldPauseFollowingForTouch(120, 132)).toBe(true);
    expect(shouldPauseFollowingForTouch(120, 124)).toBe(false);
    expect(shouldPauseFollowingForTouch(null, 132)).toBe(false);
  });
});
