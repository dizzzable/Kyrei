import { describe, expect, it } from "vitest";
import { selectTeamRoleTools } from "./capabilities.js";

describe("selectTeamRoleTools", () => {
  it("uses a positive capability allowlist and never grants Team Light mutations", () => {
    const selected = selectTeamRoleTools(
      ["workspace.read", "web", "memory.read", "skills.read", "workspace.write", "terminal"],
      {
        read_file: { name: "read" },
        write_file: { name: "write" },
        run_command: { name: "command" },
        web_fetch: { name: "fetch" },
        brain_search: { name: "brain" },
        brain_capture: { name: "capture" },
        read_skill: { name: "skill" },
      } as never,
    );

    expect(Object.keys(selected).sort()).toEqual(["brain_search", "read_file", "read_skill", "web_fetch"]);
  });
});
