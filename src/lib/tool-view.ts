/**
 * Lightweight tool-view builder (inspired by Hermes buildToolView, trimmed to
 * Kyrei's tool set). Derives a title/subtitle/detail + icon/tone/status from a
 * ToolPart for the collapsible tool row. Uses the ported tool-result-summary
 * for human-readable detail and diff for change stats.
 */

import type { ToolPart } from "@/lib/types";
import { formatToolResultSummary, extractToolErrorMessage } from "@/lib/tool-result-summary";
import { countDiffLineStats } from "@/lib/diff";

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
  label: string;
  icon: string;
  tone: ToolTone;
}

const TOOL_META: Record<string, ToolMeta> = {
  list_dir: { label: "Список файлов", icon: "folder-tree", tone: "file" },
  read_file: { label: "Чтение файла", icon: "file-text", tone: "file" },
  write_file: { label: "Запись файла", icon: "file-pen", tone: "file" },
  edit_file: { label: "Правка файла", icon: "file-pen", tone: "file" },
  run_command: { label: "Команда", icon: "terminal", tone: "terminal" },
  grep_search: { label: "Поиск по коду", icon: "search", tone: "search" },
  find_path: { label: "Поиск файлов", icon: "search", tone: "search" },
  diagnostics: { label: "Диагностика", icon: "stethoscope", tone: "agent" },
  batch: { label: "Пакет операций", icon: "layers", tone: "agent" },
  retrieve: { label: "Извлечение", icon: "archive", tone: "agent" },
};

const FILE_EDIT = new Set(["write_file", "edit_file"]);

function metaFor(name: string): ToolMeta {
  return TOOL_META[name] ?? { label: prettify(name), icon: "wrench", tone: "default" };
}

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

export function buildToolView(part: ToolPart): ToolView {
  const meta = metaFor(part.name);
  const isFileEdit = FILE_EDIT.has(part.name);
  const status: ToolStatus = part.running ? "running" : part.error ? "error" : "success";

  const subtitle =
    argString(part.args, ["path", "file", "filepath"]) ||
    argString(part.args, ["command", "query", "pattern", "search_term"]);

  const errorText = part.error || extractToolErrorMessage(part.result);
  const detail = status === "error" ? errorText : (isFileEdit ? "" : formatToolResultSummary(part.result));

  const inlineDiff = part.inlineDiff ?? "";
  const diffStats = inlineDiff ? countDiffLineStats(inlineDiff) : null;

  const durationLabel =
    typeof part.durationS === "number" && !part.running ? `${part.durationS.toFixed(1)}s` : "";

  return {
    icon: meta.icon,
    tone: meta.tone,
    status,
    title: meta.label,
    subtitle,
    detail: detail || "",
    inlineDiff,
    isFileEdit,
    durationLabel,
    diffStats,
  };
}
