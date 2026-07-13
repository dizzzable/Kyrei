/**
 * Lightweight tool-view builder (inspired by Hermes buildToolView, trimmed to
 * Kyrei's tool set). Derives a title/subtitle/detail + icon/tone/status from a
 * ToolPart for the collapsible tool row. Uses the ported tool-result-summary
 * for human-readable detail and diff for change stats.
 */

import type { ToolPart } from "@/lib/types";
import { formatToolResultSummary, extractToolErrorMessage } from "@/lib/tool-result-summary";
import { countDiffLineStats } from "@/lib/diff";
import type { ChatTranslationKey, ChatTranslator } from "@/lib/slash-commands";

export type ToolTone = "file" | "terminal" | "search" | "web" | "agent" | "default";
export type ToolStatus = "running" | "success" | "error";

export interface ToolView {
  /** lucide icon name (mapped to a component by the row). */
  icon: string;
  tone: ToolTone;
  status: ToolStatus;
  title: string;
  subtitle: string;
  detail: string;
  inlineDiff: string;
  isFileEdit: boolean;
  durationLabel: string;
  diffStats: { added: number; removed: number } | null;
}

interface ToolMeta {
  labelKey: ChatTranslationKey;
  icon: string;
  tone: ToolTone;
}

const TOOL_META: Record<string, ToolMeta> = {
  list_dir: { labelKey: "chat.tool.listDir", icon: "folder-tree", tone: "file" },
  read_file: { labelKey: "chat.tool.readFile", icon: "file-text", tone: "file" },
  write_file: { labelKey: "chat.tool.writeFile", icon: "file-pen", tone: "file" },
  edit_file: { labelKey: "chat.tool.editFile", icon: "file-pen", tone: "file" },
  run_command: { labelKey: "chat.tool.runCommand", icon: "terminal", tone: "terminal" },
  grep_search: { labelKey: "chat.tool.grepSearch", icon: "search", tone: "search" },
  find_path: { labelKey: "chat.tool.findPath", icon: "search", tone: "search" },
  diagnostics: { labelKey: "chat.tool.diagnostics", icon: "stethoscope", tone: "agent" },
  batch: { labelKey: "chat.tool.batch", icon: "layers", tone: "agent" },
  retrieve: { labelKey: "chat.tool.retrieve", icon: "archive", tone: "agent" },
  web_search: { labelKey: "chat.tool.webSearch", icon: "globe-search", tone: "web" },
  web_fetch: { labelKey: "chat.tool.webFetch", icon: "globe", tone: "web" },
  brain_search: { labelKey: "chat.tool.brainSearch", icon: "brain", tone: "agent" },
  brain_get: { labelKey: "chat.tool.brainGet", icon: "brain", tone: "agent" },
  brain_think: { labelKey: "chat.tool.brainThink", icon: "brain", tone: "agent" },
  brain_status: { labelKey: "chat.tool.brainStatus", icon: "brain", tone: "agent" },
  brain_capture: { labelKey: "chat.tool.brainCapture", icon: "brain", tone: "agent" },
  project_map: { labelKey: "chat.tool.projectMap", icon: "network", tone: "agent" },
  project_impact: { labelKey: "chat.tool.projectImpact", icon: "network", tone: "agent" },
};

const FILE_EDIT = new Set(["write_file", "edit_file"]);

function prettify(name: string): string {
  return name.split(/[_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || name;
}

function argString(args: unknown, keys: string[]): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function buildToolView(part: ToolPart, t: ChatTranslator): ToolView {
  const meta = TOOL_META[part.name];
  const isFileEdit = FILE_EDIT.has(part.name);
  const status: ToolStatus = part.running ? "running" : part.error ? "error" : "success";

  const subtitle =
    argString(part.args, ["path", "file", "filepath"]) ||
    argString(part.args, ["command", "query", "pattern", "search_term", "url", "slug", "question"]);

  const errorText = part.error || extractToolErrorMessage(part.result);
  const detail = status === "error" ? errorText : (isFileEdit ? "" : formatToolResultSummary(part.result, t));

  const inlineDiff = part.inlineDiff ?? "";
  const diffStats = inlineDiff ? countDiffLineStats(inlineDiff) : null;

  const durationLabel =
    typeof part.durationS === "number" && !part.running
      ? t("chat.tool.duration", { seconds: part.durationS.toFixed(1) })
      : "";

  return {
    icon: meta?.icon ?? "wrench",
    tone: meta?.tone ?? "default",
    status,
    title: meta ? t(meta.labelKey) : t("chat.tool.unknown", { name: prettify(part.name) }),
    subtitle,
    detail: detail || "",
    inlineDiff,
    isFileEdit,
    durationLabel,
    diffStats,
  };
}
