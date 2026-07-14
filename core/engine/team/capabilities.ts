import type { ToolSet } from "ai";
import type { AgentCapability } from "../types.js";

const CAPABILITY_TO_TOOLS: Readonly<Record<AgentCapability, readonly string[]>> = {
  "workspace.read": [
    "list_dir",
    "read_file",
    "grep_search",
    "find_path",
    "batch",
    "retrieve",
    "project_map",
    "project_impact",
  ],
  "workspace.write": [],
  terminal: [],
  web: ["web_search", "web_fetch"],
  "memory.read": ["brain_search", "brain_get", "brain_think", "brain_status"],
  "memory.write": [],
  // A skill is self-contained when it has only SKILL.md. Linked documents are
  // optional, but when a selected skill exposes them the same read capability
  // must allow progressive loading instead of leaving a dead instruction.
  "skills.read": ["search_skills", "read_skill", "read_skill_document", "search_skill_documents"],
  delegate: [],
};

/** Select role tools by positive capability allowlist; mutation stays denied in Team Light. */
export function selectTeamRoleTools(capabilities: readonly AgentCapability[], ...sources: Array<ToolSet | undefined>): ToolSet {
  const allowed = new Set(capabilities.flatMap((capability) => CAPABILITY_TO_TOOLS[capability] ?? []));
  const selected: ToolSet = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, definition] of Object.entries(source)) {
      if (definition && allowed.has(name)) selected[name] = definition;
    }
  }
  return selected;
}
