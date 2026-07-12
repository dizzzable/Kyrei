import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "@/lib/gateway";
import { appendReasoning, appendText, toolComplete, toolProgress, toolStart } from "@/lib/chat-messages";
import type { AppConfig, ChatMessage, GatewayEvent, MessagePart, SessionInfo } from "@/lib/types";
import { applyTheme, getTheme, THEMES, type ThemeId } from "@/lib/theme";
import { SLASH_COMMANDS } from "@/lib/commands";
import { Sidebar } from "@/components/Sidebar";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import type { SectionId } from "@/components/Settings";
import { CommandPalette } from "@/components/CommandPalette";
import { StatusBar } from "@/components/StatusBar";
import { Titlebar } from "@/components/Titlebar";
import { FileExplorer } from "@/components/FileExplorer";
import { ResizeHandle } from "@/components/ResizeHandle";
import { ArrowRight, Code2, FolderCode, Sparkles, TerminalSquare } from "lucide-react";
import { usePersistentBool, usePersistentNumber, getStored, setStored } from "@/lib/persist";
import { notifyTurnComplete, getUiSettings } from "@/store/settings";
import { getModelPreset } from "@/store/model-presets";
import { togglePinned } from "@/store/sessions-ui";
import { speak, cancelSpeech } from "@/lib/speech";
import { actionForCombo } from "@/store/keybinds";
import { comboAllowedInInput, comboFromEvent, isEditableTarget } from "@/lib/keybinds/combo";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("general");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = usePersistentBool("kyrei-explorer-open", false);
  const [sidebarOpen, setSidebarOpen] = usePersistentBool("kyrei-sidebar-open", true);
  const [sidebarWidth, setSidebarWidth] = usePersistentNumber("kyrei-sidebar-w", 238);
  const [explorerWidth, setExplorerWidth] = usePersistentNumber("kyrei-explorer-w", 280);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [tokens, setTokens] = useState<number | null>(null);

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
    setTokens(null);
    cancelSpeech();
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
        case "tool.progress":
          if (p.text) updatePending(parts => toolProgress(parts, { toolCallId: p.tool_call_id, name: p.name, text: p.text }));
          break;
        case "status.update": {
          const u = (event.payload as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }).usage;
          if (u) {
            const total = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
            setTokens(total > 0 ? total : null);
          }
          break;
        }
        case "message.complete": {
          const pid = pendingIdRef.current;
          if (pid) setMessages(prev => prev.map(m => (m.id === pid ? { ...m, pending: false } : m)));
          pendingIdRef.current = null;
          setStreaming(false);
          notifyTurnComplete("Kyrei — ответ готов");
          if (p.text && getUiSettings().autoSpeak) {
            speak(p.text, { lang: getUiSettings().voiceLang || undefined });
          }
          break;
        }
        case "session.title":
          if (p.title) setSessions(prev => prev.map(s => (s.id === p.session_id ? { ...s, title: p.title } : s)));
          break;
        case "error":
          updatePending(parts => appendText(parts, `\n\n⚠️ ${p.message || "ошибка"}`));
          if (pendingIdRef.current) {
            const pid = pendingIdRef.current;
            setMessages(prev => prev.map(m => (m.id === pid ? { ...m, pending: false } : m)));
          }
          pendingIdRef.current = null;
          setStreaming(false);
          break;
      }
    };

    return gateway.subscribe(currentId, handle);
  }, [currentId]);

  // ── Autoscroll ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = messages.length === 0 ? 0 : el.scrollHeight;
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
    const preset = config ? getModelPreset(config.activeProviderId, config.model) : {};
    const modelParams = (() => {
      const { thinking, effort, fast } = preset;
      if (thinking === undefined && effort === undefined && fast === undefined) return undefined;
      return {
        effort: thinking === false ? "off" : (effort ?? (thinking === true ? "medium" : undefined)),
        fast,
      };
    })();
    gateway.sendPrompt(currentId, text, modelParams).catch(err => {
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, parts: [{ type: "text", text: `⚠️ ${err.message}` }], pending: false } : m)));
      setStreaming(false);
    });
  }, [currentId, config]);

  const stop = useCallback(() => {
    if (currentId) gateway.cancel(currentId).catch(() => {});
    cancelSpeech();
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
        setSettingsSection("general");
        setSettingsOpen(true);
        break;
      case "model":
        if (arg) gateway.setConfig({ model: arg }).then(setConfig).catch(() => {});
        else { setSettingsSection("general"); setSettingsOpen(true); }
        break;
      case "theme":
        if (arg && THEMES.some(t => t.id === arg)) applyTheme(arg as ThemeId);
        else { setSettingsSection("appearance"); setSettingsOpen(true); }
        break;
      case "help": {
        const help = "**Команды:**\n" + SLASH_COMMANDS.map(c => `- \`/${c.name}${c.arg ? " " + c.arg : ""}\` — ${c.desc}`).join("\n");
        setMessages(prev => [...prev, { id: `help-${Date.now()}`, role: "assistant", parts: [{ type: "text", text: help }] }]);
        break;
      }
    }
  }, [newSession]);

  const renameSession = useCallback((id: string, title: string) => {
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, title } : s)));
    gateway.renameSession(id, title).catch(() => {});
  }, []);

  const openSettings = useCallback((s: SectionId = "general") => {
    setSettingsSection(s);
    setSettingsOpen(true);
  }, []);

  const cycleSession = useCallback((dir: 1 | -1) => {
    setCurrentId(prev => {
      if (sessions.length === 0) return prev;
      const idx = Math.max(0, sessions.findIndex(s => s.id === prev));
      const next = (idx + dir + sessions.length) % sessions.length;
      return sessions[next].id;
    });
  }, [sessions]);

  const toggleMode = useCallback(() => {
    applyTheme(getTheme() === "light" ? "dark" : "light");
  }, []);

  // Global keybind dispatch driven by the rebindable registry (store/keybinds).
  // A primary modifier (Cmd/Ctrl) fires even while typing; bare combos are
  // suppressed inside inputs so normal typing is never intercepted.
  useEffect(() => {
    const handlers: Record<string, () => void> = {
      "session.new": () => void newSession(),
      "session.next": () => cycleSession(1),
      "session.prev": () => cycleSession(-1),
      "session.focusSearch": () => (document.querySelector<HTMLInputElement>('input[aria-label="Поиск диалогов"]'))?.focus(),
      "session.togglePin": () => { if (currentId) togglePinned(currentId); },
      "composer.focus": () => document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')?.focus(),
      "composer.modelPicker": () => window.dispatchEvent(new CustomEvent("kyrei:open-model-picker")),
      "nav.commandPalette": () => setPaletteOpen(o => !o),
      "nav.settings": () => openSettings("general"),
      "view.toggleSidebar": () => setSidebarOpen(o => !o),
      "view.toggleExplorer": () => setExplorerOpen(o => !o),
      "appearance.toggleMode": toggleMode,
      "keybinds.openPanel": () => openSettings("keybinds"),
    };
    const onKey = (e: KeyboardEvent) => {
      const combo = comboFromEvent(e);
      if (!combo) return;
      const action = actionForCombo(combo);
      if (!action || !handlers[action]) return;
      if (isEditableTarget(e.target) && !comboAllowedInInput(combo)) return;
      e.preventDefault();
      handlers[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, cycleSession, toggleMode, openSettings, currentId, setSidebarOpen, setExplorerOpen]);

  const empty = messages.length === 0;

  return (
    <div className="app-shell flex h-full w-full flex-col">
      <Titlebar
        title={sessions.find(s => s.id === currentId)?.title || "Новый диалог"}
        model={config?.model}
        hasKey={config?.hasKey}
        explorerOpen={explorerOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
        onToggleExplorer={() => setExplorerOpen(o => !o)}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <div className="relative shrink-0" style={{ width: sidebarWidth }}>
            <Sidebar
              sessions={sessions}
              currentId={currentId}
              workingId={streaming ? currentId : null}
              onSelect={setCurrentId}
              onNew={newSession}
              onDelete={deleteSession}
              onRename={renameSession}
              onOpenSettings={() => openSettings()}
            />
            <ResizeHandle side="right" width={sidebarWidth} min={208} max={360} onChange={setSidebarWidth} />
          </div>
        )}

        <main className="conversation-shell flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="conversation-scroll flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[46rem] px-6 py-6 max-sm:px-4">
              {empty ? (
                <div className="empty-state mx-auto flex min-h-[calc(100vh-11rem)] max-w-[42rem] flex-col justify-center pb-[6vh]">
                  <div className="mb-6 flex items-center gap-3">
                    <div className="kyrei-mark kyrei-mark-lg" aria-hidden><span>K</span></div>
                    <div>
                      <div className="eyebrow">Локальный coding agent</div>
                      <div className="mt-1 text-[13px] text-secondary">Работает рядом с вашим кодом, а не вокруг него.</div>
                    </div>
                  </div>
                  <h1 className="max-w-[34rem] text-[clamp(2rem,3.4vw,3rem)] font-medium leading-[1.06] tracking-[-0.045em] text-foreground">
                    Что будем<br /><span className="text-muted">создавать сегодня?</span>
                  </h1>
                  <p className="mt-5 max-w-lg text-[14px] leading-6 text-secondary">
                    Опишите задачу обычными словами. Kyrei изучит проект, предложит точечные изменения и проверит результат.
                  </p>
                  <div className="mt-7 grid grid-cols-3 gap-2 max-sm:grid-cols-1">
                    <StarterPrompt icon={<Code2 size={15} />} title="Разобраться в коде" text="Объясни архитектуру этого проекта" onClick={send} />
                    <StarterPrompt icon={<Sparkles size={15} />} title="Улучшить интерфейс" text="Проведи аудит интерфейса и исправь главные проблемы" onClick={send} />
                    <StarterPrompt icon={<TerminalSquare size={15} />} title="Найти проблему" text="Запусти проверки и исправь найденные ошибки" onClick={send} />
                  </div>
                  <div className="mt-5 flex items-center gap-3 text-[11px] text-muted">
                    <span className="inline-flex items-center gap-1.5"><FolderCode size={12} />{config?.workspace ? "Рабочая папка подключена" : "Выберите рабочую папку в настройках"}</span>
                    <span className="h-3 w-px bg-border-soft" />
                    <span>Введите <kbd>/</kbd> для команд</span>
                  </div>
                  {config && !config.hasKey && (
                    <button onClick={() => openSettings()} className="mt-6 flex w-fit items-center gap-2 rounded-lg bg-foreground px-3.5 py-2 text-[12px] font-medium text-bg transition-transform hover:translate-x-0.5">
                      Подключить модель <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-7 pb-4">
                  {messages.map(m => <div key={m.id} className="msg-in"><Message message={m} /></div>)}
                </div>
              )}
            </div>
          </div>

          <Composer
            streaming={streaming}
            disabled={!config}
            sessionId={currentId}
            model={config?.model ?? ""}
            provider={config?.activeProviderId ?? ""}
            hasWorkspace={Boolean(config?.workspace)}
            onSend={send}
            onStop={stop}
            onCommand={runCommand}
            onModelChange={(providerId, modelId) => gateway.setConfig({ activeProviderId: providerId, model: modelId }).then(setConfig).catch(() => {})}
          />
        </main>

        {explorerOpen && (
          <div className="relative shrink-0" style={{ width: explorerWidth }}>
            <FileExplorer hasWorkspace={Boolean(config?.workspace)} onClose={() => setExplorerOpen(false)} />
            <ResizeHandle side="left" width={explorerWidth} min={240} max={480} onChange={setExplorerWidth} />
          </div>
        )}
      </div>

      <StatusBar
        model={config?.model ?? ""}
        provider={config?.activeProviderName || config?.provider || ""}
        hasKey={Boolean(config?.hasKey)}
        connected={Boolean(config)}
        streaming={streaming}
        sessionCount={sessions.length}
        tokens={tokens}
      />

      {settingsOpen && config && (
        <Settings config={config} onClose={() => setSettingsOpen(false)} onSaved={setConfig} initialSection={settingsSection} />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        onNew={newSession}
        onOpenSettings={() => openSettings()}
        onSelectSession={setCurrentId}
      />
    </div>
  );
}

function StarterPrompt({ icon, title, text, onClick }: { icon: React.ReactNode; title: string; text: string; onClick: (text: string) => void }) {
  return (
    <button onClick={() => onClick(text)} className="starter-card group text-left">
      <span className="flex items-center justify-between text-secondary"><span className="starter-icon">{icon}</span><ArrowRight size={13} className="opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" /></span>
      <span className="mt-5 block text-[12.5px] font-medium text-foreground">{title}</span>
      <span className="mt-1 block text-[11px] leading-[1.45] text-muted">{text}</span>
    </button>
  );
}
