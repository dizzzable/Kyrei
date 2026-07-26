import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceX, forceY, forceZ } from "d3-force-3d";
import ForceGraph3D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-3d";
import type { Group, Object3D } from "three";

import { useI18n } from "@/i18n";
import { useThemeId } from "@/lib/theme";
import type { MemoryAtlasNode, MemoryAtlasSnapshot } from "@/lib/types";
import { ATLAS_EDGE_COLORS, atlasNodePalette, atlasRegionColor } from "./memory-atlas-colors";
import { createAtlasFolderObject, createAtlasLabelSprite, disposeAtlasFolderObject } from "./memory-atlas-label";
import {
  ATLAS_CHARGE_DISTANCE_MAX,
  ATLAS_DEFAULT_LINK_DISTANCE,
  ATLAS_DEFAULT_LINK_STRENGTH,
  ATLAS_LINK_DISTANCE,
  ATLAS_LINK_STRENGTH,
  ATLAS_ROOT_REGION,
  type AtlasEdgeType,
  atlasAnchorStrength,
  atlasAnchors,
  atlasBranch,
  atlasChargeStrength,
  atlasDescendants,
  atlasHierarchy,
  atlasLabelledFolders,
  atlasLinkDistance,
  atlasNodeRadius,
  atlasPath,
  atlasRegions,
} from "./memory-atlas-layout";
import { atlasCameraPlan, atlasFitDistance } from "./memory-atlas-viewport";

type AtlasNodeData = { node: MemoryAtlasNode; degree: number; depth: number; subtree: number };
type AtlasGraphNode = NodeObject<AtlasNodeData>;
// force-graph mutates links in place, replacing each id with the node object,
// so both forms are observable at runtime.
type AtlasLink = { source: string | AtlasGraphNode; target: string | AtlasGraphNode; type: AtlasEdgeType };

/** Perf ceiling: above this node count, drop mesh detail and dragging. */
const HEAVY_NODE_COUNT = 1_500;

/** Colour for nodes outside the current focus/search set. */
const DIMMED_COLOR = "rgba(120,120,130,0.18)";

// Hoisted so their identity is stable across renders. react-force-graph
// re-digests every link whenever an accessor's identity changes, which would
// otherwise rebuild all link geometry on every hover.
/**
 * Link radius, in WORLD units — the same trap the node radius fell into. This
 * graph spreads across ~2 600 units, so the old 0.4–0.8 came out at roughly a
 * quarter of a pixel once the camera framed it: the edges were drawn and
 * invisible. `contains` is the widest because it IS the directory structure —
 * 1 193 of 1 500 edges — and it is what makes "which folder does this belong
 * to" readable at all.
 */
const LINK_WIDTH: Record<AtlasEdgeType, number> = {
  contains: 2.6,
  imports: 3,
  references: 3.4,
  related: 2.2,
};
const linkWidth = (link: AtlasLink) => LINK_WIDTH[link.type] ?? 2.6;

/**
 * Sphere radius is `cbrt(nodeVal) * nodeRelSize` in WORLD units, so it has to
 * be read against the layout's scale. This graph spreads across thousands of
 * units; at the library default of 4 a node is under a pixel once the camera
 * frames the whole thing, which reads as an empty canvas even though every
 * sphere is drawn correctly.
 */
const NODE_REL_SIZE = 12;

/**
 * Node volume. Folders are given their own band above the leaves: they carry
 * the structure, so a directory has to be visible as a hub rather than as one
 * more dot among its own children.
 *
 * A folder is sized by how much it CONTAINS, not by its degree — degree counts
 * only immediate children, so `core/` with four subdirectories would draw
 * smaller than a leaf file that happens to be imported five times, which is
 * the opposite of what the tree means. Cube-rooted because volume is what the
 * renderer scales, so radius stays proportional to the ninth root otherwise.
 *
 * Hoisted and shared with the collision force — the two must agree, or nodes
 * either overlap or repel at a radius they are not drawn at.
 */
