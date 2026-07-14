import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Circle, Plus, TerminalSquare, X } from "lucide-react";

import { useI18n } from "@/i18n";
import { desktopTerminal, type TerminalSessionEvent } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { emptyTerminalState, terminalViewReducer } from "./terminal-state";

interface TerminalActivityProps {
  ownerId?: string;
  workspace?: string;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function TerminalActivity({ ownerId = "workspace", workspace }: TerminalActivityProps) {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(terminalViewReducer, ownerId, emptyTerminalState);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [closingIds, setClosingIds] = useState<Set<string>>(() => new Set());
  const creatingRef = useRef(false);
  const renamingIds = useRef(new Set<string>());
  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    let hydrated = false;
    const pendingEvents: TerminalSessionEvent[] = [];
    setCommand("");
    setError("");
    setEditingId(null);
    setClosingIds(new Set());
    dispatch({ type: "hydrate", ownerId, sessions: [] });
    const dispose = desktopTerminal.onEvent((event) => {
      if (!alive) return;
      if (hydrated) dispatch({ type: "event", event });
      else pendingEvents.push(event);
    });
    desktopTerminal.list(ownerId)
      .then((sessions) => {
        if (!alive) return;
        dispatch({ type: "hydrate", ownerId, sessions });
        hydrated = true;
        for (const event of pendingEvents) dispatch({ type: "event", event });
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        dispatch({ type: "hydrate", ownerId, sessions: [] });
        hydrated = true;
        for (const event of pendingEvents) dispatch({ type: "event", event });
        setError(errorText(reason));
      });
    return () => {
      alive = false;
      dispose();
    };
  }, [ownerId]);

  const active = useMemo(
    () => state.sessions.find((session) => session.id === state.activeId) ?? null,
    [state.activeId, state.sessions],
  );

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [active?.output]);

  const createTerminal = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError("");
    try {
      const session = await desktopTerminal.create({
        ownerId,
        title: `${t("shell.terminal.tab")} ${state.sessions.length + 1}`,
        ...(workspace ? { cwd: workspace } : {}),
      });
      // The main process also emits `created`. Ensure the response can recover
      // a missed event without replacing output that may already have arrived.
      dispatch({ type: "ensure", session });
      dispatch({ type: "activate", sessionId: session.id });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const closeTerminal = async (sessionId: string) => {
    if (closingIds.has(sessionId)) return;
    setClosingIds((current) => new Set(current).add(sessionId));
    setError("");
    try {
      await desktopTerminal.close(sessionId);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setClosingIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const startRename = (sessionId: string, title: string) => {
    setEditingId(sessionId);
    setEditingTitle(title);
  };

  const finishRename = async () => {
    const sessionId = editingId;
    const title = editingTitle.trim();
    setEditingId(null);
    if (!sessionId || !title || renamingIds.current.has(sessionId)) return;
    renamingIds.current.add(sessionId);
    setError("");
    try {
      const session = await desktopTerminal.rename(sessionId, title);
      // Patch only the title: replacing the returned snapshot could erase
      // stdout that raced with the rename response.
      dispatch({ type: "rename", sessionId, title: session.title });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      renamingIds.current.delete(sessionId);
    }
  };

  const renameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void finishRename();
    } else if (event.key === "Escape") {
      setEditingId(null);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = command;
    if (!active || active.status !== "running" || !value.trim()) return;
    setCommand("");
    setError("");
    try {
      await desktopTerminal.write(active.id, `${value}\n`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const bridgeAvailable = desktopTerminal.available();

  return (
    <section className="terminal-activity flex h-full min-h-0 flex-col bg-bg">
      <div className="rail-section-header min-w-0">
        <TerminalSquare size={13} aria-hidden />
        <span>{t("shell.terminal.title")}</span>
        <span className="ml-auto text-[9px] text-faint">{state.sessions.length}</span>
        <button
          type="button"
          onClick={() => void createTerminal()}
          disabled={!bridgeAvailable || creating}
          className="shell-icon-button disabled:cursor-not-allowed disabled:opacity-40"
          title={t("shell.terminal.new")}
          aria-label={t("shell.terminal.new")}
        >
          <Plus size={13} aria-hidden />
        </button>
      </div>

      {state.sessions.length > 0 && (
        <div className="flex min-h-7 shrink-0 overflow-x-auto border-b border-border-soft bg-surface/45">
          {state.sessions.map((session) => {
            const selected = session.id === state.activeId;
            return (
              <div
                key={session.id}
                className={cn(
                  "group flex min-w-[7.5rem] max-w-[11rem] items-center gap-1 border-r border-border-soft px-1.5 text-[9.5px]",
                  selected ? "bg-bg text-foreground" : "text-muted hover:bg-(--ui-row-hover)",
                )}
              >
                {editingId === session.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
                    <Circle size={6} className="shrink-0 fill-current text-success" aria-hidden />
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onBlur={() => void finishRename()}
                      onKeyDown={renameKeyDown}
                      className="min-w-0 flex-1 border-b border-primary bg-transparent px-0.5 outline-none"
                      aria-label={t("shell.terminal.rename")}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "activate", sessionId: session.id })}
                    onDoubleClick={() => startRename(session.id, session.title)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                    title={`${session.title} — ${session.cwd}`}
                  >
                    <Circle
                      size={6}
                      className={cn(
                        "shrink-0 fill-current",
                        session.status === "running" ? "text-success" : session.status === "failed" ? "text-danger" : "text-faint",
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{session.title}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void closeTerminal(session.id)}
                  disabled={closingIds.has(session.id)}
                  className="shrink-0 rounded p-0.5 opacity-35 hover:bg-(--ui-row-hover) group-hover:opacity-100 focus:opacity-100 disabled:cursor-wait disabled:opacity-20"
                  title={t("shell.terminal.close")}
                  aria-label={t("shell.terminal.close")}
                >
                  <X size={10} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div ref={outputRef} className="min-h-0 flex-1 overflow-auto px-2 py-2 font-mono text-[10.5px] leading-5">
        {!bridgeAvailable ? (
          <div className="text-muted">{t("shell.terminal.desktopOnly")}</div>
        ) : !active ? (
          <button type="button" onClick={() => void createTerminal()} className="activity-empty-action w-full justify-center py-4">
            <Plus size={12} aria-hidden />
            <span>{t("shell.terminal.openFirst")}</span>
          </button>
        ) : (
          <pre className="m-0 min-w-max whitespace-pre font-inherit text-secondary">
            {active.output.map((chunk, index) => (
              <span key={`${index}-${chunk.stream}`} className={chunk.stream === "stderr" ? "text-danger" : undefined}>{chunk.text}</span>
            ))}
            {active.status !== "running" && (
              <span className={active.status === "failed" || active.exitCode ? "text-danger" : "text-muted"}>
                {`\n[${t("shell.terminal.exited")}: ${active.exitCode ?? active.signal ?? "—"}]\n`}
              </span>
            )}
          </pre>
        )}
        {error && <pre className="m-0 mt-2 min-w-max whitespace-pre font-inherit text-danger">{error}</pre>}
      </div>

      {active?.kind === "manual" && (
        <form onSubmit={(event) => void submit(event)} className="flex shrink-0 items-center gap-1.5 border-t border-border-soft px-2 py-1.5 font-mono text-[10.5px]">
          <span className="text-primary" aria-hidden>›</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={active.status !== "running"}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint disabled:cursor-not-allowed"
            placeholder={active.status === "running" ? t("shell.terminal.commandPlaceholder") : t("shell.terminal.notRunning")}
            aria-label={t("shell.terminal.commandPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </form>
      )}
    </section>
  );
}
