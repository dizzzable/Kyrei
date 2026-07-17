import { describe, expect, it } from "vitest";

import { secretStorageGuidanceFor } from "./secret-storage-guidance";

describe("secret-storage guidance", () => {
  it("gives Linux and Arch users keyring recovery steps for popular desktops", () => {
    expect(secretStorageGuidanceFor("linux")).toEqual({
      step1: "settings.providers.error.secretStorageLinuxStep1",
      step2: "settings.providers.error.secretStorageLinuxStep2",
      commands: [
        "settings.providers.error.secretStorageLinuxArchCommand",
        "settings.providers.error.secretStorageLinuxDebCommand",
        "settings.providers.error.secretStorageLinuxKdeCommand",
      ],
      hint: "settings.providers.error.secretStorageLinuxWaylandHint",
    });
  });

  it("keeps platform-specific instructions isolated", () => {
    expect(secretStorageGuidanceFor("windows").step2).toBe("settings.providers.error.secretStorageStep2");
    expect(secretStorageGuidanceFor("windows").commands).toEqual([]);
    expect(secretStorageGuidanceFor("macos").step1).toBe("settings.providers.error.secretStorageMacosStep1");
    expect(secretStorageGuidanceFor("unknown").step2).toBe("settings.providers.error.secretStorageGenericStep2");
  });
});
