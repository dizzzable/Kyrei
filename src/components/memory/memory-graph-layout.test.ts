import { describe, expect, it } from "vitest";

import type { MemoryGraphEdge, MemoryGraphNode } from "@/lib/types";
import { layoutMemoryGraph } from "./memory-graph-layout";

const nodes: MemoryGraphNode[] = [
  { id: "project:root", group: "project", title: "Kyrei" },
  { id: "code:src/main.ts", group: "code", title: "main.ts", path: "src/main.ts" },
  { id: "memory:guide", group: "document", title: "Guide" },
];
const edges: MemoryGraphEdge[] = [
  { source: "project:root", target: "code:src/main.ts", type: "contains" },
  { source: "memory:guide", target: "code:missing.ts", type: "references" },
];

describe("memory graph layout", () => {
  it("is deterministic, finite, and removes dangling edges", () => {
    const first = layoutMemoryGraph(nodes, edges);
    const second = layoutMemoryGraph([...nodes].reverse(), edges);

    expect(first).toEqual(second);
    expect(first.edges).toHaveLength(1);
    expect(first.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(first.nodes.find((node) => node.group === "project")).toMatchObject({ x: 600, y: 375 });
  });
});
