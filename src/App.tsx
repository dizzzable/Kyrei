import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "@/lib/gateway";
import { appendReasoning, appendText, toolComplete, toolStart } from "@/lib/chat-messages";
import type { AppConfig, ChatMessage, GatewayEvent, MessagePart, SessionInfo } from "@/lib/types";
import { applyTheme, THEMES, type ThemeId } from "@/lib/theme";
import { SLASH_COMMANDS } from "@/lib/commands";
import { Sidebar } from "@/components/Sidebar";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import { FileExplorer } from "@/components/FileExplorer";
import { ResizeHandle } from "@/components/ResizeHandle";
import { usePersistentBool, usePersistentNumber, getStored, setStored } from "@/lib/persist";
import { PanelRight } from "lucide-react";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = usePersistentBool("kyrei-explorer-open", false);
  const [sidebarWidth, setSidebarWidth] = usePersistentNumber("kyrei-sidebar-w", 256);
  const [explorerWidth, setExplorerWidth] = usePersistentNumber("kyrei-explorer-w", 300);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);

  const pendingIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── Bootstrap: wait for gateway, load config + sessions ──────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      for (let i = 0; i < 40 && alive; i++) {
        try {
          const cfg = await gateway.getConfig();
          if (!alive) return;
          setConfig(cfg);
          break;
        } catch { await new Promise(r => setTimeout(r, 250)); }
      }
      const list = await gateway.listSessions().catch(() => []);
      if (!alive) return;
      if (list.length === 0) {
        const id = await gateway.createSession();
        setSessions([{ id, title: "Новый диалог" }]);
        setCurrentId(id);
      } else {
        setSessions(list);
        const last = getStored("kyrei-last-session");
        setCurrentId(last && list.some(s => s.id === last) ? last : list[0].id);
      }
    })();
    return () => { alive = false; };
  }, []);

  // ── Load transcript when the active session changes ──────────────────
  useEffect(() => {
    if (!currentId) return;
    setStored("kyrei-last-session", currentId);
    let alive = true;
    pendingIdRef.current = null;
    setStreaming(false);
    gateway.getMessages(currentId).then(stored => {
      if (!alive) return;
      setMessages(stored.map((m, i) => ({
        id: `hist-${i}`,
        role: m.role,
        parts: (m.parts && m.parts.length ? m.parts : [{ type: "text", text: m.content }]) as MessagePart[],
      })));
    }).catch(() => setMessages([]));
    return () => { alive = false; };
  }, [currentId]);

  // ── Subscribe to the active session's event stream ───────────────────
  useEffect(() => {
    if (!currentId) return;
    const updatePending = (fn: (parts: MessagePart[]) => MessagePart[]) => {
      const pid = pendingIdRef.current;
      if (!pid) return;
      setMessages(prev => prev.map(m => (m.id === pid ? { ...m, parts: fn(m.parts) } : m)));
    };

    const handle = (event: GatewayEvent) => {
      const p = event.payload || {};
      switch (event.type) {
        case "message.delta":
          if (p.text) updatePending(parts => appendText(parts, p.text!));
          break;
        case "reasoning.delta":
          if (p.text) updatePending(parts => appendReasoning(parts, p.text!));
          break;
        case "tool.start":
          updatePending(parts => toolStart(parts, { toolCallId: p.tool_call_id, name: p.name, args: p.args }));
          break;
        case "tool.complete":
          updatePending(parts => toolComplete(parts, {
            toolCallId: p.tool_call_id, name: p.name, result: p.result, error: p.error, durationS: p.duration_s, inlineDiff: p.inline_diff,
          }));
          break;
        case "message.complete": {
          const pid = pendingIdRef.current;
          if (pid) setMessages(prev => prev.map(m => (m.id === pid ? { ...m, pending: false } : m)));
          pendingIdRef.current = null;
          setStreaming(false);
          break;
        }
        case "session.title":
          if (p.title) setSessions(prev => prev.map(s => (s.id === p.session_id ? { ...s, title: p.title } : s)));
          break;
        case "error":
          updatePending(parts => appendText(parts, `\n\n⚠️ ${p.message || "ошибка"}`));
          setStreaming(false);
          break;
      }
    };

    return gateway.subscribe(currentId, handle);
  }, [currentId]);

  // ── Autoscroll ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const refreshSessions = useCallback(() => {
    gateway.listSessions().then(setSessions).catch(() => {});
  }, []);

  const send = useCallback((text: string) => {
    if (!currentId) return;
    const assistantId = `a-${Date.now()}`;
    pendingIdRef.current = assistantId;
    setMessages(prev => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
      { id: assistantId, role: "assistant", parts: [], pending: true },
    ]);
    setStreaming(true);
    gateway.sendPrompt(currentId, text).catch(err => {
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, parts: [{ type: "text", text: `⚠️ ${err.message}` }], pending: false } : m)));
      setStreaming(false);
    });
  }, [currentId]);

  const stop = useCallback(() => {
    if (currentId) gateway.cancel(currentId).catch(() => {});
    setStreaming(false);
  }, [currentId]);

  const newSession = useCallback(async () => {
    const id = await gateway.createSession();
    setSessions(prev => [{ id, title: "Новый диалог" }, ...prev]);
    setCurrentId(id);
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    await gateway.deleteSession(id).catch(() => {});
    const remaining = sessions.filter(s => s.id !== id);
    setSessions(remaining);
    if (currentId === id) {
      if (remaining.length > 0) setCurrentId(remaining[0].id);
      else { const nid = await gateway.createSession(); setSessions([{ id: nid, title: "Новый диалог" }]); setCurrentId(nid); }
    }
  }, [sessions, currentId]);

  const runCommand = useCallback((name: string, arg?: string) => {
    switch (name) {
      case "new":
      case "clear":
        void newSession();
        break;
      case "settings":
        setSettingsOpen(true);
        break;
      case "model":
        if (arg) gateway.setConfig({ model: arg }).then(setConfig).catch(() => {});
        else setSettingsOpen(true);
        break;
      case "theme":
        if (arg && THEMES.some(t => t.id === arg)) applyTheme(arg as ThemeId);
        else setSettingsOpen(true);
        break;
      case "help": {
        const help = "**Команды:**\n" + SLASH_COMMANDS.map(c => `- \`/${c.name}${c.arg ? " " + c.arg : ""}\` — ${c.desc}`).join("\n");
        setMessages(prev => [...prev, { id: `help-${Date.now()}`, role: "assistant", parts: [{ type: "text", text: help }] }]);
        break;
      }
    }
  }, [newSession]);

  const empty = messages.length === 0;

  return (
    <div className="flex h-full w-full">
      <div className="relative shrink-0" style={{ width: sidebarWidth }}>
        <Sidebar
          sessions={sessions}
          currentId={currentId}
          onSelect={setCurrentId}
          onNew={newSession}
          onDelete={deleteSession}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <ResizeHandle side="right" width={sidebarWidth} min={200} max={420} onChange={setSidebarWidth} />
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="text-[14px] font-semibold">
            {sessions.find(s => s.id === currentId)?.title || "Новый диалог"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {config && (
              <span className="flex items-center gap-1.5 text-[12px] text-muted">
                <span className={`size-1.5 rounded-full ${config.hasKey ? "bg-success" : "bg-warning"}`} />
                {config.model}
              </span>
            )}
            <button
              onClick={() => setExplorerOpen(o => !o)}
              className={`grid size-7 place-items-center rounded-md transition-colors ${explorerOpen ? "bg-elevated text-foreground" : "text-muted hover:bg-white/[0.04] hover:text-foreground"}`}
              title="Файлы рабочей папки"
            >
              <PanelRight size={16} />
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-5 py-6">
            {empty ? (
              <div className="flex h-[55vh] flex-col items-center justify-center text-center">
                <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-primary-strong text-[26px] font-bold text-white shadow-lg shadow-primary/20">K</div>
                <div className="text-[19px] font-bold">Kyrei Agent</div>
                <div className="mt-1.5 max-w-sm text-[13px] text-muted">
                  Локальный AI-агент для работы с кодом. Напишите запрос, чтобы начать.
                </div>
                {config && !config.hasKey && (
                  <button onClick={() => setSettingsOpen(true)} className="mt-4 rounded-lg border border-border px-3 py-1.5 text-[12px] text-secondary hover:bg-white/[0.04]">
                    Указать API-ключ в настройках
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-6">
                {messages.map(m => <Message key={m.id} message={m} />)}
              </div>
            )}
          </div>
        </div>

        <Composer streaming={streaming} disabled={!config} onSend={send} onStop={stop} onCommand={runCommand} />
      </main>

      {explorerOpen && (
        <div className="relative shrink-0" style={{ width: explorerWidth }}>
          <FileExplorer hasWorkspace={Boolean(config?.workspace)} onClose={() => setExplorerOpen(false)} />
          <ResizeHandle side="left" width={explorerWidth} min={240} max={560} onChange={setExplorerWidth} />
        </div>
      )}

      {settingsOpen && config && (
        <Settings config={config} onClose={() => setSettingsOpen(false)} onSaved={setConfig} />
      )}
    </div>
  );
}
