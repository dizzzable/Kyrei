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
        search_skills: { name: "skill catalog" },
        read_skill: { name: "skill" },
        read_skill_document: { name: "skill doc" },
        search_skill_documents: { name: "skill search" },
      } as never,
    );

    expect(Object.keys(selected).sort()).toEqual([
      "brain_search",
      "read_file",
      "read_skill",
      "read_skill_document",
      "search_skill_documents",
      "search_skills",
      "web_fetch",
    ]);
  });

  it("exposes shared local memory reads without mutation tools", () => {
    const selected = selectTeamRoleTools(
      ["workspace.read", "memory.read"],
      {
        plan_read: { name: "plan" },
        plan_write_roadmap: { name: "plan write" },
        query_decisions: { name: "decisions" },
        record_decision: { name: "record" },
        memory_search: { name: "search" },
        openviking_find: { name: "ov" },
        openviking_add_message: { name: "ov write" },
        project_map: { name: "map" },
        brain_search: { name: "brain" },
      } as never,
    );

    expect(Object.keys(selected).sort()).toEqual([
      "brain_search",
      "memory_search",
      "openviking_find",
      "plan_read",
      "project_map",
      "query_decisions",
    ]);
    expect(selected).not.toHaveProperty("record_decision");
    expect(selected).not.toHaveProperty("plan_write_roadmap");
    expect(selected).not.toHaveProperty("openviking_add_message");
  });
});
