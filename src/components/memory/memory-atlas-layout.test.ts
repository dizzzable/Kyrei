import { describe, expect, it } from "vitest";
import type { MemoryAtlasNode } from "@/lib/types";
import {
  ANCHOR_RADIUS,
  MAX_FOLDER_LABELS,
  atlasLabelledFolders,
  ATLAS_LINK_DISTANCE,
  ATLAS_LINK_STRENGTH,
  ATLAS_REGION_ORDER,
  ATLAS_ROOT_REGION,
  atlasAnchorStrength,
  atlasAnchors,
  atlasBranch,
  atlasChargeStrength,
  atlasDescendants,
  atlasHierarchy,
  atlasLinkDistance,
  atlasNodeRadius,
  atlasPath,
  atlasRegions,
  atlasScaffoldClosure,
} from "./memory-atlas-layout";

const node = (over: Partial<MemoryAtlasNode> & Pick<MemoryAtlasNode, "id">): MemoryAtlasNode => ({
  sourceId: "code",
  kind: "code",
  title: over.id,
  ...over,
});

describe("atlasRegions", () => {
  it("lists the known regions in their permanent order regardless of what is on screen", () => {
    // Filtering to a single category must not renumber the others: a region's
    // place in space is the only thing that makes the map learnable.
    expect(atlasRegions([node({ id: "a", sourceId: "sessions" })])).toEqual(ATLAS_REGION_ORDER);
    expect(atlasRegions([])).toEqual(ATLAS_REGION_ORDER);
  });

  it("appends an unknown source after the known ones, sorted", () => {
    const regions = atlasRegions([
      node({ id: "a", sourceId: "openviking" }),
      node({ id: "b", sourceId: "gbrain" }),
    ]);
    expect(regions.slice(0, ATLAS_REGION_ORDER.length)).toEqual(ATLAS_REGION_ORDER);
    expect(regions.slice(ATLAS_REGION_ORDER.length)).toEqual(["gbrain", "openviking"]);
  });

  it("never treats the workspace root as a region", () => {
    expect(atlasRegions([node({ id: "r", sourceId: ATLAS_ROOT_REGION, kind: "project" })])).toEqual(ATLAS_REGION_ORDER);
  });
});

