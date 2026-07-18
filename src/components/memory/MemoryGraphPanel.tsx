import { BrainCircuit, FileJson2, FolderUp, LoaderCircle, RefreshCw, Search, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";

import { Button, Dialog, DialogContent, DialogTitle } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway, GatewayRequestError } from "@/lib/gateway";
import { bufferToBase64, importConversationFile } from "@/lib/session-import-api";
import type { MemoryAtlasNodeKind, MemoryAtlasSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { loadMemoryAtlasPreferences, saveMemoryAtlasPreferences } from "@/store/memory-atlas";
import { MemoryAtlasCanvas } from "./MemoryAtlasCanvas";
import { MemoryAtlasInspector } from "./MemoryAtlasInspector";
import { MemoryAtlasTree } from "./MemoryAtlasTree";
import type { AtlasViewport, Point } from "./memory-atlas-viewport";

interface MemoryGraphPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
}

const DOCUMENT_ACCEPT = ".md,.mdx,.markdown,.txt,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv";
const SESSION_ACCEPT = ".json,.jsonl,.md,.txt,application/json,text/markdown,text/plain";
const MAX_DOCUMENT_TOTAL = 12 * 1024 * 1024;
const GROUPS: MemoryAtlasNodeKind[] = ["code", "document", "decision", "plan", "handoff", "session", "memory", "skill", "evolution"];