function nodeValue(node: AtlasGraphNode): number {
  const kind = node.node.kind;
  if (kind === "project") return 24;
  if (kind === "folder") return Math.max(4, Math.min(30, 4 + Math.cbrt(node.subtree) * 4));
  return Math.max(1, Math.min(8, 1.2 + node.degree * 0.5));
}

const ROOT_NODE_ID = "project:root";

/** Depth assigned to anything the containment tree cannot reach. */
const UNREACHABLE_DEPTH = 8;

/**
 * Name-plate height as a fraction of the VIEWPORT, not of the world — the
 * sprites are drawn with `sizeAttenuation` off so they stay the same size at
 * every zoom.
 */
const REGION_LABEL_HEIGHT = 0.032;

/**
 * Smallest box the camera will frame. Without a floor, selecting a single leaf
 * asks the camera to fit a box the size of one sphere, which puts it inside;
 * this leaves enough of the surrounding branch in view to be worth looking at.
 */
const MIN_FOCUS_EXTENT = 460;


function endpointId(endpoint: string | AtlasGraphNode): string | undefined {
  return typeof endpoint === "string" ? endpoint : (endpoint.id as string | undefined);
}

/**
 * Subtree weight of a link's target. `forceLink` replaces endpoint ids with
 * node objects before the distance accessor first runs, but the string form is
 * observable on a freshly supplied link, so both are handled.
 */
function subtreeOfTarget(link: AtlasLink): number {
  return typeof link.target === "string" ? 0 : link.target.subtree;
}

