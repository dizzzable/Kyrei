import type { MemoryAtlasNode, MemoryAtlasSnapshot } from "@/lib/types";

export type AtlasEdgeType = MemoryAtlasSnapshot["edges"][number]["type"];

/** Anchor point for one category region, in layout world units. */
export interface AtlasAnchor {
  x: number;
  y: number;
  z: number;
}

/**
 * The workspace root sits at the origin and every category is a region around
 * it, so "what belongs to the project" and "what the agent has learned" occupy
 * different parts of the space instead of sharing one hairball.
 */
export const ATLAS_ROOT_REGION = "project";

/**
 * Distance from the origin to a category anchor.
 *
 * Read against the other two scales, not on its own: regions separate only
 * while `ANCHOR_RADIUS` ≫ the charge cut-off ≫ the mean link distance. At
 * 900 : 260 : 34 a region is pulled together far harder than it is pushed
 * across the gap to its neighbours.
 */
export const ANCHOR_RADIUS = 900;

/**
 * The categories the builder emits, in their permanent layout order. Held
 * fixed rather than derived from the nodes on screen: a region's place in
 * space is what makes the map learnable, and deriving it would move every
 * other region the moment a filter emptied one of them.
 */
export const ATLAS_REGION_ORDER: readonly string[] = [
  "code", "documents", "sessions", "memory", "skills", "evolution",
];

/**
 * Anchor slots on the sphere. Fixed, and deliberately larger than the number
 * of known regions, so an optional source appearing later takes a free slot
 * instead of renumbering the ones already in use.
 */
const ANCHOR_SLOTS = 9;

/**
 * Every region present, known ones first in their permanent order. Unknown
 * sources (optional providers) are appended in sorted order so they are stable
 * among themselves.
 */
export function atlasRegions(nodes: readonly MemoryAtlasNode[]): string[] {
  const extra = new Set<string>();
  for (const node of nodes) {
    const region = node.sourceId;
    if (!region || region === ATLAS_ROOT_REGION) continue;
    if (!ATLAS_REGION_ORDER.includes(region)) extra.add(region);
  }
  return [...ATLAS_REGION_ORDER, ...[...extra].sort((left, right) => left.localeCompare(right))];
}

/**
 * Place anchors evenly over a sphere using the Fibonacci lattice: latitudes
 * spaced uniformly in sin, longitudes advanced by the golden angle. Even
 * spacing is the point — clumped anchors would put two categories in the same
 * place and undo the separation.
 *
 * Slots are allocated by INDEX over a fixed lattice, so region *n* always
 * lands on the same point no matter how many regions happen to be visible.
 */
export function atlasAnchors(regions: readonly string[], radius = ANCHOR_RADIUS): Map<string, AtlasAnchor> {
  const anchors = new Map<string, AtlasAnchor>();
  anchors.set(ATLAS_ROOT_REGION, { x: 0, y: 0, z: 0 });
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  regions.forEach((region, index) => {
    const slot = index % ANCHOR_SLOTS;
    const y = 1 - ((slot + 0.5) / ANCHOR_SLOTS) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * slot;
    anchors.set(region, { x: Math.cos(theta) * ring * radius, y: y * radius, z: Math.sin(theta) * ring * radius });
  });
  return anchors;
}

/**
 * Link stiffness per edge type.
 *
 * This exists because d3's default INVERTS the meaning we need. Its default is
 * `1 / min(degree(source), degree(target))`, so a containment edge into a
 * 200-child folder gets ~0.005 while a semantic `related` edge between two
 * low-degree documents gets ~0.5 — similarity ends up roughly a hundred times
 * stiffer than "lives in this directory", and the directory structure loses.
 * Containment is the skeleton and must dominate; the overlays only tint it.
 */
export const ATLAS_LINK_STRENGTH: Record<AtlasEdgeType, number> = {
  contains: 1,
  imports: 0.2,
  references: 0.07,
  related: 0.03,
};

/**
 * Resting length per edge type, in world units. `contains` is what separates
 * one directory level from the next, so it has to be long enough to read as a
 * step down the tree rather than as membership of one blob.
 */
export const ATLAS_LINK_DISTANCE: Record<AtlasEdgeType, number> = {
  contains: 55,
  imports: 110,
  references: 170,
  related: 230,
};

export const ATLAS_DEFAULT_LINK_DISTANCE = 60;
export const ATLAS_DEFAULT_LINK_STRENGTH = 0.1;

