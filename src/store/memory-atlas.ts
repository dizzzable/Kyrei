import { normalizeViewport, type AtlasViewport, type Point } from "@/components/memory/memory-atlas-viewport";

const KEY = "kyrei.memory-atlas.v2";
const MAX_WORKSPACES = 20;

export interface MemoryAtlasPreferences {
  viewport: AtlasViewport;
  expandedTreeIds: string[];
  pinned: Record<string, Point>;
  paneWidths: { left: number; right: number };
  updatedAt: number;
}

const defaults = (): MemoryAtlasPreferences => ({
  viewport: { scale: 1, x: 0, y: 0 },
  expandedTreeIds: [],
  pinned: {},
  paneWidths: { left: 240, right: 300 },
  updatedAt: Date.now(),
});

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalize(value: unknown): MemoryAtlasPreferences {
  const base = defaults();
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const widths = record.paneWidths && typeof record.paneWidths === "object" ? record.paneWidths as Record<string, unknown> : {};
  const rawPinned = record.pinned && typeof record.pinned === "object" ? record.pinned as Record<string, unknown> : {};
  const pinned: Record<string, Point> = {};
  for (const [id, point] of Object.entries(rawPinned).slice(0, 2_000)) {
    if (!point || typeof point !== "object") continue;
    const item = point as Record<string, unknown>;
    if (typeof item.x === "number" && Number.isFinite(item.x) && typeof item.y === "number" && Number.isFinite(item.y)) {
      pinned[id.slice(0, 512)] = { x: item.x, y: item.y };
    }
  }
  return {
    viewport: normalizeViewport(record.viewport as Partial<AtlasViewport> | undefined),
    expandedTreeIds: Array.isArray(record.expandedTreeIds)
      ? [...new Set(record.expandedTreeIds.filter((id): id is string => typeof id === "string").slice(0, 2_000))]
      : [],
    pinned,
    paneWidths: {
      left: Math.min(420, Math.max(180, finite(widths.left, base.paneWidths.left))),
      right: Math.min(520, Math.max(240, finite(widths.right, base.paneWidths.right))),
    },
    updatedAt: finite(record.updatedAt, Date.now()),
  };
}

function readAll(): { workspaces: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { workspaces?: unknown };
    return { workspaces: parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces as Record<string, unknown> : {} };
  } catch {
    return { workspaces: {} };
  }
}

export function loadMemoryAtlasPreferences(workspace: string): MemoryAtlasPreferences {
  return normalize(readAll().workspaces[workspace]);
}

export function saveMemoryAtlasPreferences(workspace: string, preference: Omit<MemoryAtlasPreferences, "updatedAt">): void {
  if (!workspace) return;
  const current = readAll();
  current.workspaces[workspace] = normalize({ ...preference, updatedAt: Date.now() });
  const entries = Object.entries(current.workspaces)
    .map(([id, value]) => [id, normalize(value)] as const)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_WORKSPACES);
  localStorage.setItem(KEY, JSON.stringify({ version: 2, workspaces: Object.fromEntries(entries) }));
}