export function MemoryAtlasCanvas3D({
  nodes,
  edges,
  selectedId,
  matchedIds,
  onSelect,
}: {
  nodes: readonly MemoryAtlasNode[];
  edges: Array<MemoryAtlasSnapshot["edges"][number]>;
  selectedId: string | null;
  matchedIds: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const themeId = useThemeId();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<AtlasGraphNode, AtlasLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Only edges whose endpoints are both visible become links.
  const graphData = useMemo(() => {
    const present = new Set(nodes.map((node) => node.id));
    const degree = new Map<string, number>();
    const links: AtlasLink[] = [];
    for (const edge of edges) {
      if (!present.has(edge.source) || !present.has(edge.target)) continue;
      links.push({ source: edge.source, target: edge.target, type: edge.type });
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    // The containment tree is read from the links, so it reflects what is
    // actually on screen: a filtered view has its own, shallower tree, and
    // anchoring or sizing by the unfiltered figures would place nodes at
    // distances nothing visible explains.
    const hierarchy = atlasHierarchy(ROOT_NODE_ID, links, endpointId);
    const graphNodes: AtlasGraphNode[] = nodes.map((node) => ({
      id: node.id,
      node,
      degree: degree.get(node.id) ?? 0,
      // Carried on the node so the size accessor, the collision force and the
      // anchor force all read the same numbers.
      depth: hierarchy.depth.get(node.id) ?? UNREACHABLE_DEPTH,
      subtree: hierarchy.subtree.get(node.id) ?? 0,
      // Pin the workspace root at the origin. Every region is arranged around
      // it, so it is the one landmark that must not drift — and d3 resets a
      // node with `fx/fy/fz` to those coordinates after every tick.
      ...(node.kind === "project" ? { fx: 0, fy: 0, fz: 0 } : {}),
    }));
    const labelled = atlasLabelledFolders(
      graphNodes.filter((node) => node.node.kind === "folder").map((node) => ({
        id: node.id as string,
        depth: node.depth,
        subtree: node.subtree,
      })),
    );
    return { nodes: graphNodes, links, hierarchy, labelled };
  }, [nodes, edges]);

  const heavy = graphData.nodes.length > HEAVY_NODE_COUNT;

  // three.js cannot read CSS variables, so resolve the palette to concrete
  // colours — once per theme change, not per node per hover. Read against :root
  // (where `applyTheme` sets the theme), so it is correct on the first render,
  // before the container ref is attached.
  const palette = useMemo(
    () => ({ nodes: atlasNodePalette() }),
    [themeId],
  );

  /**
   * Nodes kept at full strength.
   *
   * Focusing a node lights up its whole BRANCH — every folder up to the
   * workspace root, and everything contained below it — plus whatever it
   * imports or references directly. One hop was not enough to answer "where
   * does this directory lead": it lit the folder immediately above and the
   * children immediately below, and stopped, which says nothing about where a
   * file sits in the project or what a directory actually holds.
   *
   * With no focus, an active search narrows the graph to its matches, mirroring
   * the 2D view.
   */
  const focusId = hoverId ?? selectedId;
  const highlighted = useMemo(() => {
    if (!focusId) return matchedIds.size > 0 ? matchedIds : null;
    const set = atlasBranch(focusId, graphData.hierarchy);
    for (const link of graphData.links) {
      if (link.type === "contains") continue; // already covered by the branch
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (source === focusId && target) set.add(target);
      if (target === focusId && source) set.add(source);
    }
    return set;
  }, [focusId, graphData.links, graphData.hierarchy, matchedIds]);

  /** Root-to-node title chain for the breadcrumb overlay. */
  const focusPath = useMemo(() => {
    if (!focusId) return [];
    const byId = new Map(graphData.nodes.map((node) => [node.id as string, node]));
    return atlasPath(focusId, graphData.hierarchy).map((id) => byId.get(id)?.node.title ?? id);
  }, [focusId, graphData.hierarchy, graphData.nodes]);

  // Container-driven sizing. The camera is framed separately once the graph
  // settles — see fitToGraph.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    /**
     * Measure directly first.
     *
     * `ResizeObserver` delivery is part of the rendering lifecycle, so it does
     * not fire while the document has no frames — a window that is hidden,
     * minimised or occluded when the Atlas opens. `size` then stayed {0,0}
     * forever and the guard below never mounted the graph at all: measured
     * live, a container of 868×685 with zero canvases. A direct read has no
     * such dependency, and the observer still handles later resizes.
     */
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
        return true;
      }
      return false;
    };
    if (!measure()) {
      // Laid out on a later frame (dialog open animation): retry briefly.
      const retry = setInterval(() => { if (measure()) clearInterval(retry); }, 120);
      setTimeout(() => clearInterval(retry), 5_000);
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Fixed anchor per category, so a region always occupies the same space. */
  const anchors = useMemo(() => atlasAnchors(atlasRegions(nodes)), [nodes]);

  /**
   * Give the simulation a shape.
   *
   * Out of the box this graph had no clustering at all: the library's defaults
   * are a link force, unbounded repulsion, and `forceCenter` — which only
   * translates the whole point cloud and cannot hold anything in place. Every
   * category therefore landed in the same undifferentiated ball.
   *
   * Four changes make it a map. `center` is replaced by a per-axis pull toward
   * the node's own category anchor, which is what creates the regions.
   * Repulsion gets a finite range, because at `Infinity` every node pushes
   * every other one and no clustering force can win against it. Link stiffness
   * is set per edge type so containment dominates instead of losing to
   * similarity (see ATLAS_LINK_STRENGTH). And a collision force keeps spheres
   * from sitting inside one another.
   *
   * Depends on `size` because the graph is only mounted once a size is
   * measured — before that `graphRef` is empty and there is nothing to
   * configure.
   */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const anchorOf = (node: AtlasGraphNode, axis: "x" | "y" | "z") =>
      (anchors.get(node.node.sourceId) ?? anchors.get(ATLAS_ROOT_REGION)!)[axis];
    // Depth decides the pull: hard on a region's own root, barely anything
    // below it, so the directory tree spreads instead of collapsing onto the
    // anchor.
    const strengthOf = (node: AtlasGraphNode) => atlasAnchorStrength(node.node, node.depth);

    const linkForce = graph.d3Force("link") as
      | { distance?: (fn: (link: AtlasLink) => number) => unknown; strength?: (fn: (link: AtlasLink) => number) => unknown; iterations?: (n: number) => unknown }
      | undefined;
    linkForce?.distance?.((link) => atlasLinkDistance(link.type, subtreeOfTarget(link)));
    linkForce?.strength?.((link) => ATLAS_LINK_STRENGTH[link.type] ?? ATLAS_DEFAULT_LINK_STRENGTH);
    // Extra passes make the containment skeleton rigid enough to survive the
    // anchor pull; more than two costs more than it buys at this size.
    linkForce?.iterations?.(2);

    const charge = graph.d3Force("charge") as
      | { strength?: (fn: (node: AtlasGraphNode) => number) => unknown; distanceMax?: (value: number) => unknown }
      | undefined;
    charge?.strength?.((node) => atlasChargeStrength(node.degree));
    charge?.distanceMax?.(ATLAS_CHARGE_DISTANCE_MAX);

    graph.d3Force("center", null);
    graph.d3Force("x", forceX<AtlasGraphNode>((node) => anchorOf(node, "x")).strength(strengthOf));
    graph.d3Force("y", forceY<AtlasGraphNode>((node) => anchorOf(node, "y")).strength(strengthOf));
    graph.d3Force("z", forceZ<AtlasGraphNode>((node) => anchorOf(node, "z")).strength(strengthOf));
    // Enough to stop spheres sitting inside one another, not so much that it
    // packs a region into a shell and hides the tree inside it.
    graph.d3Force("collide", forceCollide<AtlasGraphNode>((node) => atlasNodeRadius(nodeValue(node), NODE_REL_SIZE)).strength(0.35));

    graph.d3ReheatSimulation();
  }, [anchors, graphData, size.width, size.height]);

  // Release the WebGL context on unmount. three's `dispose()` frees JS caches
  // but leaves the GPU context alive until the canvas is collected, and browsers
  // cap live contexts — enough 2D/3D toggles would blank the view.
  //
  // The dependency array MUST stay empty. It used to be `[size.width,
  // size.height]`, and React runs a cleanup on every dependency change, not
  // only on unmount — so the second ResizeObserver report (there is always one:
  // 0 → measured) tore down the renderer of a graph that was still mounted.
  // `dispose()` freed every GPU resource and the animation loop died with it,
  // which is why the view showed a full scene of 3 398 meshes with zero draw
  // calls, zero uploaded geometries, and every node object still sitting at the
  // origin because no tick ever ran to apply its coordinates.
  //
  // The ref is read inside the cleanup, so an empty array is also correct: it
  // resolves at teardown time rather than capturing an early undefined.
  useEffect(() => () => {
    try {
      const renderer = graphRef.current?.renderer() as
        { forceContextLoss?: () => void; dispose?: () => void } | undefined;
      renderer?.forceContextLoss?.();
      renderer?.dispose?.();
    } catch {
      // Teardown is best-effort; a failure here must not break unmounting.
    }
  }, []);

  /**
   * Revive the render loop when it is stuck.
   *
   * `requestAnimationFrame` does not fire while the document is hidden, and the
   * library schedules its loop at mount. If that happens while the window is
   * hidden, minimised, or occluded, its internal "running" flag stays set while
   * no frame is ever queued — and it never recovers, because `resumeAnimation()`
   * early-returns on that flag. The result is a full scene of thousands of
   * meshes with ZERO draw calls: every node object still sits at the origin
   * because no tick ran to apply its simulated coordinates. Measured live: the
   * renderer sat on frame 1 with 0 uploaded geometries, and one manual
   * `render()` immediately produced 3 398 draw calls.
   *
   * Pausing first is what makes the resume take effect — clearing the flag is
   * the whole point, so this is not a redundant pair.
   */
  const kickRenderLoop = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    try {
      graph.pauseAnimation();
      graph.resumeAnimation();
    } catch {
      // Best-effort recovery; never break the view trying to repair it.
    }
  }, []);

  useEffect(() => {
    if (!(size.width > 0 && size.height > 0)) return;
    // Once the graph has mounted, and again whenever the window becomes
    // visible — the two moments a stalled loop can be observed.
    const onVisible = () => { if (document.visibilityState === "visible") kickRenderLoop(); };
    const timer = setTimeout(kickRenderLoop, 300);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [kickRenderLoop, size.width, size.height]);

  const nodeColor = useCallback((node: AtlasGraphNode) => {
    if (highlighted && !highlighted.has(node.id as string)) return DIMMED_COLOR;
    // A folder is drawn in its region's colour, not a "folder" colour: the
    // useful question about a directory is which part of the workspace it
    // belongs to. That also makes every containment edge inside a region carry
    // that region's hue, since edges take the colour of what they lead to.
    if (node.node.kind === "folder") return atlasRegionColor(node.node.sourceId);
    return palette.nodes[node.node.kind] ?? DIMMED_COLOR;
  }, [highlighted, palette]);

  const nodeLabel = useCallback((node: AtlasGraphNode) =>
    `${node.node.title}${node.node.subtitle ? ` · ${node.node.subtitle}` : ""}`, []);

  /**
   * Draw directories as directories.
   *
   * Two problems, one object. A folder used to be a sphere in its region's
   * colour — and so is every file inside it, so `core/` and everything under
   * it were the same teal ball and the tree was invisible. And separating
   * categories in space only helps if you can name them, which `nodeLabel`
   * cannot: it is a hover tooltip.
   *
   * So a folder gets an octahedron, and a folder big enough to matter gets a
   * name plate. Only the big ones: a sprite costs a canvas texture and a draw
   * call apiece, which is fine for a few dozen and not for two and a half
   * thousand.
   *
   * Objects are cached because `nodeThreeObject` is re-invoked on every digest,
   * including every hover, and rebuilding canvas textures that often is a
   * visible stutter.
   */
  const folderObjects = useRef(new Map<string, Group>());
  useEffect(() => {
    const cache = folderObjects.current;
    return () => {
      for (const object of cache.values()) disposeAtlasFolderObject(object);
      cache.clear();
    };
  }, []);

  const nodeThreeObject = useCallback((node: AtlasGraphNode): Object3D => {
    // A falsy return is how the library is told to keep the default sphere; its
    // types insist on an Object3D, so the cast documents the contract rather
    // than fabricating an empty object per node.
    const useDefaultSphere = null as unknown as Object3D;
    if (node.node.kind !== "folder") return useDefaultSphere;
    const id = node.id as string;
    const cached = folderObjects.current.get(id);
    if (cached) return cached;

    const color = atlasRegionColor(node.node.sourceId);
    const radius = atlasNodeRadius(nodeValue(node), NODE_REL_SIZE);
    const height = node.depth <= 1 ? REGION_LABEL_HEIGHT : REGION_LABEL_HEIGHT * 0.58;
    const label = graphData.labelled.has(id)
      ? createAtlasLabelSprite(node.node.title, color, height)
      : undefined;
    const object = createAtlasFolderObject(radius, color, label);
    folderObjects.current.set(id, object);
    return object;
  }, [graphData.labelled]);

  /** Node lookup by id: used both to colour containment edges and to frame a
   *  selection made in the tree. */
  const nodesById = useMemo(() => new Map(graphData.nodes.map((node) => [node.id as string, node])), [graphData.nodes]);

  /**
   * Containment edges take the colour of what they lead TO, so a folder and
   * everything under it read as one hue and the eye can follow a subtree.
   * Every other type keeps its own colour, because there the relationship —
   * an import, a reference — is the information, not the destination.
   */
  const linkColor = useCallback((link: AtlasLink) => {
    if (link.type !== "contains") return ATLAS_EDGE_COLORS[link.type] ?? ATLAS_EDGE_COLORS.contains;
    const target = typeof link.target === "string" ? nodesById.get(link.target) : link.target;
    const node = target?.node;
    if (!node) return ATLAS_EDGE_COLORS.contains;
    // Directory edges take the REGION colour so a whole branch reads as one
    // hue from the root outward; leaf edges take the item's own kind, which is
    // where the distinction between a decision, a plan and a session matters.
    return node.kind === "folder"
      ? atlasRegionColor(node.sourceId)
      : palette.nodes[node.kind] ?? ATLAS_EDGE_COLORS.contains;
  }, [nodesById, palette]);

  /**
   * Point the camera at a box, from wherever it is already looking.
   *
   * Only the distance is computed; the viewing direction is preserved, so a
   * re-frame never undoes a rotation the user just made.
   */
  const frameBox = useCallback((center: { x: number; y: number; z: number }, extent: number, durationMs: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    const camera = graph.camera() as { fov?: number; position?: { x: number; y: number; z: number } };
    const distance = atlasFitDistance(
      extent / 2,
      camera?.fov ?? 50,
      size.height > 0 ? size.width / size.height : 1,
    );
    const from = camera?.position;
    const offset = from
      ? { x: from.x - center.x, y: from.y - center.y, z: from.z - center.z }
      : { x: 0, y: 0, z: 1 };
    // A camera sitting exactly on the target has no direction to pull back
    // along; fall back to the z axis rather than dividing by zero.
    const magnitude = Math.hypot(offset.x, offset.y, offset.z);
    const unit = magnitude < 1e-6
      ? { x: 0, y: 0, z: 1 }
      : { x: offset.x / magnitude, y: offset.y / magnitude, z: offset.z / magnitude };
    graph.cameraPosition({
      x: center.x + unit.x * distance,
      y: center.y + unit.y * distance,
      z: center.z + unit.z * distance,
    }, center, durationMs);
  }, [size.width, size.height]);

  /**
   * Frame a node's whole BRANCH, not the node.
   *
   * Selecting a directory should show what it holds — that is the question
   * being asked. And the fixed 120-unit pull-back this replaces was calibrated
   * when nodes were under a pixel; now that a folder can be 30 units across and
   * its children sit right beside it, 120 units put the camera INSIDE the
   * cluster, filling the screen with the inside of a sphere.
   */
  const focusNode = useCallback((node: AtlasGraphNode | null) => {
    if (!node || node.x == null) return;
    // Descendants only — see atlasDescendants for why the ancestors, which the
    // highlight does include, must stay out of the framing box.
    const framed = atlasDescendants(node.id as string, graphData.hierarchy);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const candidate of graphData.nodes) {
      if (candidate.x == null || !framed.has(candidate.id as string)) continue;
      const radius = atlasNodeRadius(nodeValue(candidate), NODE_REL_SIZE);
      minX = Math.min(minX, candidate.x - radius); maxX = Math.max(maxX, candidate.x + radius);
      minY = Math.min(minY, (candidate.y ?? 0) - radius); maxY = Math.max(maxY, (candidate.y ?? 0) + radius);
      minZ = Math.min(minZ, (candidate.z ?? 0) - radius); maxZ = Math.max(maxZ, (candidate.z ?? 0) + radius);
    }
    if (!Number.isFinite(minX)) return;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, MIN_FOCUS_EXTENT);
    frameBox({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }, extent, 600);
  }, [frameBox, graphData.hierarchy, graphData.nodes]);

  useEffect(() => {
    if (!selectedId) return;
    const node = nodesById.get(selectedId);
    if (node) focusNode(node);
  }, [selectedId, nodesById, focusNode]);

  /**
   * Fit the camera to the graph once the simulation settles.
   *
   * Nothing used to do this: the camera stayed at the library's default
   * distance while d3-force spread a large graph across thousands of units, so
   * a big Atlas rendered as an empty black viewport — the scene was fine, the
   * camera was simply nowhere near it. `focusNode` did not cover the gap
   * either: it bails when the node has no coordinates yet, which is exactly the
   * case on first render.
   *
   * Fires once per node set, and never over a deliberate selection.
   */
  const fittedFor = useRef<number>(-1);
  const fittedExtent = useRef<number>(0);
  useEffect(() => {
    fittedFor.current = -1; // a new node set has to be framed again
    fittedExtent.current = 0;
  }, [graphData.nodes]);

  const fitToGraph = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const bbox = graph.getGraphBbox?.();
    const extent = bbox
      ? Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], bbox.z[1] - bbox.z[0])
      : 0;
    const plan = atlasCameraPlan({
      nodeCount: graphData.nodes.length,
      fittedForCount: fittedFor.current,
      selectedInGraph: Boolean(selectedId && nodesById.has(selectedId)),
      graphExtent: extent,
      fittedExtent: fittedExtent.current,
    });
    if (plan === "skip") return;
    fittedFor.current = graphData.nodes.length;
    fittedExtent.current = extent;
    if (plan === "focus-selection") {
      focusNode(nodesById.get(selectedId!) ?? null);
      return;
    }
    if (!bbox) return;
    // Frame it by computing the distance rather than calling `zoomToFit` —
    // see atlasFitDistance for why the library's own fit lands twice too far.
    frameBox({
      x: (bbox.x[0] + bbox.x[1]) / 2,
      y: (bbox.y[0] + bbox.y[1]) / 2,
      z: (bbox.z[0] + bbox.z[1]) / 2,
    }, extent, 400);
  }, [graphData.nodes.length, selectedId, nodesById, focusNode, frameBox]);

  // `onEngineStop` is the reliable signal, but a heavy graph can keep ticking
  // for a long time — fit early too so the user is never left facing a void.
  // The early fits also have to REPEAT: the first one lands while the layout is
  // still contracting, and on a graph this size the engine can run for another
  // fifteen seconds, ending with the finished layout framed for a fraction of
  // its final size. `atlasCameraPlan` re-frames only when the graph has
  // genuinely outgrown its framing, so these extra passes are free otherwise.
  useEffect(() => {
    if (!(size.width > 0 && size.height > 0) || graphData.nodes.length === 0) return;
    const timers = [1_200, 3_000, 6_000, 10_000].map((delay) => setTimeout(fitToGraph, delay));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [fitToGraph, graphData.nodes.length, size.width, size.height]);

  return (
    <div
      ref={containerRef}
      role="application"
      tabIndex={0}
      aria-label={t("shell.memory.graphLabel3d")}
      className="relative size-full min-h-[24rem] overflow-hidden bg-bg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/45"
    >
      {size.width > 0 && size.height > 0 && (
        <ForceGraph3D<AtlasNodeData, AtlasLink>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeColor={nodeColor}
          nodeVal={nodeValue}
          nodeLabel={nodeLabel}
          nodeOpacity={0.92}
          nodeRelSize={NODE_REL_SIZE}
          nodeResolution={heavy ? 6 : 12}
          // Extend, not replace: a region root keeps its sphere and gains a
          // name plate above it.
          // Replaces the sphere for folders; every other node returns nothing
          // and keeps the default.
          nodeThreeObject={nodeThreeObject}
          linkColor={linkColor}
          linkWidth={linkWidth}
          // The single place transparency is set — see ATLAS_EDGE_COLORS.
          linkOpacity={0.55}
          enableNodeDrag={!heavy}
          warmupTicks={heavy ? 20 : 40}
          onEngineStop={fitToGraph}
          onNodeClick={(node: AtlasGraphNode) => { onSelect(node.id as string); focusNode(node); }}
          onNodeHover={(node: AtlasGraphNode | null) => setHoverId(node ? (node.id as string) : null)}
          onBackgroundClick={() => onSelect(null)}
        />
      )}
      {matchedIds.size > 0 && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-primary/30 bg-surface/85 px-2 py-1 text-[9px] text-secondary backdrop-blur">
          {t("shell.memory.matchCount", { count: matchedIds.size })}
        </div>
      )}
      {/* Where the focused node lives, spelled out. The scene highlights its
          branch, but a highlight cannot be read as a path — this can, and it
          works the same for a file, a directory, or a chat session. */}
      {focusPath.length > 1 && (
        <div className="pointer-events-none absolute inset-x-3 bottom-8 mx-auto w-fit max-w-[92%] truncate rounded-md border border-border-soft bg-surface/90 px-2.5 py-1 font-mono text-[10px] text-secondary backdrop-blur">
          {focusPath.join("  ›  ")}
        </div>
      )}
    </div>
  );
}