/**
 * Resting length of one containment edge, widened by how much the child holds.
 *
 * A fixed length gives `core/` — which contains hundreds of files — exactly as
 * much room as an empty directory, so a large subtree has to fold in on itself
 * and the branch becomes an indistinct blob. Scaling the parent-to-child gap
 * by the child's own bulk is what lets a big branch occupy space proportional
 * to its contents, which is the whole difference between a tree you can read
 * and a cloud you cannot.
 *
 * Cube root, not linear: the subtree occupies a VOLUME, so its radius grows as
 * the cube root of its size. Linear scaling would fling large directories off
 * to the edge of the world.
 */
export function atlasLinkDistance(type: AtlasEdgeType, targetSubtree = 0): number {
  const base = ATLAS_LINK_DISTANCE[type] ?? ATLAS_DEFAULT_LINK_DISTANCE;
  if (type !== "contains") return base;
  return base + Math.cbrt(Math.max(0, targetSubtree)) * 26;
}

/**
 * How hard a node is held to its category anchor, by containment depth.
 *
 * Depth is the whole point. Pulling every folder in a region toward the same
 * anchor with the same force does not arrange a directory tree — it collapses
 * one, because `core/`, `core/engine/` and `core/engine/memory/` are all
 * dragged onto a single point and the hierarchy disappears into a ball.
 *
 * So the anchor holds only the region's own root, which is what fixes the
 * region in space. Everything below it is placed by its containment links
 * instead, and gets just enough residual pull to keep a subtree from wandering
 * into a neighbouring region. The workspace root is pinned outright and needs
 * no pull at all.
 */
export function atlasAnchorStrength(node: MemoryAtlasNode, depth: number): number {
  if (node.kind === "project") return 0;
  if (depth <= 1) return 0.9;
  return Math.min(0.08, 0.16 / depth);
}

/** The containment tree, read out of the links in one pass. */
export interface AtlasHierarchy {
  /** Containing node, by node id. Absent for the root and anything unreachable. */
  parent: Map<string, string>;
  /** Contained nodes, in link order. */
  children: Map<string, string[]>;
  /** Steps from the workspace root. Absent for anything unreachable. */
  depth: Map<string, number>;
  /** Descendants below a node, excluding itself. Zero for a leaf. */
  subtree: Map<string, number>;
}

/**
 * Read the containment tree out of the link list.
 *
 * Built from the links rather than shipped on the node so it survives
 * filtering: a filtered view has its own, shallower tree, and anchoring or
 * sizing by the unfiltered figures would hold nodes at distances and scales
 * nothing on screen explains.
 */
export function atlasHierarchy<Endpoint>(
  rootId: string,
  links: readonly { source: Endpoint; target: Endpoint; type: AtlasEdgeType }[],
  idOf: (endpoint: Endpoint) => string | undefined,
): AtlasHierarchy {
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== "contains") continue;
    const source = idOf(link.source);
    const target = idOf(link.target);
    if (!source || !target || source === target) continue;
    const bucket = children.get(source);
    if (bucket) bucket.push(target);
    else children.set(source, [target]);
    if (!parent.has(target)) parent.set(target, source);
  }

  // Breadth-first from the root, so a cycle in the data cannot loop: a node is
  // only ever assigned a depth once.
  const depth = new Map<string, number>([[rootId, 0]]);
  const order: string[] = [rootId];
  for (let index = 0; index < order.length; index += 1) {
    const id = order[index]!;
    const next = depth.get(id)! + 1;
    for (const child of children.get(id) ?? []) {
      if (depth.has(child)) continue;
      depth.set(child, next);
      order.push(child);
    }
  }

  // Accumulate upward in reverse discovery order, which is a valid post-order
  // for a BFS tree: every node appears after its parent, so walking backwards
  // reaches a node only once all of its children are already counted.
  const subtree = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]!;
    let total = 0;
    for (const child of children.get(id) ?? []) {
      if (depth.get(child) !== depth.get(id)! + 1) continue; // not ours in the BFS tree
      total += 1 + (subtree.get(child) ?? 0);
    }
    subtree.set(id, total);
  }
  return { parent, children, depth, subtree };
}

/**
 * Which folders get a name drawn in the scene.
 *
 * A threshold on subtree size does not work: it is workspace-shaped, and on a
 * workspace with a hundred similarly-sized skill directories every one of them
 * cleared it at once and the region disappeared under overlapping text. A hard
 * count does work — region roots are always named because they are the map's
 * key, and beneath them the largest directories win, which is the same order a
 * reader would care about anyway.
 *
 * `rank` breaks ties by id so the chosen set is identical across reloads; a
 * label that came and went between sessions would be worse than none.
 */
