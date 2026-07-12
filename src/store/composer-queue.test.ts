import { beforeEach, describe, expect, it } from "vitest";

import {
  $queuedPromptsBySession,
  MAX_AUTO_DRAIN_ATTEMPTS,
  clearQueuedPrompts,
  dequeueQueuedPrompt,
  enqueueQueuedPrompt,
  getQueuedPrompts,
  migrateQueuedPrompts,
  promoteQueuedPrompt,
  removeQueuedPrompt,
  shouldAutoDrain,
  updateQueuedPrompt,
} from "@/store/composer-queue";

const SID = "session-a";

function enqueueText(text: string) {
  return enqueueQueuedPrompt(SID, { text, attachments: [] });
}

describe("composer-queue", () => {
  beforeEach(() => {
    $queuedPromptsBySession.set({});
  });

  describe("enqueue", () => {
    it("appends entries in FIFO order and scopes by session", () => {
      enqueueText("first");
      enqueueText("second");

      const queue = getQueuedPrompts(SID);
      expect(queue.map((e) => e.text)).toEqual(["first", "second"]);
      expect(getQueuedPrompts("other")).toEqual([]);
    });

    it("returns null and no-ops for a blank session key", () => {
      expect(enqueueQueuedPrompt("   ", { text: "x", attachments: [] })).toBeNull();
      expect(enqueueQueuedPrompt(null, { text: "x", attachments: [] })).toBeNull();
    });

    it("clones attachments so later mutation doesn't leak in", () => {
      const attachments = [{ id: "a1", kind: "file" as const, label: "a.ts" }];
      const entry = enqueueQueuedPrompt(SID, { text: "t", attachments })!;
      attachments[0]!.label = "mutated";
      expect(entry.attachments[0]!.label).toBe("a.ts");
    });
  });

  describe("dequeue", () => {
    it("removes and returns the head (FIFO)", () => {
      enqueueText("first");
      enqueueText("second");

      const head = dequeueQueuedPrompt(SID);
      expect(head?.text).toBe("first");
      expect(getQueuedPrompts(SID).map((e) => e.text)).toEqual(["second"]);
    });

    it("returns null when empty and drops the session key", () => {
      expect(dequeueQueuedPrompt(SID)).toBeNull();
      enqueueText("only");
      dequeueQueuedPrompt(SID);
      expect(SID in $queuedPromptsBySession.get()).toBe(false);
    });
  });

  describe("promote", () => {
    it("moves an entry to the front", () => {
      enqueueText("a");
      const second = enqueueText("b")!;
      enqueueText("c");

      expect(promoteQueuedPrompt(SID, second.id)).toBe(true);
      expect(getQueuedPrompts(SID).map((e) => e.text)).toEqual(["b", "a", "c"]);
    });

    it("is a no-op for the head or a missing id", () => {
      const head = enqueueText("a")!;
      enqueueText("b");

      expect(promoteQueuedPrompt(SID, head.id)).toBe(false);
      expect(promoteQueuedPrompt(SID, "nope")).toBe(false);
      expect(getQueuedPrompts(SID).map((e) => e.text)).toEqual(["a", "b"]);
    });
  });

  describe("remove / update / clear", () => {
    it("removes by id", () => {
      const a = enqueueText("a")!;
      enqueueText("b");

      expect(removeQueuedPrompt(SID, a.id)).toBe(true);
      expect(removeQueuedPrompt(SID, a.id)).toBe(false);
      expect(getQueuedPrompts(SID).map((e) => e.text)).toEqual(["b"]);
    });

    it("updates text and reports whether anything changed", () => {
      const a = enqueueText("a")!;

      expect(updateQueuedPrompt(SID, a.id, { text: "a2" })).toBe(true);
      expect(getQueuedPrompts(SID)[0]!.text).toBe("a2");
      expect(updateQueuedPrompt(SID, a.id, { text: "a2" })).toBe(false);
    });

    it("clears the whole session queue", () => {
      enqueueText("a");
      enqueueText("b");
      clearQueuedPrompts(SID);
      expect(getQueuedPrompts(SID)).toEqual([]);
    });
  });

  describe("migrate", () => {
    it("moves pending entries onto a live key, appending after existing", () => {
      enqueueQueuedPrompt("old", { text: "o1", attachments: [] });
      enqueueQueuedPrompt("old", { text: "o2", attachments: [] });
      enqueueQueuedPrompt("live", { text: "l1", attachments: [] });

      expect(migrateQueuedPrompts("old", "live")).toBe(true);
      expect(getQueuedPrompts("live").map((e) => e.text)).toEqual(["l1", "o1", "o2"]);
      expect(getQueuedPrompts("old")).toEqual([]);
    });

    it("no-ops when keys are equal, blank, or the source is empty", () => {
      expect(migrateQueuedPrompts("x", "x")).toBe(false);
      expect(migrateQueuedPrompts(null, "live")).toBe(false);
      expect(migrateQueuedPrompts("empty", "live")).toBe(false);
    });
  });

  describe("shouldAutoDrain", () => {
    it("drains only when idle with pending entries", () => {
      expect(shouldAutoDrain({ isBusy: false, queueLength: 1 })).toBe(true);
      expect(shouldAutoDrain({ isBusy: true, queueLength: 1 })).toBe(false);
      expect(shouldAutoDrain({ isBusy: false, queueLength: 0 })).toBe(false);
    });

    it("exposes a retry cap", () => {
      expect(MAX_AUTO_DRAIN_ATTEMPTS).toBe(4);
    });
  });
});
