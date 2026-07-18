import type { MemoryGraphEdge, MemoryGraphGroup, MemoryGraphNode } from "@/lib/types";

export interface PositionedMemoryNode extends MemoryGraphNode {
  x: number;
  y: number;
  radius: number;
}

export interface MemoryGraphLayout {
  width: number;
  height: number;
  nodes: PositionedMemoryNode[];
  edges: MemoryGraphEdge[];
}

const WIDTH = 1_200;
const HEIGHT = 760;

const GROUP_CENTERS: Record<MemoryGraphGroup, readonly [number, number]> = {
  project: [600, 375],
  code: [555, 390],
  document: [790, 195],
  decision: [920, 350],
  plan: [840, 535],
  handoff: [655, 635],
  session: [470, 620],
  memory: [255, 205],
};

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/** Stable cluster layout: the same memory snapshot always renders in the same place. */
export function layoutMemoryGraph(
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
): MemoryGraphLayout {
  const grouped = new Map<MemoryGraphGroup, MemoryGraphNode[]>();
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    grouped.set(node.group, [...(grouped.get(node.group) ?? []), node]);
  }

  const positioned: PositionedMemoryNode[] = [];
  for (const [group, members] of grouped) {
    const [centerX, centerY] = GROUP_CENTERS[group];
    members.forEach((node, index) => {
      if (group === "project") {
        positioned.push({ ...node, x: centerX, y: centerY, radius: 15 });
        return;
      }
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const angle = index * goldenAngle + hashUnit(node.id) * 0.18;
      const normalizedRadius = Math.sqrt((index + 0.7) / Math.max(1, members.length));
      const spreadX = group === "code" ? 500 : 96;
      const spreadY = group === "code" ? 320 : 68;
      positioned.push({
        ...node,
        x: centerX + Math.cos(angle) * spreadX * normalizedRadius,
        y: centerY + Math.sin(angle) * spreadY * normalizedRadius,
        radius: group === "code" ? 4.5 : group === "document" ? 8 : 6,
      });
    });
  }

  const ids = new Set(positioned.map((node) => node.id));
  const validEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const structuralEdges = validEdges.filter((edge) => edge.type !== "imports");
  const importEdges = validEdges.filter((edge) => edge.type === "imports");
  const stride = Math.max(1, Math.ceil(importEdges.length / 620));
  const renderedImports = importEdges.filter((_, index) => index % stride === 0).slice(0, 620);
  return {
    width: WIDTH,
    height: HEIGHT,
    nodes: positioned,
    edges: [...structuralEdges, ...renderedImports],
  };
}
