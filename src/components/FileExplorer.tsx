import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowLeft, ChevronRight, File, Folder, FolderOpen, RefreshCw, X } from "lucide-react";

import { CodeBlock } from "./CodeBlock";
import { useI18n } from "@/i18n";
import { desktopWorkspace } from "@/lib/desktop";
import { gateway } from "@/lib/gateway";
import { cn } from "@/lib/utils";

interface Entry {
  name: string;
  path: string;
  dir: boolean;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c",
  css: "css", scss: "scss", html: "html", md: "markdown", yml: "yaml", yaml: "yaml",
  sh: "bash", toml: "toml", sql: "sql", vue: "vue", svelte: "svelte", php: "php", rb: "ruby",
};

function langFor(name: string): string {
  return EXT_LANG[name.split(".").pop()?.toLowerCase() || ""] || "text";
}

export function FileExplorer({
  workspace,
  workspaceName,
  onWorkspaceOpen,
  onClose,
}: {
  workspace?: string;
  workspaceName: string;
  onWorkspaceOpen: (path: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [opening, setOpening] = useState(false);
  const navigationRequest = useRef(0);
  const previewRequest = useRef(0);
  const hasWorkspace = Boolean(workspace);
  const desktopAvailable = desktopWorkspace.available();

  const load = useCallback((nextPath: string) => {
    const request = ++navigationRequest.current;
    setError(null);
    gateway.listFiles(nextPath)
      .then((result) => {
        if (request !== navigationRequest.current) return;
        setEntries(result.entries);
        setPath(result.path);
      })
      .catch((reason: unknown) => {
        if (request === navigationRequest.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
  }, []);

  useEffect(() => {
    previewRequest.current += 1;
    setPreview(null);
    if (workspace) load("");
    else {
      navigationRequest.current += 1;
      setPath("");
      setEntries([]);
    }
  }, [workspace, load]);

  const connectWorkspace = async (nextPath: string) => {
    setError(null);
    setOpening(true);
    try {
      await onWorkspaceOpen(nextPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
      setDropActive(false);
    }
  };

  const chooseWorkspace = async () => {
    setError(null);
    try {
      const selected = await desktopWorkspace.choose(lang);
      if (!selected.canceled && selected.path) await connectWorkspace(selected.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const dropWorkspace = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (hasWorkspace || opening) return;
    const file = event.dataTransfer.files.length === 1 ? event.dataTransfer.files.item(0) : null;
    const rawPath = file ? window.kyrei?.getPathForFile?.(file) ?? "" : "";
    if (!rawPath) {
      setDropActive(false);
      setError(t("shell.developer.dropInvalid"));
      return;
    }
    try {
      const selected = await desktopWorkspace.validatePath(rawPath);
      await connectWorkspace(selected.path);
    } catch (reason) {
      setDropActive(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openFile = (filePath: string) => {
    const request = ++previewRequest.current;
    setError(null);
    gateway.readFile(filePath)
      .then((result) => {
        if (request === previewRequest.current) setPreview({ path: result.path, content: result.content });
      })
      .catch((reason: unknown) => {
        if (request === previewRequest.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
  };

  const up = () => {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    load(parent);
  };

  const crumbs = path ? path.split("/") : [];

  return (
    <section className="file-explorer flex h-full min-h-0 w-full flex-col bg-surface">
      <div className="rail-section-header">
        <Folder size={13} aria-hidden />
        <span className="truncate font-semibold uppercase tracking-[0.12em]">{workspaceName}</span>
        <button
          onClick={() => void chooseWorkspace()}
          disabled={!desktopAvailable || opening}
          className="shell-icon-button ml-auto disabled:cursor-not-allowed disabled:opacity-35"
          title={t("shell.developer.openWorkspace")}
          aria-label={t("shell.developer.openWorkspace")}
        >
          <FolderOpen size={13} aria-hidden />
        </button>
        <button
          onClick={() => (preview ? setPreview(null) : load(path))}
          disabled={!hasWorkspace}
          className="shell-icon-button disabled:cursor-not-allowed disabled:opacity-35"
          title={t("shell.developer.refresh")}
          aria-label={t("shell.developer.refresh")}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
        <button
          onClick={onClose}
          className="shell-icon-button"
          title={t("shell.developer.close")}
          aria-label={t("shell.developer.close")}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {!hasWorkspace ? (
        <div
          className={cn(
            "m-2 flex min-h-0 flex-1 flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center transition-colors",
            dropActive ? "border-primary bg-primary/8" : "border-border-soft bg-bg/30",
          )}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!opening) setDropActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropActive(false);
          }}
          onDrop={(event) => void dropWorkspace(event)}
        >
          <FolderOpen size={24} className="mb-3 text-primary" aria-hidden />
          <div className="text-[11.5px] font-medium text-secondary">{t("shell.developer.noWorkspace")}</div>
          <div className="mt-1 max-w-[14rem] text-[10px] leading-4 text-muted">{t("shell.developer.dropWorkspace")}</div>
          <button
            type="button"
            onClick={() => void chooseWorkspace()}
            disabled={!desktopAvailable || opening}
            className="primary-action mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] disabled:cursor-wait disabled:opacity-50"
          >
            <FolderOpen size={12} aria-hidden />
            {opening ? t("shell.developer.openingWorkspace") : t("shell.developer.openWorkspace")}
          </button>
          {error && <div className="mt-3 max-w-full break-words text-[10px] leading-4 text-danger">{error}</div>}
        </div>
      ) : preview ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border-soft px-2 py-1.5">
            <button
              onClick={() => setPreview(null)}
              className="shell-icon-button"
              title={t("shell.developer.back")}
              aria-label={t("shell.developer.back")}
            >
              <ArrowLeft size={13} aria-hidden />
            </button>
            <span className="truncate font-mono text-[10.5px] text-secondary">{preview.path}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <CodeBlock code={preview.content} lang={langFor(preview.path)} />
          </div>
        </div>
      ) : (
        <>
          <nav className="flex min-h-7 items-center gap-1 overflow-x-auto border-b border-border-soft px-2 text-[10.5px] text-muted">
            <button onClick={() => load("")} className="hover:text-foreground">{t("shell.developer.root")}</button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`} className="flex items-center gap-1">
                <ChevronRight size={10} aria-hidden />
                <button onClick={() => load(crumbs.slice(0, index + 1).join("/"))} className="hover:text-foreground">{crumb}</button>
              </span>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {error && <div className="px-3 py-2 text-[11px] leading-4 text-danger">{error}</div>}
            {path && (
              <button
                onClick={up}
                className="file-row text-muted"
                title={t("shell.developer.up")}
              >
                <ArrowLeft size={12} aria-hidden />
                <span>..</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => (entry.dir ? load(entry.path) : openFile(entry.path))}
                className="file-row text-secondary"
              >
                {entry.dir
                  ? <Folder size={12} className="shrink-0 text-muted" aria-hidden />
                  : <File size={12} className="shrink-0 text-faint" aria-hidden />}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {entries.length === 0 && !error && (
              <div className="px-3 py-2 text-[11px] text-muted">{t("shell.developer.emptyFolder")}</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
