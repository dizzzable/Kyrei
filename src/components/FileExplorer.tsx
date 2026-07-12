import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, File, Folder, RefreshCw, X } from "lucide-react";
import { gateway } from "@/lib/gateway";
import { CodeBlock } from "./CodeBlock";

interface Entry { name: string; path: string; dir: boolean; }

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c",
  css: "css", scss: "scss", html: "html", md: "markdown", yml: "yaml", yaml: "yaml",
  sh: "bash", toml: "toml", sql: "sql", vue: "vue", svelte: "svelte", php: "php", rb: "ruby",
};

function langFor(name: string): string {
  return EXT_LANG[name.split(".").pop()?.toLowerCase() || ""] || "text";
}

export function FileExplorer({ hasWorkspace, onClose }: { hasWorkspace: boolean; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((p: string) => {
    setError(null);
    gateway.listFiles(p).then(r => { setEntries(r.entries); setPath(r.path); }).catch(e => setError(e.message));
  }, []);

  useEffect(() => { if (hasWorkspace) load(""); }, [hasWorkspace, load]);

  const openFile = (p: string) => {
    setError(null);
    gateway.readFile(p).then(r => setPreview({ path: r.path, content: r.content })).catch(e => setError(e.message));
  };

  const up = () => {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    load(parent);
  };

  const crumbs = path ? path.split("/") : [];

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Folder size={15} className="text-muted" />
        <span className="text-[13px] font-semibold">Файлы</span>
        <button onClick={() => (preview ? setPreview(null) : load(path))} className="ml-auto text-muted hover:text-foreground" title="Обновить">
          <RefreshCw size={14} />
        </button>
        <button onClick={onClose} className="text-muted hover:text-foreground" title="Закрыть"><X size={15} /></button>
      </div>

      {!hasWorkspace ? (
        <div className="p-4 text-[12.5px] text-muted">
          Рабочая папка не выбрана. Укажите её в Настройках, чтобы просматривать файлы.
        </div>
      ) : preview ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border-soft px-3 py-1.5">
            <button onClick={() => setPreview(null)} className="text-muted hover:text-foreground"><ArrowLeft size={14} /></button>
            <span className="truncate font-mono text-[11.5px] text-secondary">{preview.path}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <CodeBlock code={preview.content} lang={langFor(preview.path)} />
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 border-b border-border-soft px-3 py-1.5 text-[11.5px] text-muted">
            <button onClick={() => load("")} className="hover:text-foreground">root</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight size={11} />
                <button onClick={() => load(crumbs.slice(0, i + 1).join("/"))} className="hover:text-foreground">{c}</button>
              </span>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {error && <div className="px-3 py-2 text-[12px] text-danger">{error}</div>}
            {path && (
              <button onClick={up} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-muted hover:bg-white/[0.04]">
                <ArrowLeft size={13} /> ..
              </button>
            )}
            {entries.map(e => (
              <button
                key={e.path}
                onClick={() => (e.dir ? load(e.path) : openFile(e.path))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-secondary hover:bg-white/[0.04]"
              >
                {e.dir ? <Folder size={13} className="shrink-0 text-primary/70" /> : <File size={13} className="shrink-0 text-muted" />}
                <span className="truncate">{e.name}</span>
              </button>
            ))}
            {entries.length === 0 && !error && <div className="px-3 py-2 text-[12px] text-muted">(пусто)</div>}
          </div>
        </>
      )}
    </aside>
  );
}
