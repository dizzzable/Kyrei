import { Focus, Map as MapIcon, Minus, Plus, RotateCcw, ScanSearch } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import type { MemoryAtlasNode, MemoryAtlasSnapshot } from "@/lib/types";
import { layoutMemoryGraph } from "./memory-graph-layout";
import { fitViewport, panViewport, zoomViewportAt, type AtlasViewport, type Point } from "./memory-atlas-viewport";

type DragState = { kind: "pan"; pointerId: number; x: number; y: number } | { kind: "node"; pointerId: number; id: string };

function graphGroup(kind: MemoryAtlasNode["kind"]): "project" | "code" | "document" | "decision" | "plan" | "handoff" | "session" | "memory" {
  return kind === "skill" || kind === "evolution" ? "memory" : kind;
}

function color(node: MemoryAtlasNode): string {
  if (node.kind === "project") return "var(--color-foreground)";
  if (node.kind === "code") return "var(--color-muted)";
  if (node.kind === "document") return "var(--color-primary)";
  if (node.kind === "decision") return "var(--color-success)";
  if (node.kind === "plan") return "var(--color-warning)";
  if (node.kind === "handoff") return "var(--color-danger)";
  if (node.kind === "skill") return "var(--color-primary)";
  if (node.kind === "session") return "var(--color-secondary)";
  return "var(--color-faint)";
}