export function MemoryGraphPanel({ open, onClose, onOpenSession }: MemoryGraphPanelProps) {
  const { t, date, number } = useI18n();
  const titleId = useId();
  const documentInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const [atlas, setAtlas] = useState<MemoryAtlasSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"documents" | "session" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaceMissing, setWorkspaceMissing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<MemoryAtlasNodeKind | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<AtlasViewport>({ scale: 1, x: 0, y: 0 });
  const [pinned, setPinned] = useState<Record<string, Point>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [paneWidths, setPaneWidths] = useState({ left: 240, right: 300 });
  const [dragging, setDragging] = useState(false);
  const loadedWorkspace = useRef("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await gateway.getMemoryAtlas();
      setWorkspaceMissing(false);
      setAtlas(next);
      setSelectedId((current) => current && next.nodes.some((node) => node.id === current) ? current : null);
      if (loadedWorkspace.current !== next.workspace) {
        const preference = loadMemoryAtlasPreferences(next.workspace);
        loadedWorkspace.current = next.workspace;
        setViewport(preference.viewport);
        setPaneWidths(preference.paneWidths);
        setPinned(Object.fromEntries(Object.entries(preference.pinned).filter(([id]) => next.nodes.some((node) => node.id === id))));
        setExpanded(new Set(preference.expandedTreeIds.length
          ? preference.expandedTreeIds
          : next.tree.filter((node) => node.kind === "source").map((node) => node.id)));
      }
    } catch (reason) {
      if (reason instanceof GatewayRequestError && reason.serverCode === "workspace_not_configured") {
        setWorkspaceMissing(true);
        setAtlas(null);
      } else {
        setError(errorText(reason, t("shell.memory.loadFailed")));
      }
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
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    if (!loadedWorkspace.current) return;
    const timer = window.setTimeout(() => saveMemoryAtlasPreferences(loadedWorkspace.current, {
      viewport,
      expandedTreeIds: [...expanded],
      pinned,
      paneWidths,
    }), 180);
    return () => window.clearTimeout(timer);
  }, [expanded, paneWidths, pinned, viewport]);

  useEffect(() => {
    if (!selectedId || !atlas?.tree.length) return;
    const byId = new Map(atlas.tree.map((node) => [node.id, node]));
    let current = atlas.tree.find((node) => node.nodeId === selectedId);
    if (!current) return;
    const ancestors: string[] = [];
    while (current.parentId) {
      ancestors.push(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent || parent.id === current.id) break;
      current = parent;
    }
    if (ancestors.length) setExpanded((value) => new Set([...value, ...ancestors]));
  }, [atlas?.tree, selectedId]);

  const beginPaneResize = useCallback((side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const start = paneWidths[side];
    const move = (next: PointerEvent) => {
      const delta = side === "left" ? next.clientX - startX : startX - next.clientX;
      const min = side === "left" ? 180 : 240;
      const max = side === "left" ? 420 : 520;
      setPaneWidths((current) => ({ ...current, [side]: Math.min(max, Math.max(min, start + delta)) }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [paneWidths]);

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
        ...((file as File & { webkitRelativePath?: string }).webkitRelativePath
          ? { relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath }
          : {}),
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
      if (folderInputRef.current) folderInputRef.current.value = "";
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
      setNotice(t("shell.memory.sessionImported", { count: number(result.report.messageCount), adapter: result.report.adapterId }));
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
  const visibleNodes = useMemo(() => (atlas?.nodes ?? []).filter((node) => {
    if (node.kind === "project") return true;
    if (activeGroup !== "all" && node.kind !== activeGroup) return false;
    if (!normalizedQuery) return true;
    return `${node.title} ${node.path ?? ""} ${node.subtitle ?? ""} ${node.preview ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
  }), [activeGroup, atlas?.nodes, normalizedQuery]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => (atlas?.edges ?? []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)), [atlas?.edges, visibleIds]);
  const matchedIds = useMemo(() => new Set(normalizedQuery ? visibleNodes.filter((node) => node.kind !== "project").map((node) => node.id) : []), [normalizedQuery, visibleNodes]);
  const selected = atlas?.nodes.find((node) => node.id === selectedId) ?? null;
  const sourceWarnings = atlas?.sources.filter((source) => source.health !== "ready") ?? [];

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void importDocuments([...event.dataTransfer.files]);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        showClose={false}
        aria-labelledby={titleId}
        className="flex h-[calc(100dvh-var(--app-titlebar-h)-var(--app-statusbar-h)-1.5rem)] max-h-none w-[calc(100vw-1.5rem)] max-w-[96rem] flex-col overflow-hidden rounded-xl border border-border bg-surface p-0"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary"><BrainCircuit className="size-4.5" /><span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-success ring-2 ring-surface" /></div>
          <div className="min-w-48 flex-1"><DialogTitle id={titleId}>{t("shell.memory.title")}</DialogTitle><p className="mt-0.5 truncate text-[10px] text-muted">{atlas?.workspace ?? t("shell.memory.subtitle")}</p></div>
          <label className="relative order-last w-full sm:order-none sm:w-64"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 w-full rounded-md border border-border bg-bg pl-8 pr-8 text-[11px] text-foreground outline-none placeholder:text-faint focus:border-primary/60 focus:ring-2 focus:ring-primary/15" placeholder={t("shell.memory.search")} aria-label={t("shell.memory.search")} />{query && <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground" aria-label={t("common.clear")}><X className="size-3" /></button>}</label>
          <input ref={sessionInputRef} type="file" accept={SESSION_ACCEPT} className="hidden" onChange={(event) => void importSession(event.target.files?.[0])} />
          <input ref={documentInputRef} type="file" accept={DOCUMENT_ACCEPT} multiple className="hidden" onChange={(event) => void importDocuments([...(event.target.files ?? [])])} />
          <input ref={folderInputRef} type="file" accept={DOCUMENT_ACCEPT} multiple className="hidden" onChange={(event) => void importDocuments([...(event.target.files ?? [])])} />
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => sessionInputRef.current?.click()}>{busy === "session" ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileJson2 className="size-3.5" />}{t("shell.memory.importSession")}</Button>
          <Button size="sm" disabled={busy !== null || workspaceMissing} onClick={() => documentInputRef.current?.click()}>{busy === "documents" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}{t("shell.memory.addDocuments")}</Button>
          <Button size="sm" variant="outline" disabled={busy !== null || workspaceMissing} onClick={() => folderInputRef.current?.click()}><FolderUp className="size-3.5" />{t("shell.memory.addFolder")}</Button>
          <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted hover:bg-(--ui-row-hover) hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/45" aria-label={t("shell.memory.close")}><X className="size-4" /></button>
        </header>

        {(error || notice || workspaceMissing || sourceWarnings.length > 0) && <div role={error ? "alert" : "status"} className={cn("mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-[10.5px] sm:mx-5", error ? "border-danger/30 bg-danger/8 text-danger" : workspaceMissing || sourceWarnings.length ? "border-warning/30 bg-warning/8 text-secondary" : "border-success/30 bg-success/8 text-secondary")}>{error ?? notice ?? (workspaceMissing ? t("shell.memory.workspaceRequired") : t("shell.memory.degradedSources", { count: number(sourceWarnings.length) }))}{!workspaceMissing && <button type="button" className="ml-auto text-faint hover:text-foreground" onClick={() => { setError(null); setNotice(null); }}><X className="size-3" /></button>}</div>}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-soft px-4 py-2 sm:px-5">
            <FilterChip active={activeGroup === "all"} onClick={() => setActiveGroup("all")} label={t("shell.memory.group.all")} count={atlas?.nodes.length ?? 0} />
            {GROUPS.map((group) => <FilterChip key={group} active={activeGroup === group} onClick={() => setActiveGroup(group)} label={group === "skill" ? t("shell.memory.group.skill") : group === "evolution" ? t("shell.memory.group.evolution") : groupLabel(group, t)} count={atlas?.nodes.filter((node) => node.kind === group).length ?? 0} />)}
            <span className="ml-auto hidden font-mono text-[9px] text-faint md:inline">{atlas ? t("shell.memory.generated", { value: date(Date.parse(atlas.generatedAt), { timeStyle: "short" }) }) : ""}</span>
            <Button size="icon-xs" variant="ghost" onClick={() => void refresh()} disabled={loading} aria-label={t("shell.memory.refresh")}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></Button>
          </div>

          <div
            className="memory-atlas-grid min-h-0 flex-1"
            style={{ "--memory-atlas-left": `${paneWidths.left}px`, "--memory-atlas-right": `${paneWidths.right}px` } as CSSProperties}
          >
            <aside className="memory-atlas-tree min-h-0 border-r border-border bg-surface"><MemoryAtlasTree nodes={atlas?.tree ?? []} expanded={expanded} selectedNodeId={selectedId} onExpandedChange={setExpanded} onSelectNode={setSelectedId} /></aside>
            <div className="memory-atlas-resizer" role="separator" aria-orientation="vertical" aria-label={t("shell.memory.resizeTree")} onPointerDown={(event) => beginPaneResize("left", event)} />
            <div className={cn("relative min-h-[24rem] overflow-hidden", dragging && "ring-2 ring-inset ring-primary/60")} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={onDrop}>
              {loading && !atlas ? <div className="absolute inset-0 z-10 grid place-items-center"><LoaderCircle className="size-5 animate-spin text-muted" /></div> : <MemoryAtlasCanvas nodes={visibleNodes} edges={visibleEdges} selectedId={selectedId} matchedIds={matchedIds} viewport={viewport} pinned={pinned} onSelect={setSelectedId} onViewportChange={setViewport} onPinnedChange={setPinned} />}
              {dragging && <div className="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-xl border border-dashed border-primary/70 bg-bg/90"><div className="text-center"><Upload className="mx-auto size-6 text-primary" /><p className="mt-2 text-[12px] font-medium text-foreground">{t("shell.memory.dropDocuments")}</p><p className="mt-1 text-[10px] text-muted">{t("shell.memory.documentFormats")}</p></div></div>}
              {!loading && visibleNodes.length <= 1 && <div className="pointer-events-none absolute inset-0 grid place-items-center"><div className="max-w-sm text-center"><BrainCircuit className="mx-auto size-6 text-muted" /><p className="mt-2 text-[12px] font-medium text-secondary">{t(workspaceMissing ? "shell.memory.workspaceRequiredTitle" : "shell.memory.empty")}</p><p className="mt-1 text-[10px] leading-4 text-muted">{t(workspaceMissing ? "shell.memory.workspaceRequiredHint" : "shell.memory.emptyHint")}</p></div></div>}
            </div>
            <div className="memory-atlas-resizer" role="separator" aria-orientation="vertical" aria-label={t("shell.memory.resizeInspector")} onPointerDown={(event) => beginPaneResize("right", event)} />
            <aside className="memory-atlas-inspector min-h-0 overflow-y-auto border-t border-border bg-surface"><MemoryAtlasInspector selected={selected} atlas={atlas} /></aside>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn("flex h-6 items-center gap-1.5 rounded-md border px-2 text-[9.5px] transition-colors", active ? "border-primary/35 bg-primary/10 text-foreground" : "border-border-soft text-muted hover:bg-(--ui-row-hover) hover:text-secondary")}>{label}<span className="font-mono text-[8px] opacity-65">{count}</span></button>;
}

type GroupLabelTranslator = ReturnType<typeof useI18n>["t"];

function groupLabel(group: Exclude<MemoryAtlasNodeKind, "skill" | "evolution">, t: GroupLabelTranslator): string {
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