describe("atlasAnchors", () => {
  it("puts the workspace root at the origin", () => {
    expect(atlasAnchors(ATLAS_REGION_ORDER).get(ATLAS_ROOT_REGION)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("spreads every region onto the sphere at the anchor radius", () => {
    const anchors = atlasAnchors(ATLAS_REGION_ORDER);
    for (const region of ATLAS_REGION_ORDER) {
      const anchor = anchors.get(region)!;
      expect(Math.hypot(anchor.x, anchor.y, anchor.z)).toBeCloseTo(ANCHOR_RADIUS, 6);
    }
  });

  it("keeps regions far apart from one another", () => {
    const anchors = atlasAnchors(ATLAS_REGION_ORDER);
    const points = ATLAS_REGION_ORDER.map((region) => anchors.get(region)!);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const [a, b] = [points[i]!, points[j]!];
        // Comfortably wider than the charge cut-off, or the regions merge.
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(ANCHOR_RADIUS * 0.5);
      }
    }
  });

  it("gives a region the same point no matter how many regions are present", () => {
    // Slots are allocated by index over a FIXED lattice. Deriving the lattice
    // from the count instead would move every region whenever an optional
    // source appeared or a filter emptied one.
    const full = atlasAnchors(ATLAS_REGION_ORDER);
    const extended = atlasAnchors([...ATLAS_REGION_ORDER, "gbrain", "openviking"]);
    for (const region of ATLAS_REGION_ORDER) {
      expect(extended.get(region)).toEqual(full.get(region));
    }
  });
});

describe("layout physics", () => {
  it("makes containment the stiffest edge type by a wide margin", () => {
    // d3's default is `1 / min(degree)`, which makes a similarity edge between
    // two quiet documents roughly a hundred times stiffer than membership of a
    // large directory — so the directory structure loses and the graph reads
    // as a hairball. Containment is the skeleton and has to dominate.
    expect(ATLAS_LINK_STRENGTH.contains).toBeGreaterThan(ATLAS_LINK_STRENGTH.imports * 3);
    expect(ATLAS_LINK_STRENGTH.imports).toBeGreaterThan(ATLAS_LINK_STRENGTH.references);
    expect(ATLAS_LINK_STRENGTH.references).toBeGreaterThan(ATLAS_LINK_STRENGTH.related);
  });

  it("anchors a region's own root and lets everything below it spread", () => {
    // Pulling every folder of a region toward the same anchor with the same
    // force collapses the directory tree into a ball instead of arranging it.
    expect(atlasAnchorStrength(node({ id: "p", kind: "project", sourceId: "project" }), 0)).toBe(0);
    const regionRoot = atlasAnchorStrength(node({ id: "tree:code", kind: "folder" }), 1);
    const midFolder = atlasAnchorStrength(node({ id: "tree:code:core", kind: "folder" }), 2);
    const deepFile = atlasAnchorStrength(node({ id: "code:core/a/b.ts" }), 5);
    expect(regionRoot).toBeGreaterThan(midFolder * 5);
    expect(midFolder).toBeGreaterThan(deepFile);
    expect(regionRoot).toBeLessThanOrEqual(1);
    expect(deepFile).toBeGreaterThan(0);
  });

  it("grows repulsion with degree so hubs clear room for their children", () => {
    expect(atlasChargeStrength(0)).toBeLessThan(0);
    expect(atlasChargeStrength(100)).toBeLessThan(atlasChargeStrength(1));
  });

  it("matches the radius three-forcegraph actually draws", () => {
    // `cbrt(nodeVal) * nodeRelSize`. The collision force and the drawn sphere
    // read this same function, so they cannot drift apart.
    expect(atlasNodeRadius(8, 12)).toBeCloseTo(24, 6);
    expect(atlasNodeRadius(0, 12)).toBeGreaterThan(0);
  });
});

describe("atlasHierarchy", () => {
  type Endpoint = string | { id: string };
  const id = (endpoint: Endpoint) => (typeof endpoint === "string" ? endpoint : endpoint.id);
  const links = [
    { source: "project:root", target: "tree:code", type: "contains" as const },
    { source: "tree:code", target: "tree:code:core", type: "contains" as const },
    { source: "tree:code:core", target: "code:core/a.ts", type: "contains" as const },
    { source: "tree:code:core", target: "code:core/b.ts", type: "contains" as const },
    { source: "code:core/a.ts", target: "code:core/b.ts", type: "imports" as const },
  ];
  const build = (input: typeof links) => atlasHierarchy<Endpoint>("project:root", input, id);

  it("measures containment depth from the workspace root", () => {
    const { depth } = build(links);
    expect(depth.get("project:root")).toBe(0);
    expect(depth.get("tree:code")).toBe(1);
    expect(depth.get("tree:code:core")).toBe(2);
    expect(depth.get("code:core/a.ts")).toBe(3);
  });

  it("counts descendants, not immediate children", () => {
    // Sizing a folder by degree would draw `core/` — holding hundreds of files
    // through four subdirectories — smaller than a leaf imported five times.
    const { subtree } = build(links);
    expect(subtree.get("project:root")).toBe(4);
    expect(subtree.get("tree:code")).toBe(3);
    expect(subtree.get("tree:code:core")).toBe(2);
    expect(subtree.get("code:core/a.ts")).toBe(0);
  });

  it("does not walk overlay edges", () => {
    // An import is not containment; treating it as such would give a file a
    // depth and a parent that have nothing to do with where it lives.
    const { parent } = build(links);
    expect(parent.get("code:core/b.ts")).toBe("tree:code:core");
  });

  it("reads endpoints that force-graph has already resolved to node objects", () => {
    const resolved = [{ source: { id: "project:root" }, target: { id: "tree:code" }, type: "contains" as const }];
    expect(atlasHierarchy<Endpoint>("project:root", resolved, id).depth.get("tree:code")).toBe(1);
  });

  it("terminates on a containment cycle", () => {
    const { depth, subtree } = build([
      { source: "project:root", target: "a", type: "contains" as const },
      { source: "a", target: "b", type: "contains" as const },
      { source: "b", target: "a", type: "contains" as const },
    ]);
    expect(depth.get("a")).toBe(1);
    expect(depth.get("b")).toBe(2);
    expect(subtree.get("a")).toBe(1);
  });
});

describe("atlasLabelledFolders", () => {
  const folder = (id: string, depth: number, subtree: number) => ({ id, depth, subtree });

  it("always names the region roots", () => {
    const labelled = atlasLabelledFolders([folder("tree:code", 1, 700), folder("tree:skills", 1, 1400)]);
    expect([...labelled].sort()).toEqual(["tree:code", "tree:skills"]);
  });

  it("caps the rest by count, not by size", () => {
    // A size threshold is workspace-shaped: on a workspace with a hundred
    // similarly-sized skill directories every one cleared it at once and the
    // region vanished under overlapping text.
    const many = Array.from({ length: 100 }, (_, i) => folder(`skill-${i}`, 3, 30));
    const labelled = atlasLabelledFolders([folder("tree:skills", 1, 3000), ...many]);
    expect(labelled.size).toBe(1 + MAX_FOLDER_LABELS);
  });

  it("prefers the largest directories", () => {
    const labelled = atlasLabelledFolders([folder("small", 2, 3), folder("big", 2, 900)], 1);
    expect([...labelled]).toEqual(["big"]);
  });

  it("never names an empty directory", () => {
    expect(atlasLabelledFolders([folder("empty", 2, 0)], 10).size).toBe(0);
  });

  it("picks the same set every time", () => {
    // A label that appeared and vanished between sessions is worse than none.
    const equal = [folder("b", 2, 10), folder("a", 2, 10), folder("c", 2, 10)];
    expect([...atlasLabelledFolders(equal, 2)]).toEqual([...atlasLabelledFolders([...equal].reverse(), 2)]);
  });
});

describe("atlasBranch", () => {
  type Endpoint = string | { id: string };
  const id = (endpoint: Endpoint) => (typeof endpoint === "string" ? endpoint : endpoint.id);
  const hierarchy = atlasHierarchy<Endpoint>("project:root", [
    { source: "project:root", target: "tree:code", type: "contains" as const },
    { source: "tree:code", target: "tree:code:core", type: "contains" as const },
    { source: "tree:code:core", target: "code:core/a.ts", type: "contains" as const },
    { source: "project:root", target: "tree:sessions", type: "contains" as const },
  ], id);

  it("lights the path up to the root and everything below", () => {
    // One hop answered neither question: focusing a directory showed the
    // folder above and the children below and stopped, which says nothing
    // about where it sits in the project or what it actually holds.
    expect([...atlasBranch("tree:code:core", hierarchy)].sort()).toEqual([
      "code:core/a.ts", "project:root", "tree:code", "tree:code:core",
    ]);
  });

  it("excludes sibling branches", () => {
    expect(atlasBranch("code:core/a.ts", hierarchy).has("tree:sessions")).toBe(false);
  });

  it("returns just the node when it is not in the tree", () => {
    expect([...atlasBranch("orphan", hierarchy)]).toEqual(["orphan"]);
  });

  it("frames descendants only, leaving the ancestors to the highlight", () => {
    // The workspace root sits at the origin and the region roots 900 units
    // out, so a box drawn around a file's ANCESTORS is nearly the size of the
    // whole graph — the camera computed a frame and never moved.
    expect([...atlasDescendants("tree:code", hierarchy)].sort()).toEqual([
      "code:core/a.ts", "tree:code", "tree:code:core",
    ]);
    expect([...atlasDescendants("code:core/a.ts", hierarchy)]).toEqual(["code:core/a.ts"]);
  });

  it("spells the path out for a breadcrumb", () => {
    expect(atlasPath("code:core/a.ts", hierarchy)).toEqual([
      "project:root", "tree:code", "tree:code:core", "code:core/a.ts",
    ]);
  });
});

describe("atlasLinkDistance", () => {
  it("gives a big directory room proportional to what it holds", () => {
    // A fixed length gave `core/` exactly as much space as an empty folder, so
    // a large branch had to fold in on itself and became an indistinct blob.
    expect(atlasLinkDistance("contains", 500)).toBeGreaterThan(atlasLinkDistance("contains", 0));
    expect(atlasLinkDistance("contains", 0)).toBe(ATLAS_LINK_DISTANCE.contains);
  });

  it("grows as a cube root, not linearly", () => {
    // The subtree occupies a volume; linear scaling would fling large
    // directories to the edge of the world.
    const step = (n: number) => atlasLinkDistance("contains", n) - ATLAS_LINK_DISTANCE.contains;
    expect(step(1000)).toBeCloseTo(step(125) * 2, 6);
  });

  it("leaves overlay edges at their fixed length", () => {
    expect(atlasLinkDistance("imports", 500)).toBe(ATLAS_LINK_DISTANCE.imports);
    expect(atlasLinkDistance("related", 500)).toBe(ATLAS_LINK_DISTANCE.related);
  });
});

describe("atlasScaffoldClosure", () => {
  const edges = [
    { source: "project:root", target: "tree:code", type: "contains" as const },
    { source: "tree:code", target: "tree:code:core", type: "contains" as const },
    { source: "tree:code:core", target: "code:core/a.ts", type: "contains" as const },
    { source: "project:root", target: "tree:sessions", type: "contains" as const },
    { source: "tree:sessions", target: "memory:s1", type: "contains" as const },
    { source: "code:core/a.ts", target: "memory:s1", type: "references" as const },
  ];

  it("keeps every folder on the path to a survivor", () => {
    expect([...atlasScaffoldClosure(new Set(["code:core/a.ts"]), edges)].sort()).toEqual([
      "code:core/a.ts", "project:root", "tree:code", "tree:code:core",
    ]);
  });

  it("does not drag in the scaffolding of other regions", () => {
    // Filtering to Sessions must not leave the whole code tree standing empty
    // beside the result.
    const visible = atlasScaffoldClosure(new Set(["memory:s1"]), edges);
    expect(visible.has("tree:sessions")).toBe(true);
    expect(visible.has("tree:code")).toBe(false);
  });

  it("climbs containment only, never a reference", () => {
    const visible = atlasScaffoldClosure(new Set(["memory:s1"]), edges);
    expect(visible.has("code:core/a.ts")).toBe(false);
  });

  it("returns an empty set when nothing survived", () => {
    expect(atlasScaffoldClosure(new Set(), edges).size).toBe(0);
  });

  it("terminates on a containment cycle", () => {
    const cyclic = [
      { source: "a", target: "b", type: "contains" as const },
      { source: "b", target: "a", type: "contains" as const },
    ];
    expect(atlasScaffoldClosure(new Set(["a"]), cyclic).size).toBe(2);
  });
});
