import { describe, expect, it } from "vitest";
import {
  formatPostEditVerifyAppendix,
  preferVerifyCommand,
  shouldRunPostEditVerify,
} from "./post-edit-verify.js";

describe("post-edit-verify", () => {
  it("prefers tsc when tsconfig is present", () => {
    expect(preferVerifyCommand(["package.json", "tsconfig.json"])).toContain("tsc");
  });

  it("formats appendix only when ran", () => {
    expect(formatPostEditVerifyAppendix({ ran: false })).toBe("");
    expect(formatPostEditVerifyAppendix({
      ran: true,
      command: "npx tsc --noEmit",
      ok: false,
      output: "error TS",
    })).toContain("post-edit-verify failed");
  });

  it("mutate mode covers build/auto but not plan", () => {
    expect(shouldRunPostEditVerify("mutate", "build")).toBe(true);
    expect(shouldRunPostEditVerify("mutate", "auto")).toBe(true);
    expect(shouldRunPostEditVerify("mutate", "polish")).toBe(true);
    expect(shouldRunPostEditVerify("mutate", "plan")).toBe(false);
    expect(shouldRunPostEditVerify("polish", "build")).toBe(false);
    expect(shouldRunPostEditVerify("mutate", "build", { force: true })).toBe(true);
  });
});
