import { describe, expect, it, vi } from "vitest";

import { selectSkillForNextRequest, subscribeComposerSkillSelection } from "./composer-skills";

describe("composer skill selection bridge", () => {
  it("forwards only stable opaque skill ids", () => {
    const received = vi.fn();
    const unsubscribe = subscribeComposerSkillSelection(received);
    expect(selectSkillForNextRequest("../escape")).toBe(false);
    expect(selectSkillForNextRequest("skill_0123456789abcdef")).toBe(true);
    expect(received).toHaveBeenCalledWith("skill_0123456789abcdef");
    unsubscribe();
  });
});
