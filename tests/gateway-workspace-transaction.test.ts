import { describe, expect, it, vi } from "vitest";

import { saveConfigWithWorkspace } from "../core/gateway.js";

describe("workspace config transaction", () => {
  it("restores the Skills workspace when persisting the selected workspace fails", async () => {
    const setWorkspace = vi.fn(async () => undefined);
    const saveConfig = vi.fn(async () => {
      throw new Error("disk_full");
    });

    await expect(saveConfigWithWorkspace({
      previousWorkspace: "C:/projects/previous",
      nextWorkspace: "C:/projects/next",
      skillsStore: { setWorkspace },
      saveConfig,
    })).rejects.toThrow("disk_full");

    expect(setWorkspace).toHaveBeenNthCalledWith(1, "C:/projects/next");
    expect(setWorkspace).toHaveBeenNthCalledWith(2, "C:/projects/previous");
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected Skills workspace after a successful durable save", async () => {
    const setWorkspace = vi.fn(async () => undefined);
    const saveConfig = vi.fn(async () => "saved");

    await expect(saveConfigWithWorkspace({
      previousWorkspace: "C:/projects/previous",
      nextWorkspace: "C:/projects/next",
      skillsStore: { setWorkspace },
      saveConfig,
    })).resolves.toBe("saved");

    expect(setWorkspace).toHaveBeenCalledTimes(1);
    expect(setWorkspace).toHaveBeenCalledWith("C:/projects/next");
  });
});
