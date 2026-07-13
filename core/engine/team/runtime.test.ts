import { describe, expect, it } from "vitest";

import type { RuntimeTeamRole } from "../types.js";
import { clampTeamRoleToReadOnly } from "./runtime.js";

const role: RuntimeTeamRole = {
  id: "implementation",
  name: "Implementation",
  target: {
    providerId: "local",
    protocol: "openai-chat",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "test-model",
    apiKey: "",
    requiresApiKey: false,
  },
  skillIds: [],
  capabilities: [
    "workspace.read",
    "workspace.write",
    "terminal",
    "web",
    "memory.read",
    "memory.write",
    "skills.read",
    "delegate",
  ],
  canSpawn: true,
  maxChildren: 2,
};

describe("clampTeamRoleToReadOnly", () => {
  it("removes every mutating capability while retaining explicitly granted read-only delegation", () => {
    expect(clampTeamRoleToReadOnly(role)).toMatchObject({
      capabilities: ["workspace.read", "web", "memory.read", "skills.read", "delegate"],
      canSpawn: true,
    });
  });

  it("does not invent delegation when the profile did not grant it", () => {
    expect(clampTeamRoleToReadOnly({
      ...role,
      capabilities: ["workspace.write", "terminal"],
      canSpawn: true,
    })).toMatchObject({
      capabilities: [],
      canSpawn: false,
    });
  });

  it("leaves an ordinary chat Team role unchanged when no clamp is requested", () => {
    expect(clampTeamRoleToReadOnly(role, false)).toBe(role);
  });
});
