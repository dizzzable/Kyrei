import { describe, it, expect } from "vitest";
import { ripgrepPath, ripgrepUnavailableReason, isRipgrepAvailable } from "./ripgrep-path.js";

describe("ripgrep path resolution (Electron packaging)", () => {
  it("resolves to an existing executable in this checkout", () => {
    // In a plain checkout the dependency resolves outside any archive, so the
    // rewrite is a no-op and the binary must simply be found.
    expect(isRipgrepAvailable()).toBe(true);
    expect(ripgrepUnavailableReason).toBeUndefined();
    expect(ripgrepPath).toMatch(/ripgrep/);
  });

  it("never hands spawn a path inside an asar archive", () => {
    // The bug: `require.resolve` returns a path THROUGH app.asar, and the OS
    // cannot execute from inside an archive — every grep_search died with
    // ENOENT even though electron-builder had unpacked the binary correctly.
    expect(ripgrepPath).not.toMatch(/[\\/]app\.asar[\\/]/);
  });
});
