export type MemoryAtlasSourceCapability = "browse" | "search-only" | "health-only";
export type MemoryAtlasSourceHealth = "ready" | "degraded" | "stale" | "unavailable";

export interface MemoryAtlasSourceDescriptor {
  id: string;
  label: string;
  capability: MemoryAtlasSourceCapability;
  health: MemoryAtlasSourceHealth;
  reason?: string;
  generatedAt?: string;
  lastGoodAt?: string;
  truncated?: boolean;
  omitted?: number;
}

/**
 * `folder` is scaffolding, not content: one node per directory / source root,
 * derived from the tree so the graph and the sidebar describe the same
 * structure. Before it existed, 426 of 696 code files had no edge at all —
 * a file was only connected if it happened to be an entry point or the target
 * of an import — so the graph showed a cloud of unattached dots instead of a
 * project. Scaffolding is never a filter category; it is kept or dropped
 * according to whether anything below it survived the filter.
 */
export type MemoryAtlasNodeKind =
  | "project" | "folder" | "code" | "document" | "decision" | "plan"
  | "handoff" | "session" | "memory" | "skill" | "evolution";

export interface MemoryAtlasNode {
  id: string;
  entityId?: string;
  sourceId: string;
  kind: MemoryAtlasNodeKind;
  title: string;
  path?: string;
  subtitle?: string;
  preview?: string;
  updatedAt?: string;
  digest?: string;
  enabled?: boolean;
  compatible?: boolean;
}

export interface MemoryAtlasEdge {
  source: string;
  target: string;
  type: "imports" | "contains" | "references" | "related";
  sourceId: string;
}

export interface MemoryAtlasTreeNode {
  id: string;
  sourceId: string;
  kind: "source" | "folder" | "item";
  label: string;
  parentId?: string;
  path?: string;
  nodeId?: string;
  childCount: number;
}

export interface MemoryAtlasStats {
  nodes: number;
  edges: number;
  code: number;
  documents: number;
  decisions: number;
  sessions: number;
  skills: number;
  evolution: number;
  truncated: boolean;
  truncationReasons: string[];
}

export interface MemoryAtlasSnapshot {
  version: 2;
  snapshotId: string;
  generatedAt: string;
  workspace: string;
  sources: MemoryAtlasSourceDescriptor[];
  tree: MemoryAtlasTreeNode[];
  nodes: MemoryAtlasNode[];
  edges: MemoryAtlasEdge[];
  stats: MemoryAtlasStats;
}

export interface MemoryAtlasSkillMetadata {
  id: string;
  name: string;
  description?: string;
  path?: string;
  rootKind?: string;
  enabled: boolean;
  compatible: boolean;
  digest?: string;
  linkedDocuments?: Array<{ id: string; title?: string; path?: string }>;
}

export interface MemoryAtlasEvolutionMetadata {
  id: string;
  title: string;
  summary?: string;
  status: "pending" | "evaluating" | "approved" | "rejected" | "canary" | "promoted" | "rolled-back" | "failed";
  risk: "low" | "medium" | "high";
  targetKind: string;
  targetId: string;
  updatedAt?: string;
  digest?: string;
}

export interface MemoryAtlasSourcePayload {
  nodes?: MemoryAtlasNode[];
  edges?: MemoryAtlasEdge[];
  tree?: MemoryAtlasTreeNode[];
  health?: Exclude<MemoryAtlasSourceHealth, "unavailable">;
  reason?: string;
  truncated?: boolean;
  omitted?: number;
}
