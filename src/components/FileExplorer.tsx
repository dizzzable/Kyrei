import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, File, Folder, RefreshCw, X } from "lucide-react";

import { CodeBlock } from "./CodeBlock";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";

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
  hasWorkspace,
  workspaceName,
  onClose,
}: {
  hasWorkspace: boolean;
  workspaceName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((nextPath: string) => {
    setError(null);
    gateway.listFiles(nextPath)
      .then((result) => {
        setEntries(result.entries);
        setPath(result.path);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(() => {
    if (hasWorkspace) load("");
  }, [hasWorkspace, load]);

  const openFile = (filePath: string) => {
    setError(null);
    gateway.readFile(filePath)
      .then((result) => setPreview({ path: result.path, content: result.content }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
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
          onClick={() => (preview ? setPreview(null) : load(path))}
          className="shell-icon-button ml-auto"
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
        <div className="px-3 py-4 text-[11.5px] leading-5 text-muted">{t("shell.developer.noWorkspace")}</div>
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
