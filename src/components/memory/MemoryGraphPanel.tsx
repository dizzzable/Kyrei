import {
  BrainCircuit,
  FileJson2,
  FileText,
  Focus,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import { bufferToBase64, importConversationFile } from "@/lib/session-import-api";
import type { MemoryGraphGroup, MemoryGraphNode, WorkspaceMemoryGraph } from "@/lib/types";
import { cn } from "@/lib/utils";
import { layoutMemoryGraph } from "./memory-graph-layout";

interface MemoryGraphPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
}

const DOCUMENT_ACCEPT = ".md,.mdx,.markdown,.txt,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv";
const SESSION_ACCEPT = ".json,.jsonl,.md,.txt,application/json,text/markdown,text/plain";
const MAX_DOCUMENT_TOTAL = 12 * 1024 * 1024;
const GROUPS: MemoryGraphGroup[] = ["code", "document", "decision", "plan", "handoff", "session", "memory"];

export function MemoryGraphPanel({ open, onClose, onOpenSession }: MemoryGraphPanelProps) {
  const { t, date, number } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const [graph, setGraph] = useState<WorkspaceMemoryGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"documents" | "session" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<MemoryGraphGroup | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await gateway.getMemoryGraph();
      setGraph(next);
      setSelectedId((current) => current && next.nodes.some((node) => node.id === current) ? current : null);
    } catch (reason) {
      setError(errorText(reason, t("shell.memory.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const hadInert = shell?.hasAttribute("inert") ?? false;
    const previousAriaHidden = shell?.getAttribute("aria-hidden");
    shell?.setAttribute("inert", "");
    shell?.setAttribute("aria-hidden", "true");
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      if (!hadInert) shell?.removeAttribute("inert");
      if (previousAriaHidden == null) shell?.removeAttribute("aria-hidden");
      else shell?.setAttribute("aria-hidden", previousAriaHidden);
      previouslyFocused?.focus();
    };
  }, [onClose, open]);

  const importDocuments = useCallback(async (files: readonly File[]) => {
    if (!files.length || busy) return;
    setBusy("documents");
    setError(null);
    setNotice(null);
    try {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (total > MAX_DOCUMENT_TOTAL) throw new Error("document_payload_too_large");
      const encoded = await Promise.all(files.slice(0, 24).map(async (file) => ({
        fileName: file.name,
        contentBase64: bufferToBase64(await file.arrayBuffer()),
      })));
      const result = await gateway.importProjectDocuments(encoded);
      setNotice(t("shell.memory.documentsImported", { count: number(result.imported.length) }));
      await refresh();
    } catch (reason) {
      setError(errorText(reason, t("shell.memory.documentsFailed")));
    } finally {
      setBusy(null);
      if (documentInputRef.current) documentInputRef.current.value = "";
    }
  }, [busy, number, refresh, t]);

  const importSession = useCallback(async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy("session");
    setError(null);
    setNotice(null);
    try {
      const result = await importConversationFile(file);
      window.dispatchEvent(new CustomEvent("kyrei:sessions-refresh"));
      setNotice(t("shell.memory.sessionImported", {
        count: number(result.report.messageCount),
        adapter: result.report.adapterId,
      }));
      await refresh();
      if (result.sessionId && onOpenSession) onOpenSession(result.sessionId);
    } catch (reason) {
      setError(errorText(reason, t("shell.memory.sessionFailed")));
    } finally {
      setBusy(null);
      if (sessionInputRef.current) sessionInputRef.current.value = "";
    }
  }, [busy, number, onOpenSession, refresh, t]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleNodes = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.filter((node) => {
      if (node.group === "project") return true;
      if (activeGroup !== "all" && node.group !== activeGroup) return false;
      if (!normalizedQuery) return true;
      return `${node.title} ${node.path ?? ""} ${node.subtitle ?? ""} ${node.preview ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [activeGroup, graph, normalizedQuery]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const layout = useMemo(() => layoutMemoryGraph(
    visibleNodes,
    (graph?.edges ?? []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
  ), [graph?.edges, visibleIds, visibleNodes]);
  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes]);
  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void importDocuments([...event.dataTransfer.files]);
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-x-0 top-[var(--app-titlebar-h)] bottom-[var(--app-statusbar-h)] z-[115] grid min-h-0 place-items-center bg-bg p-3 sm:p-5">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full min-h-0 w-full max-w-[92rem] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-nous"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <BrainCircuit className="size-4.5" aria-hidden />
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-success ring-2 ring-surface" aria-hidden />
          </div>
          <div className="min-w-48 flex-1">
            <h2 id={titleId} className="text-[14px] font-semibold text-foreground">{t("shell.memory.title")}</h2>
            <p className="mt-0.5 truncate text-[10px] text-muted">{graph?.workspace ?? t("shell.memory.subtitle")}</p>
          </div>
          <label className="relative order-last w-full sm:order-none sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-full rounded-md border border-border bg-bg pl-8 pr-8 text-[11px] text-foreground outline-none placeholder:text-faint focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
              placeholder={t("shell.memory.search")}
              aria-label={t("shell.memory.search")}
            />
            {query && <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground" aria-label={t("common.clear")}><X className="size-3" /></button>}
          </label>
          <input ref={sessionInputRef} type="file" accept={SESSION_ACCEPT} className="hidden" onChange={(event) => void importSession(event.target.files?.[0])} />
          <input ref={documentInputRef} type="file" accept={DOCUMENT_ACCEPT} multiple className="hidden" onChange={(event) => void importDocuments([...(event.target.files ?? [])])} />
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => sessionInputRef.current?.click()}>
            {busy === "session" ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileJson2 className="size-3.5" />}
            {t("shell.memory.importSession")}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => documentInputRef.current?.click()}>
            {busy === "documents" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {t("shell.memory.addDocuments")}
          </Button>
          <button ref={closeRef} type="button" onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted hover:bg-(--ui-row-hover) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45" aria-label={t("shell.memory.close")}>
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {(error || notice) && <div role={error ? "alert" : "status"} className={cn(
          "mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-[10.5px] sm:mx-5",
          error ? "border-danger/30 bg-danger/8 text-danger" : "border-success/30 bg-success/8 text-secondary",
        )}>{error ?? notice}<button type="button" className="ml-auto text-faint hover:text-foreground" onClick={() => { setError(null); setNotice(null); }}><X className="size-3" /></button></div>}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-soft px-4 py-2 sm:px-5">
            <FilterChip active={activeGroup === "all"} onClick={() => setActiveGroup("all")} label={t("shell.memory.group.all")} count={graph?.nodes.length ?? 0} />
            {GROUPS.map((group) => <FilterChip key={group} active={activeGroup === group} onClick={() => setActiveGroup(group)} label={groupLabel(group, t)} count={graph?.nodes.filter((node) => node.group === group).length ?? 0} />)}
            <span className="ml-auto hidden font-mono text-[9px] text-faint md:inline">{graph ? t("shell.memory.generated", { value: date(Date.parse(graph.generatedAt), { timeStyle: "short" }) }) : ""}</span>
            <Button size="icon-xs" variant="ghost" onClick={() => void refresh()} disabled={loading} aria-label={t("shell.memory.refresh")} title={t("shell.memory.refresh")}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></Button>
          </div>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div
              className={cn("relative min-h-[24rem] overflow-hidden bg-bg/40", dragging && "ring-2 ring-inset ring-primary/60")}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
              onDrop={onDrop}
            >
              <div className="pointer-events-none absolute inset-0 opacity-35" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, var(--color-border) 1px, transparent 0)", backgroundSize: "22px 22px" }} />
              {loading && !graph ? <div className="absolute inset-0 z-10 grid place-items-center"><LoaderCircle className="size-5 animate-spin text-muted" /></div> : (
                <svg className="relative size-full min-h-[24rem]" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={t("shell.memory.graphLabel")}>
                  <g transform={`translate(${layout.width * (1 - zoom) / 2} ${layout.height * (1 - zoom) / 2}) scale(${zoom})`}>
                    {layout.edges.map((edge, index) => {
                      const source = positions.get(edge.source);
                      const target = positions.get(edge.target);
                      if (!source || !target) return null;
                      return <line key={`${edge.source}-${edge.target}-${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={edge.type === "references" ? "var(--color-primary)" : "var(--color-border)"} strokeOpacity={edge.type === "references" ? 0.38 : 0.28} strokeWidth={edge.type === "references" ? 1.2 : 0.8} />;
                    })}
                    {layout.nodes.map((node) => <GraphNode key={node.id} node={node} selected={node.id === selectedId} matched={Boolean(normalizedQuery && node.id !== "project:root")} onSelect={() => setSelectedId(node.id)} />)}
                  </g>
                </svg>
              )}
              {dragging && <div className="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-xl border border-dashed border-primary/70 bg-bg/90"><div className="text-center"><Upload className="mx-auto size-6 text-primary" /><p className="mt-2 text-[12px] font-medium text-foreground">{t("shell.memory.dropDocuments")}</p><p className="mt-1 text-[10px] text-muted">{t("shell.memory.documentFormats")}</p></div></div>}
              <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-border bg-surface/90 p-1 shadow-sm backdrop-blur">
                <Button size="icon-xs" variant="ghost" onClick={() => setZoom((value) => Math.max(0.7, value - 0.15))} aria-label={t("shell.memory.zoomOut")}><Minus className="size-3.5" /></Button>
                <span className="w-10 text-center font-mono text-[9px] text-muted">{Math.round(zoom * 100)}%</span>
                <Button size="icon-xs" variant="ghost" onClick={() => setZoom((value) => Math.min(1.8, value + 0.15))} aria-label={t("shell.memory.zoomIn")}><Plus className="size-3.5" /></Button>
                <Button size="icon-xs" variant="ghost" onClick={() => setZoom(1)} aria-label={t("shell.memory.fit")}><Focus className="size-3.5" /></Button>
              </div>
              {!loading && visibleNodes.length <= 1 && <div className="pointer-events-none absolute inset-0 grid place-items-center"><div className="max-w-sm text-center"><BrainCircuit className="mx-auto size-6 text-muted" /><p className="mt-2 text-[12px] font-medium text-secondary">{t("shell.memory.empty")}</p><p className="mt-1 text-[10px] leading-4 text-muted">{t("shell.memory.emptyHint")}</p></div></div>}
            </div>

            <aside className="min-h-0 overflow-y-auto border-t border-border bg-surface lg:border-l lg:border-t-0">
              <Inspector selected={selected} graph={graph} t={t} formatNumber={number} />
            </aside>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GraphNode({ node, selected, matched, onSelect }: { node: ReturnType<typeof layoutMemoryGraph>["nodes"][number]; selected: boolean; matched: boolean; onSelect: () => void }) {
  const fill = groupColor(node.group);
  return <g role="button" tabIndex={0} aria-label={node.title} onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }} className="cursor-pointer outline-none">
    {(selected || matched) && <circle cx={node.x} cy={node.y} r={node.radius + (selected ? 7 : 4)} fill="none" stroke={selected ? "var(--color-foreground)" : "var(--color-primary)"} strokeOpacity={selected ? 0.8 : 0.45} strokeWidth={selected ? 1.6 : 1} />}
    <circle cx={node.x} cy={node.y} r={node.radius} fill={fill} fillOpacity={selected ? 1 : 0.82} stroke="var(--color-bg)" strokeWidth={1.5} />
    {(node.group === "project" || selected) && <text x={node.x + node.radius + 6} y={node.y + 3} fill="var(--color-secondary)" fontSize={9} fontFamily="ui-monospace, monospace">{node.title.slice(0, 28)}</text>}
    <title>{node.path ?? node.title}</title>
  </g>;
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn("flex h-6 items-center gap-1.5 rounded-md border px-2 text-[9.5px] transition-colors", active ? "border-primary/35 bg-primary/10 text-foreground" : "border-border-soft text-muted hover:bg-(--ui-row-hover) hover:text-secondary")}>
    {label}<span className="font-mono text-[8px] opacity-65">{count}</span>
  </button>;
}

