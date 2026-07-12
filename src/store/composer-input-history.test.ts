import { beforeEach, describe, expect, it } from "vitest";

import {
  $perSessionBrowse,
  browseBackward,
  browseForward,
  deriveUserHistory,
  isBrowsingHistory,
  resetBrowseState,
} from "@/store/composer-input-history";

interface Msg {
  role: string;
  text: string;
}

const getText = (m: Msg) => m.text;

const SID = "sess-1";

describe("deriveUserHistory", () => {
  it("returns user messages newest-first, trimmed, skipping blanks", () => {
    const messages: Msg[] = [
      { role: "user", text: "one" },
      { role: "assistant", text: "reply" },
      { role: "user", text: "  two  " },
      { role: "user", text: "   " },
      { role: "user", text: "three" },
    ];

    expect(deriveUserHistory(messages, getText)).toEqual(["three", "two", "one"]);
  });

  it("returns an empty ring when there are no user messages", () => {
    expect(deriveUserHistory([{ role: "assistant", text: "hi" }], getText)).toEqual([]);
  });
});

describe("browse backward / forward", () => {
  const history = ["newest", "middle", "oldest"];

  beforeEach(() => {
    $perSessionBrowse.set({});
  });

  it("walks from newest to oldest and stops at the end", () => {
    expect(browseBackward(SID, "draft", history)).toBe("newest");
    expect(isBrowsingHistory(SID)).toBe(true);
    expect(browseBackward(SID, "draft", history)).toBe("middle");
    expect(browseBackward(SID, "draft", history)).toBe("oldest");
    // Already at the oldest entry.
    expect(browseBackward(SID, "draft", history)).toBeNull();
  });

  it("returns null for an empty ring or blank session", () => {
    expect(browseBackward(SID, "draft", [])).toBeNull();
    expect(browseBackward("", "draft", history)).toBeNull();
  });

  it("walks forward toward the present and restores the saved draft", () => {
    browseBackward(SID, "my draft", history); // newest
    browseBackward(SID, "my draft", history); // middle

    const back = browseForward(SID, history);
    expect(back).toEqual({ text: "newest", returnedToPresent: false });

    const present = browseForward(SID, history);
    expect(present).toEqual({ text: "my draft", returnedToPresent: true });
    expect(isBrowsingHistory(SID)).toBe(false);
  });

  it("browseForward is null when not browsing", () => {
    expect(browseForward(SID, history)).toBeNull();
  });

  it("resetBrowseState clears an active browse", () => {
    browseBackward(SID, "draft", history);
    resetBrowseState(SID);
    expect(isBrowsingHistory(SID)).toBe(false);
  });
});
