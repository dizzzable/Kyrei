import { describe, expect, it } from "vitest";

import {
  firstVisibleNodeIndex,
  isNearConversationBottom,
  snapshotNeedsAnchor,
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

describe("snapshotNeedsAnchor", () => {
  it("measures an anchor only when following is paused", () => {
    // The whole perf argument in one assertion: the streaming path is
    // "following", and an anchor recorded there is never read back — the
    // restore path scrolls to the bottom instead.
    expect(snapshotNeedsAnchor("paused")).toBe(true);
    expect(snapshotNeedsAnchor("following")).toBe(false);
  });
});

describe("firstVisibleNodeIndex", () => {
  const linear = (bottoms: number[], containerTop: number) => {
    // The previous implementation, kept here as the oracle.
    const index = bottoms.findIndex((bottom) => bottom > containerTop + 1);
    return bottoms.length === 0 ? -1 : index === -1 ? bottoms.length - 1 : index;
  };

  it("returns -1 for an empty transcript", () => {
    expect(firstVisibleNodeIndex(0, () => 0, 100)).toBe(-1);
  });

  it("falls back to the last node when every message is above the fold", () => {
    const bottoms = [10, 20, 30];
    expect(firstVisibleNodeIndex(bottoms.length, (i) => bottoms[i]!, 100)).toBe(2);
  });

  it("returns the first node when the transcript starts below the fold", () => {
    const bottoms = [500, 600, 700];
    expect(firstVisibleNodeIndex(bottoms.length, (i) => bottoms[i]!, 100)).toBe(0);
  });

  it("uses a strict `> containerTop + 1` boundary", () => {
    // Exactly one pixel of overlap does not count as visible; two do.
    expect(firstVisibleNodeIndex(2, (i) => [101, 500][i]!, 100)).toBe(1);
    expect(firstVisibleNodeIndex(2, (i) => [102, 500][i]!, 100)).toBe(0);
  });

  it("handles zero-height messages, which produce equal bottoms", () => {
    const bottoms = [50, 50, 50, 150, 150];
    expect(firstVisibleNodeIndex(bottoms.length, (i) => bottoms[i]!, 100)).toBe(3);
  });

  it("agrees with the linear scan it replaced on random monotone transcripts", () => {
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 300; trial += 1) {
      const count = Math.floor(next() * 40);
      const bottoms: number[] = [];
      let running = -200;
      for (let i = 0; i < count; i += 1) {
        running += Math.floor(next() * 60); // may be 0 → equal bottoms
        bottoms.push(running);
      }
      const containerTop = Math.floor(next() * 800) - 200;
      expect(firstVisibleNodeIndex(count, (i) => bottoms[i]!, containerTop))
        .toBe(linear(bottoms, containerTop));
    }
  });

  it("measures a logarithmic number of nodes, not a linear one", () => {
    // This is the perf claim itself. A 500-message transcript pinned at the
    // bottom used to call getBoundingClientRect ~500 times per streamed token.
    const count = 500;
    let reads = 0;
    firstVisibleNodeIndex(count, (i) => { reads += 1; return i * 10; }, 4_900);
    expect(reads).toBeLessThanOrEqual(10);
  });
});