export function MemoryAtlasCanvas({
  nodes,
  edges,
  selectedId,
  matchedIds,
  viewport,
  pinned,
  onSelect,
  onViewportChange,
  onPinnedChange,
}: {
  nodes: readonly MemoryAtlasNode[];
  edges: Array<MemoryAtlasSnapshot["edges"][number]>;
  selectedId: string | null;
  matchedIds: ReadonlySet<string>;
  viewport: AtlasViewport;
  pinned: Readonly<Record<string, Point>>;
  onSelect: (id: string | null) => void;
  onViewportChange: (viewport: AtlasViewport) => void;
  onPinnedChange: (pinned: Record<string, Point>) => void;
}) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [minimap, setMinimap] = useState(true);
  const graphNodes = useMemo(() => nodes.map((node) => ({ ...node, group: graphGroup(node.kind) })), [nodes]);
  const graphEdges = useMemo(() => edges.filter((edge) => edge.type !== "related").map((edge) => ({ source: edge.source, target: edge.target, type: edge.type as "imports" | "contains" | "references" })), [edges]);
  const layout = useMemo(() => layoutMemoryGraph(graphNodes, graphEdges), [graphEdges, graphNodes]);
  const positioned = useMemo(() => layout.nodes.map((node) => ({ ...node, ...(pinned[node.id] ?? {}) })), [layout.nodes, pinned]);
  const positions = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);
  const sourceNodes = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const localPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const graphPoint = (clientX: number, clientY: number) => {
    const point = localPoint(clientX, clientY);
    return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
  };
  const fit = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !positioned.length) return;
    const minX = Math.min(...positioned.map((node) => node.x - node.radius));
    const minY = Math.min(...positioned.map((node) => node.y - node.radius));
    const maxX = Math.max(...positioned.map((node) => node.x + node.radius));
    const maxY = Math.max(...positioned.map((node) => node.y + node.radius));
    onViewportChange(fitViewport(rect, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 48));
  };
  const fitSelected = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    const selected = selectedId ? positions.get(selectedId) : undefined;
    if (!rect || !selected) return;
    const scale = Math.min(2.2, Math.max(1.2, viewport.scale));
    onViewportChange({ scale, x: rect.width / 2 - selected.x * scale, y: rect.height / 2 - selected.y * scale });
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (event.shiftKey) {
      onViewportChange(panViewport(viewport, -event.deltaY, 0));
      return;
    }
    const point = localPoint(event.clientX, event.clientY);
    onViewportChange(zoomViewportAt(viewport, viewport.scale * Math.exp(-event.deltaY * 0.0015), point));
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const center = { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
    if (event.key === "+" || event.key === "=") onViewportChange(zoomViewportAt(viewport, viewport.scale * 1.2, center));
    else if (event.key === "-") onViewportChange(zoomViewportAt(viewport, viewport.scale / 1.2, center));
    else if (event.key === "ArrowLeft") onViewportChange(panViewport(viewport, 32, 0));
    else if (event.key === "ArrowRight") onViewportChange(panViewport(viewport, -32, 0));
    else if (event.key === "ArrowUp") onViewportChange(panViewport(viewport, 0, 32));
    else if (event.key === "ArrowDown") onViewportChange(panViewport(viewport, 0, -32));
    else if (event.key === "0") fit();
    else if (event.key.toLocaleLowerCase() === "f") fitSelected();
    else if (event.key === "Escape") onSelect(null);
    else return;
    event.preventDefault();
  };
  const startPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: "pan", pointerId: event.pointerId, x: event.clientX, y: event.clientY });
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "pan") {
      onViewportChange(panViewport(viewport, event.clientX - drag.x, event.clientY - drag.y));
      setDrag({ ...drag, x: event.clientX, y: event.clientY });
    } else {
      onPinnedChange({ ...pinned, [drag.id]: graphPoint(event.clientX, event.clientY) });
    }
  };
  const stop = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag?.pointerId === event.pointerId) setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className="relative size-full min-h-[24rem] overflow-hidden bg-bg/40">
      <div className="pointer-events-none absolute inset-0 opacity-35" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, var(--color-border) 1px, transparent 0)", backgroundSize: "22px 22px" }} />
      <svg
        ref={svgRef}
        className="relative size-full touch-none"
        role="application"
        tabIndex={0}
        aria-label={t("shell.memory.graphLabel")}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerDown={startPan}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onDoubleClick={(event) => { if (event.target === event.currentTarget) fit(); }}
      >
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {layout.edges.map((edge, index) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            return <line key={`${edge.source}-${edge.target}-${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={edge.type === "references" ? "var(--color-primary)" : "var(--color-border)"} strokeOpacity={edge.type === "references" ? 0.38 : 0.25} vectorEffect="non-scaling-stroke" />;
          })}
          {positioned.map((node) => {
            const source = sourceNodes.get(node.id)!;
            const selected = node.id === selectedId;
            return (
              <g
                key={node.id}
                className="cursor-grab"
                onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (rect) onViewportChange(zoomViewportAt({ ...viewport, x: rect.width / 2 - node.x * viewport.scale, y: rect.height / 2 - node.y * viewport.scale }, Math.max(1.4, viewport.scale), { x: rect.width / 2, y: rect.height / 2 }));
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  svgRef.current?.setPointerCapture(event.pointerId);
                  setDrag({ kind: "node", pointerId: event.pointerId, id: node.id });
                  onSelect(node.id);
                }}
              >
                {(selected || matchedIds.has(node.id)) && <circle cx={node.x} cy={node.y} r={node.radius + (selected ? 7 : 4)} fill="none" stroke={selected ? "var(--color-foreground)" : "var(--color-primary)"} strokeWidth={selected ? 1.6 : 1} vectorEffect="non-scaling-stroke" />}
                <circle cx={node.x} cy={node.y} r={node.radius} fill={color(source)} fillOpacity={selected ? 1 : 0.82} stroke="var(--color-bg)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                {(source.kind === "project" || selected) && <text x={node.x + node.radius + 6} y={node.y + 3} fill="var(--color-secondary)" fontSize={9 / Math.max(0.7, viewport.scale)}>{node.title.slice(0, 32)}</text>}
                <title>{source.path ?? source.title}</title>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-border bg-surface/90 p-1 shadow-sm backdrop-blur">
        <Button size="icon-xs" variant="ghost" onClick={() => onViewportChange(zoomViewportAt(viewport, viewport.scale / 1.2, { x: 0, y: 0 }))} aria-label={t("shell.memory.zoomOut")}><Minus className="size-3.5" /></Button>
        <span className="w-10 text-center font-mono text-[9px] text-muted">{Math.round(viewport.scale * 100)}%</span>
        <Button size="icon-xs" variant="ghost" onClick={() => onViewportChange(zoomViewportAt(viewport, viewport.scale * 1.2, { x: 0, y: 0 }))} aria-label={t("shell.memory.zoomIn")}><Plus className="size-3.5" /></Button>
        <Button size="icon-xs" variant="ghost" onClick={fit} aria-label={t("shell.memory.fit")}><Focus className="size-3.5" /></Button>
        <Button size="icon-xs" variant="ghost" onClick={fitSelected} disabled={!selectedId} aria-label={t("shell.memory.fitSelection")}><ScanSearch className="size-3.5" /></Button>
        <Button size="icon-xs" variant="ghost" onClick={() => { onPinnedChange({}); onViewportChange({ scale: 1, x: 0, y: 0 }); }} aria-label={t("shell.memory.resetLayout")}><RotateCcw className="size-3.5" /></Button>
        <Button size="icon-xs" variant="ghost" aria-pressed={minimap} onClick={() => setMinimap((value) => !value)} aria-label={t("shell.memory.toggleMinimap")}><MapIcon className="size-3.5" /></Button>
      </div>
      {minimap && <div className="pointer-events-none absolute bottom-3 right-3 h-20 w-28 overflow-hidden rounded-md border border-border bg-surface/85">
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="size-full opacity-75" aria-hidden>
          {positioned.map((node) => <circle key={node.id} cx={node.x} cy={node.y} r={Math.max(5, node.radius * 1.5)} fill={color(sourceNodes.get(node.id)!)} />)}
          {svgRef.current && <rect
            x={-viewport.x / viewport.scale}
            y={-viewport.y / viewport.scale}
            width={svgRef.current.clientWidth / viewport.scale}
            height={svgRef.current.clientHeight / viewport.scale}
            fill="none"
            stroke="var(--color-foreground)"
            strokeWidth={8 / viewport.scale}
          />}
        </svg>
      </div>}
    </div>
  );
}