type I18nApi = ReturnType<typeof useI18n>;

interface InspectorProps {
  selected: MemoryGraphNode | null;
  graph: WorkspaceMemoryGraph | null;
  t: I18nApi["t"];
  formatNumber: I18nApi["number"];
}

function Inspector({ selected, graph, t, formatNumber }: InspectorProps) {
  if (selected) return <div className="p-4">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 size-2.5 shrink-0 rounded-full" style={{ background: groupColor(selected.group) }} />
      <div className="min-w-0"><div className="text-[9px] font-medium uppercase tracking-[0.13em] text-muted">{groupLabel(selected.group, t)}</div><h3 className="mt-1 break-words text-[13px] font-semibold text-foreground">{selected.title}</h3></div>
    </div>
    {selected.path && <div className="mt-4 break-all rounded-md border border-border-soft bg-bg/50 px-2.5 py-2 font-mono text-[9px] leading-4 text-secondary">{selected.path}</div>}
    {selected.subtitle && <p className="mt-3 text-[10px] leading-4 text-muted">{selected.subtitle}</p>}
    {selected.preview && <div className="mt-4 border-t border-border-soft pt-4"><h4 className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted">{t("shell.memory.preview")}</h4><p className="mt-2 whitespace-pre-wrap text-[10.5px] leading-5 text-secondary">{selected.preview}</p></div>}
  </div>;
  return <div className="p-4">
    <div className="flex items-center gap-2"><BrainCircuit className="size-4 text-primary" /><h3 className="text-[12px] font-semibold text-foreground">{t("shell.memory.overview")}</h3></div>
    <p className="mt-2 text-[10px] leading-4 text-muted">{t("shell.memory.overviewHint")}</p>
    <div className="mt-5 grid grid-cols-2 gap-2">
      <Stat label={t("shell.memory.stat.code")} value={graph?.stats.code ?? 0} formatNumber={formatNumber} />
      <Stat label={t("shell.memory.stat.documents")} value={graph?.stats.documents ?? 0} formatNumber={formatNumber} />
      <Stat label={t("shell.memory.stat.decisions")} value={graph?.stats.decisions ?? 0} formatNumber={formatNumber} />
      <Stat label={t("shell.memory.stat.sessions")} value={graph?.stats.sessions ?? 0} formatNumber={formatNumber} />
    </div>
    <div className="mt-5 border-t border-border-soft pt-4"><h4 className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted">{t("shell.memory.howItWorks")}</h4><ol className="mt-3 space-y-3 text-[10px] leading-4 text-secondary"><li className="flex gap-2"><FileJson2 className="mt-0.5 size-3.5 shrink-0 text-primary" />{t("shell.memory.howSessions")}</li><li className="flex gap-2"><FileText className="mt-0.5 size-3.5 shrink-0 text-primary" />{t("shell.memory.howDocuments")}</li><li className="flex gap-2"><BrainCircuit className="mt-0.5 size-3.5 shrink-0 text-primary" />{t("shell.memory.howRecall")}</li></ol></div>
  </div>;
}

function Stat({ label, value, formatNumber }: { label: string; value: number; formatNumber: I18nApi["number"] }) {
  return <div className="rounded-lg border border-border-soft bg-bg/35 p-2.5"><div className="font-mono text-[15px] font-semibold text-foreground">{formatNumber(value)}</div><div className="mt-0.5 text-[8.5px] uppercase tracking-wide text-muted">{label}</div></div>;
}

function groupColor(group: MemoryGraphGroup): string {
  if (group === "project") return "var(--color-foreground)";
  if (group === "code") return "var(--color-muted)";
  if (group === "document") return "var(--color-primary)";
  if (group === "decision") return "var(--color-success)";
  if (group === "plan") return "var(--color-warning)";
  if (group === "handoff") return "var(--color-danger)";
  if (group === "session") return "var(--color-secondary)";
  return "var(--color-faint)";
}

function groupLabel(group: MemoryGraphGroup, t: ReturnType<typeof useI18n>["t"]): string {
  if (group === "project") return t("shell.memory.group.project");
  if (group === "code") return t("shell.memory.group.code");
  if (group === "document") return t("shell.memory.group.document");
  if (group === "decision") return t("shell.memory.group.decision");
  if (group === "plan") return t("shell.memory.group.plan");
  if (group === "handoff") return t("shell.memory.group.handoff");
  if (group === "session") return t("shell.memory.group.session");
  return t("shell.memory.group.memory");
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) return `${fallback}: ${reason.message}`;
  return fallback;
}
