/**
 * Centralized tool descriptions (task 2.5).
 *
 * Single source of truth for what each tool does, consumed by both the tool
 * definitions (tools/index.ts) and the system prompt (prompt/system.ts). This
 * keeps model-facing wording consistent and versionable — a change here is a
 * prompt change and must bump PROMPT_VERSION in system.ts.
 */

export const TOOL_DESCRIPTIONS = {
  list_dir: "List files and folders inside a directory of the workspace.",

  read_file: "Read the UTF-8 text content of a file in the workspace.",

  write_file:
    "Create or fully overwrite a SMALL text file (≤400 lines) or a new file in the workspace. " +
    "For edits to larger existing files use edit_file instead.",

  edit_file:
    "Apply a context-anchored patch to file(s) in the workspace. Preferred for edits to existing files. " +
    "Patch format:\n*** Update File: path/to/file\n@@ optional anchor (function/class name)\n context line\n-removed line\n+added line\n" +
    "Also supports *** Add File / *** Delete File / *** Move File: a -> b. " +
    "Include a few surrounding context lines so the location is unambiguous.",

  run_command: "Run a shell command in the workspace root and return its combined stdout/stderr.",

  grep_search: "Search file contents with ripgrep (regex, smart-case). Returns path:line: text.",

  find_path: "Find files/folders by glob pattern within the workspace (e.g. 'src/**/*.ts').",

  diagnostics: "Run the project's typechecker/linter and return diagnostics (if available).",

  batch: "Run several READ-ONLY tools (list_dir/read_file/grep_search/find_path) in parallel; partial success.",

  retrieve: "Retrieve the full original content of an earlier compressed block by its hash.",
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
