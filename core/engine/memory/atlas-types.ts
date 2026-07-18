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

export type MemoryAtlasNodeKind =
  | "project" | "code" | "document" | "decision" | "plan"
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