export function atlasLabelledFolders(
  folders: readonly { id: string; depth: number; subtree: number }[],
  limit = MAX_FOLDER_LABELS,
): Set<string> {
  const labelled = new Set<string>();
  const candidates: { id: string; subtree: number }[] = [];
  for (const folder of folders) {
    if (folder.depth <= 1) labelled.add(folder.id);
    else candidates.push(folder);
  }
  candidates.sort((left, right) => right.subtree - left.subtree || left.id.localeCompare(right.id));
  for (const candidate of candidates.slice(0, Math.max(0, limit))) {
    if (candidate.subtree > 0) labelled.add(candidate.id);
  }
  return labelled;
}

/** Named directories below the region roots. Beyond this the names collide. */
export const MAX_FOLDER_LABELS = 16;

/**
 * The branch a node belongs to: everything above it up to the root, and
 * everything below it.
 *
 * This is what answers "where does this directory lead" — the question a
 * one-hop neighbour highlight cannot. Selecting `core/engine/` should light up
 * the path back to the workspace root AND the whole subtree underneath, not
 * just the folder either side of it.
 */
export function atlasBranch(id: string, hierarchy: AtlasHierarchy): Set<string> {
  const branch = new Set<string>([id]);
  let current = hierarchy.parent.get(id);
  for (let step = 0; current && step < 64; step += 1) {
    if (branch.has(current)) break;
    branch.add(current);
    current = hierarchy.parent.get(current);
  }
  const stack = [id];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of hierarchy.children.get(node) ?? []) {
      if (branch.has(child)) continue;
      branch.add(child);
      stack.push(child);
    }
  }
  return branch;
}

/**
 * A node and everything it contains — the part of its branch that lies BELOW
 * it.
 *
 * Distinct from `atlasBranch` on purpose. Highlighting wants the ancestors too,
 * because "where does this live" is half the question. Framing must not: the
 * workspace root sits at the origin and the region roots are 900 units out, so
 * a box drawn around a file's ancestors is nearly the size of the whole graph
 * and the camera never moves.
 */
export function atlasDescendants(id: string, hierarchy: AtlasHierarchy): Set<string> {
  const found = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of hierarchy.children.get(node) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}

/**
 * The chain of titles from the workspace root down to a node, for a breadcrumb.
 * Returns an empty array when the node is not in the containment tree.
 */
export function atlasPath(id: string, hierarchy: AtlasHierarchy): string[] {
  const chain: string[] = [];
  let current: string | undefined = id;
  for (let step = 0; current && step < 64; step += 1) {
    chain.unshift(current);
    current = hierarchy.parent.get(current);
  }
  return chain;
}

/**
 * Repulsion per node. Hubs clear room for their children, and the cut-off is
 * finite on purpose: d3's default `distanceMax` is `Infinity`, so every node
 * pushes every other node at any range and no amount of clustering force can
 * hold regions apart against it.
 */
export const ATLAS_CHARGE_DISTANCE_MAX = 420;

export function atlasChargeStrength(degree: number): number {
  return -26 - 7 * Math.sqrt(Math.max(0, degree));
}

/**
 * Sphere radius the renderer draws, in world units — `cbrt(nodeVal) *
 * nodeRelSize` as three-forcegraph computes it. Kept here so the collision
 * force and the drawn size cannot drift apart.
 */
export function atlasNodeRadius(value: number, relSize: number): number {
  return Math.cbrt(Math.max(0.001, value)) * relSize;
}

/**
 * Keep the scaffolding that leads to whatever survived a filter.
 *
 * A category filter selects content — code files, sessions, skills. Dropping
 * the folders above them as well would leave the survivors floating with no
 * indication of where they came from, which is precisely the failure the
 * folder nodes exist to fix. So every ancestor of a kept node is kept too, and
 * nothing else: filtering to Sessions shows the session tree, not the code
 * tree standing empty beside it.
 */
export function atlasScaffoldClosure(
  kept: ReadonlySet<string>,
  edges: readonly { source: string; target: string; type: AtlasEdgeType }[],
): Set<string> {
  const parent = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === "contains" && !parent.has(edge.target)) parent.set(edge.target, edge.source);
  }
  const visible = new Set(kept);
  for (const id of kept) {
    let current = parent.get(id);
    // Bounded: a cycle in the containment data must not hang the renderer.
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (visible.has(current)) break;
      visible.add(current);
      current = parent.get(current);
    }
  }
  return visible;
}
