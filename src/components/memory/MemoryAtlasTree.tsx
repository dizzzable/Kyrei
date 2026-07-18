import { ChevronDown, ChevronRight, Circle, Folder, FolderOpen } from "lucide-react";
import { useMemo, useRef } from "react";
import { useI18n } from "@/i18n";
import type { MemoryAtlasTreeNode } from "@/lib/types";
import { cn } from "@/lib/utils";

export function MemoryAtlasTree({
  nodes,
  expanded,
  selectedNodeId,
  onExpandedChange,
  onSelectNode,
}: {
  nodes: readonly MemoryAtlasTreeNode[];
  expanded: ReadonlySet<string>;
  selectedNodeId: string | null;
  onExpandedChange: (next: Set<string>) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const byParent = useMemo(() => {
    const map = new Map<string | undefined, MemoryAtlasTreeNode[]>();
    for (const node of nodes) map.set(node.parentId, [...(map.get(node.parentId) ?? []), node]);
    return map;
  }, [nodes]);
  const visible = useMemo(() => {
    const rows: Array<{ node: MemoryAtlasTreeNode; level: number }> = [];
    const visit = (parentId: string | undefined, level: number) => {
      for (const node of byParent.get(parentId) ?? []) {
        rows.push({ node, level });
        if (node.childCount && expanded.has(node.id)) visit(node.id, level + 1);
      }
    };
    visit(undefined, 1);
    return rows;
  }, [byParent, expanded]);

  const focusRow = (index: number) => refs.current.get(visible[Math.max(0, Math.min(visible.length - 1, index))]?.node.id ?? "")?.focus();
  const toggle = (id: string, open?: boolean) => {
    const next = new Set(expanded);
    const shouldOpen = open ?? !next.has(id);
    if (shouldOpen) next.add(id); else next.delete(id);
    onExpandedChange(next);
  };

  return (
    <div role="tree" aria-label={t("shell.memory.directory")} className="h-full overflow-y-auto px-2 py-2">
      {visible.map(({ node, level }, index) => {
        const open = expanded.has(node.id);
        const selected = Boolean(node.nodeId && node.nodeId === selectedNodeId);
        const caret = node.childCount
          ? (open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />)
          : <span className="w-3" />;
        const icon = node.kind === "item"
          ? <Circle className="size-2.5 shrink-0 fill-current opacity-45" />
          : open
            ? <FolderOpen className="size-3.5 shrink-0 text-primary" />
            : <Folder className="size-3.5 shrink-0 text-muted" />;
        return (
          <button
            key={node.id}
            ref={(element) => { if (element) refs.current.set(node.id, element); else refs.current.delete(node.id); }}
            type="button"
            role="treeitem"
            aria-level={level}
            aria-expanded={node.childCount ? open : undefined}
            aria-selected={selected}
            tabIndex={selected || (!selectedNodeId && index === 0) ? 0 : -1}
            className={cn(
              "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[11px] text-secondary outline-none hover:bg-(--ui-row-hover) focus-visible:ring-2 focus-visible:ring-primary/40",
              selected && "bg-primary/10 text-foreground",
            )}
            style={{ paddingLeft: `${Math.max(6, (level - 1) * 14 + 6)}px` }}
            onClick={() => node.nodeId ? onSelectNode(node.nodeId) : toggle(node.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); focusRow(index + 1); }
              else if (event.key === "ArrowUp") { event.preventDefault(); focusRow(index - 1); }
              else if (event.key === "ArrowRight" && node.childCount) { event.preventDefault(); if (!open) toggle(node.id, true); else focusRow(index + 1); }
              else if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (open) toggle(node.id, false);
                else if (node.parentId) refs.current.get(node.parentId)?.focus();
              } else if (event.key === "Home") { event.preventDefault(); focusRow(0); }
              else if (event.key === "End") { event.preventDefault(); focusRow(visible.length - 1); }
            }}
          >
            {caret}
            {icon}
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            {node.childCount > 0 && <span className="font-mono text-[8px] text-faint">{node.childCount}</span>}
          </button>
        );
      })}
    </div>
  );
}
