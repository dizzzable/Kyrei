import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-3d";

import { useI18n } from "@/i18n";
import { useThemeId } from "@/lib/theme";
import type { MemoryAtlasNode, MemoryAtlasSnapshot } from "@/lib/types";
import { ATLAS_EDGE_COLORS, atlasNodePalette } from "./memory-atlas-colors";
import { atlasCameraPlan } from "./memory-atlas-viewport";

type AtlasEdgeType = MemoryAtlasSnapshot["edges"][number]["type"];
type AtlasGraphNode = NodeObject<{ node: MemoryAtlasNode; degree: number }>;
// force-graph mutates links in place, replacing each id with the node object,
// so both forms are observable at runtime.
type AtlasLink = { source: string | AtlasGraphNode; target: string | AtlasGraphNode; type: AtlasEdgeType };

// Link physics per edge type: structural edges pull tight, semantic `related`
// edges stay loose so clusters spread into a readable web.
const LINK_DISTANCE: Record<AtlasEdgeType, number> = {
  contains: 40,
  imports: 30,
  references: 55,
  related: 90,
};
const DEFAULT_LINK_DISTANCE = 60;

/** Perf ceiling: above this node count, drop mesh detail and dragging. */
const HEAVY_NODE_COUNT = 1_500;

/** Colour for nodes outside the current focus/search set. */
const DIMMED_COLOR = "rgba(120,120,130,0.18)";

// Hoisted so their identity is stable across renders. react-force-graph
// re-digests every link whenever an accessor's identity changes, which would
// otherwise rebuild all link geometry on every hover.
const linkWidth = (link: AtlasLink) => (link.type === "related" ? 0.4 : 0.8);

function endpointId(endpoint: string | AtlasGraphNode): string | undefined {
  return typeof endpoint === "string" ? endpoint : (endpoint.id as string | undefined);
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
    const graphNodes: AtlasGraphNode[] = nodes.map((node) => ({ id: node.id, node, degree: degree.get(node.id) ?? 0 }));
    return { nodes: graphNodes, links };
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

  // Nodes kept at full strength. Hover/selection wins; otherwise an active
  // search narrows the graph to its matches, mirroring the 2D view.
  const focusId = hoverId ?? selectedId;
  const highlighted = useMemo(() => {
    if (focusId) {
      const set = new Set<string>([focusId]);
      for (const link of graphData.links) {
        const source = endpointId(link.source);
        const target = endpointId(link.target);
        if (source === focusId && target) set.add(target);
        if (target === focusId && source) set.add(source);
      }
      return set;
    }
    return matchedIds.size > 0 ? matchedIds : null;
  }, [focusId, graphData.links, matchedIds]);

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

  // Tune link distance by edge type. Depends on size because the graph is only
  // mounted once the ResizeObserver reports one — before that `graphRef` is
  // still empty and there is nothing to configure.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const linkForce = graph.d3Force("link");
    if (linkForce && typeof (linkForce as { distance?: unknown }).distance === "function") {
      (linkForce as unknown as { distance: (fn: (link: AtlasLink) => number) => void })
        .distance((link) => LINK_DISTANCE[link.type] ?? DEFAULT_LINK_DISTANCE);
      graph.d3ReheatSimulation();
    }
  }, [graphData, size.width, size.height]);

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
    return palette.nodes[node.node.kind] ?? DIMMED_COLOR;
  }, [highlighted, palette]);

  const nodeVal = useCallback((node: AtlasGraphNode) => {
    if (node.node.kind === "project") return 12;
    // Scale by connectivity so hubs read as larger.
    return Math.max(1, Math.min(10, 1.5 + node.degree * 0.6));
  }, []);

  const nodeLabel = useCallback((node: AtlasGraphNode) =>
    `${node.node.title}${node.node.subtitle ? ` · ${node.node.subtitle}` : ""}`, []);

  // One colour per edge type, so an edge says WHAT KIND of connection it is.
  // `contains`, `imports` and `references` used to share two near-identical
  // greys, which showed that things were connected but never how.
  const linkColor = useCallback((link: AtlasLink) =>
    ATLAS_EDGE_COLORS[link.type] ?? ATLAS_EDGE_COLORS.contains, []);

  const focusNode = useCallback((node: AtlasGraphNode | null) => {
    const graph = graphRef.current;
    if (!graph || !node || node.x == null) return;
    const distance = 120;
    const x = node.x;
    const y = node.y ?? 0;
    const z = node.z ?? 0;
    const magnitude = Math.hypot(x, y, z);
    // A node sitting exactly at the origin has no direction to pull back along,
    // so offset on z instead — otherwise the camera lands inside the node.
    const camera = magnitude < 1e-6
      ? { x: 0, y: 0, z: distance }
      : { x: x * (1 + distance / magnitude), y: y * (1 + distance / magnitude), z: z * (1 + distance / magnitude) };
    graph.cameraPosition(camera, { x, y, z }, 600);
  }, []);

  // Frame the selection even when it came from the tree rather than a click.
  const nodesById = useMemo(() => new Map(graphData.nodes.map((node) => [node.id as string, node])), [graphData.nodes]);
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
  useEffect(() => {
    fittedFor.current = -1; // a new node set has to be framed again
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
    });
    if (plan === "skip") return;
    fittedFor.current = graphData.nodes.length;
    if (plan === "focus-selection") focusNode(nodesById.get(selectedId!) ?? null);
    else graph.zoomToFit(400, 60);
  }, [graphData.nodes.length, selectedId, nodesById, focusNode]);

  // `onEngineStop` is the reliable signal, but a heavy graph can keep ticking
  // for a long time — fit early too so the user is never left facing a void.
  useEffect(() => {
    if (!(size.width > 0 && size.height > 0) || graphData.nodes.length === 0) return;
    const timer = setTimeout(fitToGraph, 1_200);
    return () => clearTimeout(timer);
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
        <ForceGraph3D<{ node: MemoryAtlasNode; degree: number }, AtlasLink>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeColor={nodeColor}
          nodeVal={nodeVal}
          nodeLabel={nodeLabel}
          nodeOpacity={0.92}
          // Sphere radius is `cbrt(nodeVal) * nodeRelSize` in WORLD units, so
          // it has to be read against the layout's scale. A graph of this size
          // spreads across ~2 600 units; at the library default of 4 a node is
          // under a pixel once the camera frames the whole thing, which reads
          // as an empty canvas even though everything is drawn correctly.
          nodeRelSize={12}
          nodeResolution={heavy ? 6 : 12}
          linkColor={linkColor}
          linkWidth={linkWidth}
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
    </div>
  );
}
