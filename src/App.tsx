import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Code2, FolderCode, Sparkles, TerminalSquare } from "lucide-react";

import { CommandPalette } from "@/components/CommandPalette";
import { Composer } from "@/components/Composer";
import { CronPanel } from "@/components/cron/CronPanel";
import { PipelineMissionPanel } from "@/components/pipeline/PipelineMissionPanel";
import { Message } from "@/components/Message";
import { ResizeHandle } from "@/components/ResizeHandle";
import { Settings, type SectionId } from "@/components/Settings";
import { StatusBar } from "@/components/StatusBar";
import { Titlebar } from "@/components/Titlebar";
import { ActivityRail } from "@/components/shell/ActivityRail";
import { settingsSectionForActivity } from "@/components/shell/activity-registry";
import { DeveloperRail } from "@/components/shell/DeveloperRail";
import { ShellLayout } from "@/components/shell/ShellLayout";
import { useShellPreferences } from "@/components/shell/shell-preferences";
import { useI18n } from "@/i18n";
import { appendReasoning, appendText, toolComplete, toolProgress, toolStart } from "@/lib/chat-messages";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import { actionForCombo } from "@/store/keybinds";
import { comboAllowedInInput, comboFromEvent, isEditableTarget } from "@/lib/keybinds/combo";
import { executableModelParams } from "@/lib/model-capabilities";
import { getStored, setStored } from "@/lib/persist";
import { getSlashCommands } from "@/lib/slash-commands";
import { cancelSpeech, speak } from "@/lib/speech";
import {
  reconcileCurrentSessionId,
  rollbackSessionModel,
  shouldApplySessionPoll,
  updateSessionModel,
} from "@/lib/session-sync";
import { sessionTitle } from "@/lib/session-search";
import { applyTheme, getTheme, THEMES, type ThemeId } from "@/lib/theme";
import type { AppConfig, ChatMessage, GatewayEvent, GatewayStatus, MessagePart, SessionInfo, SubagentRun } from "@/lib/types";
import { getModelPreset } from "@/store/model-presets";
import { togglePinned } from "@/store/sessions-ui";
import { getUiSettings, notifyTurnComplete } from "@/store/settings";

export function App() {
  const { t } = useI18n();
  const translationRef = useRef(t);
  useEffect(() => { translationRef.current = t; }, [t]);
  const slashCommands = useMemo(() => getSlashCommands(t), [t]);
  const { preferences, patch: patchShell } = useShellPreferences();
  const compactShell = useMediaQuery("(max-width: 960px)");
  const [compactOverlay, setCompactOverlay] = useState<"developer" | "activity" | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  const [missionOpen, setMissionOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("model");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [tokens, setTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayConnected, setGatewayConnected] = useState(false);
  const [agentRuns, setAgentRuns] = useState<SubagentRun[]>([]);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [sessionModelPendingIds, setSessionModelPendingIds] = useState<ReadonlySet<string>>(() => new Set());

  const pendingIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionPollRequestRef = useRef(0);
  const sessionMutationRevisionRef = useRef(0);
  const sessionMutationsInFlightRef = useRef(0);
  const sessionModelPendingIdsRef = useRef(new Set<string>());

  const beginSessionMutation = useCallback(() => {
    sessionMutationsInFlightRef.current += 1;
    sessionMutationRevisionRef.current += 1;
  }, []);
  const finishSessionMutation = useCallback(() => {
    sessionMutationsInFlightRef.current = Math.max(0, sessionMutationsInFlightRef.current - 1);
    sessionMutationRevisionRef.current += 1;
  }, []);

  const describeError = useCallback((reason: unknown): string => {
    const translate = translationRef.current;
    if (reason instanceof GatewayRequestError && reason.code === "capability_unavailable") {
      return translate("shell.error.capabilityUnavailable");
    }
    const detail = reason instanceof GatewayRequestError
      ? reason.detail
      : reason instanceof Error
        ? reason.message
        : String(reason || translate("shell.error.fallback"));
    return translate("shell.error.prefix", { message: detail || translate("shell.error.fallback") });
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let loadedConfig: AppConfig | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        try {
          loadedConfig = await gateway.getConfig();
          if (!alive) return;
          setConfig(loadedConfig);
          setStartupError(null);
          break;
        } catch (reason) {
          lastError = reason;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }
      if (!alive) return;
      if (!loadedConfig && lastError) setStartupError(describeError(lastError));

      try {
        const revisionAtStart = sessionMutationRevisionRef.current;
        const list = await gateway.listSessions();
        if (!alive) return;
        if (revisionAtStart !== sessionMutationRevisionRef.current || sessionMutationsInFlightRef.current > 0) return;
        if (list.length === 0) {
          beginSessionMutation();
          try {
            const id = await gateway.createSession();
            if (!alive) return;
            setSessions([{
              id,
              title: "",
              createdAt: new Date().toISOString(),
              source: "chat",
              providerId: loadedConfig?.activeProviderId,
              modelId: loadedConfig?.activeModelId,
            }]);
            setCurrentId(id);
          } finally {
            finishSessionMutation();
          }
          return;
        }
        setSessions(list);
        const last = getStored("kyrei-last-session");
        setCurrentId(last && list.some((session) => session.id === last) ? last : list[0].id);
      } catch (reason) {
        if (alive) setStartupError(describeError(reason));
      }
    })();
    return () => { alive = false; };
  }, [beginSessionMutation, describeError, finishSessionMutation]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const requestId = ++sessionPollRequestRef.current;
      const revisionAtStart = sessionMutationRevisionRef.current;
      try {
        const [status, remoteSessions] = await Promise.all([gateway.getStatus(), gateway.listSessions()]);
        if (!alive || requestId !== sessionPollRequestRef.current) return;
        setGatewayStatus(status);
        setGatewayConnected(true);
        setAgentRuns(status.agents ?? []);
        if (shouldApplySessionPoll({
          requestId,
          latestRequestId: sessionPollRequestRef.current,
          revisionAtStart,
          currentRevision: sessionMutationRevisionRef.current,
          mutationsInFlight: sessionMutationsInFlightRef.current,
        })) {
          setSessions(remoteSessions);
          setCurrentId((current) => reconcileCurrentSessionId(current, remoteSessions));
        }
      } catch {
        if (alive && requestId === sessionPollRequestRef.current) setGatewayConnected(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const currentSession = sessions.find((session) => session.id === currentId);
  const currentProviderId = currentSession?.providerId ?? config?.activeProviderId ?? "";
  const currentModelId = currentSession?.modelId ?? config?.activeModelId ?? "";

  useEffect(() => {
    if (!config) {
      setContextWindow(null);
      return;
    }
    let alive = true;
    gateway.getModels().then(({ models }) => {
      if (!alive) return;
      const exact = models.find((entry) => entry.id === currentModelId && entry.provider === currentProviderId)
        ?? models.find((entry) => entry.id === currentModelId);
      setContextWindow(exact?.limits?.contextWindow ?? null);
    }).catch(() => { if (alive) setContextWindow(null); });
    return () => { alive = false; };
  }, [config, currentProviderId, currentModelId]);

  useEffect(() => {
    if (!currentId) return;
    setStored("kyrei-last-session", currentId);
    let alive = true;
    pendingIdRef.current = null;
    setStreaming(false);
    setTurnStartedAt(null);
    setTokens(null);
    cancelSpeech();
    gateway.getMessages(currentId)
      .then((stored) => {
        if (!alive) return;
        setMessages(stored.map((message, index) => ({
          id: `history-${index}`,
          role: message.role,
          parts: (message.parts?.length ? message.parts : [{ type: "text", text: message.content }]) as MessagePart[],
        })));
      })
      .catch((reason) => {
        if (alive) {
          setMessages([]);
          setStartupError(describeError(reason));
        }
      });
    return () => { alive = false; };
  }, [currentId, describeError]);

  useEffect(() => {
    if (!currentId) return;
    const updatePending = (transform: (parts: MessagePart[]) => MessagePart[]) => {
      const pendingId = pendingIdRef.current;
      if (!pendingId) return;
      setMessages((current) => current.map((message) => message.id === pendingId
        ? { ...message, parts: transform(message.parts) }
        : message));
    };

    const handle = (event: GatewayEvent) => {
      const payload = event.payload || {};
      switch (event.type) {
        case "message.delta":
          if (payload.text) updatePending((parts) => appendText(parts, payload.text!));
          break;
        case "reasoning.delta":
          if (payload.text) updatePending((parts) => appendReasoning(parts, payload.text!));
          break;
        case "tool.start":
          updatePending((parts) => toolStart(parts, { toolCallId: payload.tool_call_id, name: payload.name, args: payload.args }));
          break;
        case "tool.complete":
          updatePending((parts) => toolComplete(parts, {
            toolCallId: payload.tool_call_id,
            name: payload.name,
            result: payload.result,
            error: payload.error,
            durationS: payload.duration_s,
            inlineDiff: payload.inline_diff,
          }));
          break;
        case "tool.progress":
          if (payload.text) updatePending((parts) => toolProgress(parts, { toolCallId: payload.tool_call_id, name: payload.name, text: payload.text! }));
          break;
        case "status.update": {
          const usage = (event.payload as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }).usage;
          if (usage) {
            const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
            setTokens(total > 0 ? total : null);
          }
          break;
        }
        case "subagent.start":
        case "subagent.progress":
        case "subagent.complete":
        case "subagent.failed": {
          const id = payload.subagent_id;
          if (!id) break;
          const now = Date.now();
          setAgentRuns((current) => {
            const previous = current.find((run) => run.id === id);
            const status: SubagentRun["status"] = event.type === "subagent.complete"
              ? "completed"
              : event.type === "subagent.failed"
                ? payload.status === "interrupted" ? "interrupted" : "failed"
                : "running";
            const next: SubagentRun = {
              id,
              parentId: payload.parent_id ?? previous?.parentId,
              sessionId: currentId,
              goal: payload.goal ?? previous?.goal ?? "",
              model: payload.model ?? previous?.model,
              status,
              startedAt: previous?.startedAt ?? now,
              updatedAt: now,
              durationSeconds: payload.duration_seconds ?? previous?.durationSeconds,
              inputTokens: payload.input_tokens ?? previous?.inputTokens,
              outputTokens: payload.output_tokens ?? previous?.outputTokens,
              toolCount: payload.tool_count ?? previous?.toolCount,
              filesRead: payload.files_read ?? previous?.filesRead ?? [],
              filesWritten: payload.files_written ?? previous?.filesWritten ?? [],
              currentTool: payload.current_tool ?? previous?.currentTool,
              summary: payload.summary ?? previous?.summary,
              error: payload.error ?? previous?.error,
            };
            return [next, ...current.filter((run) => run.id !== id)].slice(0, 200);
          });
          break;
        }
        case "message.complete": {
          const pendingId = pendingIdRef.current;
          if (pendingId) {
            setMessages((current) => current.map((message) => message.id === pendingId ? { ...message, pending: false } : message));
          }
          pendingIdRef.current = null;
          setStreaming(false);
          setTurnStartedAt(null);
          notifyTurnComplete(translationRef.current("shell.notification.turnComplete"));
          if (payload.text && getUiSettings().autoSpeak) {
            speak(payload.text, { lang: getUiSettings().voiceLang || undefined });
          }
          break;
        }
        case "session.title":
          if (payload.title) {
            setSessions((current) => current.map((session) => session.id === payload.session_id ? { ...session, title: payload.title } : session));
          }
          break;
        case "session.model":
          if (payload.session_id && payload.provider_id && payload.model_id) {
            setSessions((current) => updateSessionModel(current, payload.session_id!, {
              providerId: payload.provider_id!,
              modelId: payload.model_id!,
            }));
          }
          break;
        case "error": {
          const translate = translationRef.current;
          const errorCode = (event.payload as { code?: string }).code;
          const message = errorCode === "provider_not_configured"
            ? translate("shell.error.providerNotConfigured")
            : translate("shell.error.prefix", { message: payload.message || translate("shell.error.fallback") });
          updatePending((parts) => appendText(parts, `\n\n${message}`));
          const pendingId = pendingIdRef.current;
          if (pendingId) {
            setMessages((current) => current.map((item) => item.id === pendingId ? { ...item, pending: false } : item));
          }
          pendingIdRef.current = null;
          setStreaming(false);
          setTurnStartedAt(null);
          break;
        }
      }
    };

    try {
      return gateway.subscribe(currentId, handle);
    } catch (reason) {
      setStartupError(describeError(reason));
      return undefined;
    }
  }, [currentId, describeError]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = messages.length === 0 ? 0 : element.scrollHeight;
  }, [messages]);

  const send = useCallback((text: string) => {
    if (!currentId) return;
    const assistantId = `assistant-${Date.now()}`;
    pendingIdRef.current = assistantId;
    setStartupError(null);
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
      { id: assistantId, role: "assistant", parts: [], pending: true },
    ]);
    setStreaming(true);
    setTurnStartedAt(Date.now());
    const preset = config ? getModelPreset(currentProviderId, currentModelId) : {};
    const protocol = config?.providers.find((candidate) => candidate.id === currentProviderId)?.protocol;
    const modelParams = executableModelParams(protocol, preset);
    gateway.sendPrompt(currentId, text, modelParams).catch((reason) => {
      const message = describeError(reason);
      setMessages((current) => current.map((item) => item.id === assistantId
        ? { ...item, parts: [{ type: "text", text: message }], pending: false }
        : item));
      setStreaming(false);
      setTurnStartedAt(null);
    });
  }, [currentId, config, currentProviderId, currentModelId, describeError]);

  const stop = useCallback(() => {
    if (currentId) gateway.cancel(currentId).catch(() => {});
    cancelSpeech();
    setStreaming(false);
    setTurnStartedAt(null);
  }, [currentId]);

  const newSession = useCallback(async () => {
    beginSessionMutation();
    try {
      const id = await gateway.createSession();
      setSessions((current) => [{
        id,
        title: "",
        createdAt: new Date().toISOString(),
        source: "chat",
        providerId: config?.activeProviderId,
        modelId: config?.activeModelId,
      }, ...current]);
      setCurrentId(id);
      setStartupError(null);
    } catch (reason) {
      setStartupError(describeError(reason));
    } finally {
      finishSessionMutation();
    }
  }, [beginSessionMutation, config, describeError, finishSessionMutation]);

  const deleteSession = useCallback(async (id: string) => {
    beginSessionMutation();
    try {
      await gateway.deleteSession(id).catch(() => {});
      const remaining = sessions.filter((session) => session.id !== id);
      setSessions(remaining);
      if (currentId !== id) return;
      if (remaining.length > 0) {
        setCurrentId(remaining[0].id);
        return;
      }
      try {
        const nextId = await gateway.createSession();
        setSessions([{
          id: nextId,
          title: "",
          createdAt: new Date().toISOString(),
          source: "chat",
          providerId: config?.activeProviderId,
          modelId: config?.activeModelId,
        }]);
        setCurrentId(nextId);
      } catch (reason) {
        setCurrentId(null);
        setStartupError(describeError(reason));
      }
    } finally {
      finishSessionMutation();
    }
  }, [beginSessionMutation, sessions, currentId, config, describeError, finishSessionMutation]);

  const runCommand = useCallback((name: string, argument?: string) => {
    switch (name) {
      case "new":
      case "clear":
        void newSession();
        break;
      case "settings":
        setSettingsSection("model");
        setSettingsOpen(true);
        break;
      case "model":
        if (argument) gateway.setConfig({ model: argument }).then(setConfig).catch(() => {});
        else { setSettingsSection("model"); setSettingsOpen(true); }
        break;
      case "theme":
        if (argument && THEMES.some((theme) => theme.id === argument)) applyTheme(argument as ThemeId);
        else { setSettingsSection("appearance"); setSettingsOpen(true); }
        break;
      case "help": {
        const help = `**${t("shell.help.title")}:**\n${slashCommands.map((command) => `- \`${command.command}${command.arg ? ` ${command.arg}` : ""}\` — ${command.desc}`).join("\n")}`;
        setMessages((current) => [...current, { id: `help-${Date.now()}`, role: "assistant", parts: [{ type: "text", text: help }] }]);
        break;
      }
    }
  }, [newSession, slashCommands, t]);

  const renameSession = useCallback((id: string, title: string) => {
    beginSessionMutation();
    setSessions((current) => current.map((session) => session.id === id ? { ...session, title } : session));
    gateway.renameSession(id, title).catch(() => {}).finally(finishSessionMutation);
  }, [beginSessionMutation, finishSessionMutation]);

  const changeSessionModel = useCallback(async (providerId: string, modelId: string) => {
    const sessionId = currentId;
    if (!sessionId || sessionModelPendingIdsRef.current.has(sessionId)) return;
    const current = sessions.find((session) => session.id === sessionId);
    if (!current) return;
    const previous = {
      providerId: current.providerId ?? config?.activeProviderId ?? "",
      modelId: current.modelId ?? config?.activeModelId ?? "",
    };
    const optimistic = { providerId, modelId };

    beginSessionMutation();
    sessionModelPendingIdsRef.current.add(sessionId);
    setSessionModelPendingIds(new Set(sessionModelPendingIdsRef.current));
    setStartupError(null);
    setSessions((items) => updateSessionModel(items, sessionId, optimistic));
    try {
      const session = await gateway.setSessionModel(sessionId, providerId, modelId);
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, ...session } : item));
    } catch (reason) {
      setSessions((items) => rollbackSessionModel(items, sessionId, optimistic, previous));
      setStartupError(describeError(reason));
    } finally {
      sessionModelPendingIdsRef.current.delete(sessionId);
      setSessionModelPendingIds(new Set(sessionModelPendingIdsRef.current));
      finishSessionMutation();
    }
  }, [
    beginSessionMutation,
    config?.activeModelId,
    config?.activeProviderId,
    currentId,
    describeError,
    finishSessionMutation,
    sessions,
  ]);

  const openSettings = useCallback((section: SectionId = "model") => {
    setCronOpen(false);
    setMissionOpen(false);
    setPaletteOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const openCron = useCallback(() => {
    setSettingsOpen(false);
    setMissionOpen(false);
    setPaletteOpen(false);
    setCronOpen(true);
  }, []);

  const openMissions = useCallback(() => {
    setSettingsOpen(false);
    setCronOpen(false);
    setPaletteOpen(false);
    setMissionOpen(true);
  }, []);

  const cycleSession = useCallback((direction: 1 | -1) => {
    setCurrentId((current) => {
      if (sessions.length === 0) return current;
      const index = Math.max(0, sessions.findIndex((session) => session.id === current));
      return sessions[(index + direction + sessions.length) % sessions.length].id;
    });
  }, [sessions]);

  const toggleMode = useCallback(() => applyTheme(getTheme() === "light" ? "dark" : "light"), []);
  const developerOpen = compactShell ? compactOverlay === "developer" : preferences.developerOpen;
  const activityOpen = compactShell ? compactOverlay === "activity" : preferences.activityOpen;
  const toggleDeveloper = useCallback(() => {
    if (compactShell) {
      setCompactOverlay((current) => current === "developer" ? null : "developer");
      return;
    }
    patchShell({ developerOpen: !preferences.developerOpen });
  }, [compactShell, patchShell, preferences.developerOpen]);
  const toggleActivity = useCallback(() => {
    if (compactShell) {
      setCompactOverlay((current) => current === "activity" ? null : "activity");
      return;
    }
    patchShell({ activityOpen: !preferences.activityOpen });
  }, [compactShell, patchShell, preferences.activityOpen]);

  useEffect(() => {
    const handlers: Record<string, () => void> = {
      "session.new": () => void newSession(),
      "session.next": () => cycleSession(1),
      "session.prev": () => cycleSession(-1),
      "session.focusSearch": () => document.querySelector<HTMLInputElement>("[data-shell-session-search] input")?.focus(),
      "session.togglePin": () => { if (currentId) togglePinned(currentId); },
      "composer.focus": () => document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")?.focus(),
      "composer.modelPicker": () => window.dispatchEvent(new CustomEvent("kyrei:open-model-picker")),
      "nav.commandPalette": () => setPaletteOpen((open) => !open),
      "nav.settings": () => openSettings("model"),
      "view.toggleSidebar": toggleActivity,
      "view.toggleExplorer": toggleDeveloper,
      "appearance.toggleMode": toggleMode,
      "keybinds.openPanel": () => openSettings("keybinds"),
    };
    const onKey = (event: KeyboardEvent) => {
      if (settingsOpen || cronOpen || missionOpen) return;
      const combo = comboFromEvent(event);
      if (!combo) return;
      const action = actionForCombo(combo);
      if (!action || !handlers[action]) return;
      if (isEditableTarget(event.target) && !comboAllowedInInput(combo)) return;
      event.preventDefault();
      handlers[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, cycleSession, toggleMode, openSettings, currentId, toggleActivity, toggleDeveloper, settingsOpen, cronOpen, missionOpen]);

  const currentTitle = sessionTitle(sessions.find((session) => session.id === currentId) ?? { id: "" }, t("shell.session.untitled"));
  const turbo = terminalPermission(config) === "turbo";
  const toggleTurbo = () => {
    if (!config) return;
    const engine = config.engine ?? {};
    const permissions = isRecord(engine.permissions) ? engine.permissions : {};
    const nextEngine = { ...engine, permissions: { ...permissions, terminal: turbo ? "auto" : "turbo" } };
    setConfig({ ...config, engine: nextEngine });
    gateway.setConfig({ engine: nextEngine }).then(setConfig).catch(() => setConfig(config));
  };
  const empty = messages.length === 0;
  const developerResizeSide = preferences.swapped ? "left" : "right";
  const activityResizeSide = preferences.swapped ? "right" : "left";

  const developerRail = (
    <div className="relative h-full w-full">
      <DeveloperRail
        workspace={config?.workspace}
        messages={messages}
        streaming={streaming}
        split={preferences.developerSplit}
        onSplitChange={(developerSplit) => patchShell({ developerSplit })}
        onClose={toggleDeveloper}
      />
      <ResizeHandle
        side={developerResizeSide}
        value={preferences.developerWidth}
        min={240}
        max={440}
        onChange={(developerWidth) => patchShell({ developerWidth })}
        label={t("shell.title.toggleDeveloper")}
      />
    </div>
  );

  const activityRail = (
    <div className="relative h-full w-full">
      <ActivityRail
        sessions={sessions}
        currentId={currentId}
        workingId={sessions.find((session) => session.status === "working")?.id ?? (streaming ? currentId : null)}
        onSelect={setCurrentId}
        onNew={newSession}
        onDelete={deleteSession}
        onRename={renameSession}
        onOpenActivity={(id) => openSettings(settingsSectionForActivity(id))}
        onHome={() => document.querySelector<HTMLInputElement>("[data-shell-session-search] input")?.focus()}
        onOpenSettings={() => openSettings("model")}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <ResizeHandle
        side={activityResizeSide}
        value={preferences.activityWidth}
        min={240}
        max={420}
        onChange={(activityWidth) => patchShell({ activityWidth })}
        label={t("shell.title.toggleActivity")}
      />
    </div>
  );

  const conversation = (
    <main className="conversation-shell flex h-full min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className={`conversation-scroll min-h-0 flex-1 ${empty ? "is-empty overflow-hidden" : "overflow-y-auto"}`}>
        <div className={`mx-auto max-w-[48rem] px-6 py-6 max-sm:px-4 ${empty ? "h-full" : ""}`}>
          {startupError && <div className="mb-4 rounded-md border border-danger/35 bg-danger/8 px-3 py-2 text-[11px] text-danger">{startupError}</div>}
          {empty ? (
            <div className="empty-state mx-auto flex h-full min-h-0 max-w-[43rem] flex-col justify-center pb-[3vh]">
              <div className="mb-6 flex items-center gap-3">
                <div className="kyrei-mark kyrei-mark-lg" aria-hidden><span>K</span></div>
                <div>
                  <div className="eyebrow">{t("shell.empty.eyebrow")}</div>
                  <div className="mt-1 text-[12px] text-secondary">{t("shell.empty.subtitle")}</div>
                </div>
              </div>
              <h1 className="max-w-[34rem] text-[clamp(2rem,3.4vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em] text-foreground">
                {t("shell.empty.titlePrimary")}<br /><span className="text-muted">{t("shell.empty.titleSecondary")}</span>
              </h1>
              <p className="mt-5 max-w-lg text-[13px] leading-6 text-secondary">{t("shell.empty.description")}</p>
              <div className="mt-7 grid grid-cols-3 gap-2 max-sm:grid-cols-1">
                <StarterPrompt icon={<Code2 size={15} />} title={t("shell.empty.exploreTitle")} text={t("shell.empty.explorePrompt")} onClick={send} />
                <StarterPrompt icon={<Sparkles size={15} />} title={t("shell.empty.designTitle")} text={t("shell.empty.designPrompt")} onClick={send} />
                <StarterPrompt icon={<TerminalSquare size={15} />} title={t("shell.empty.debugTitle")} text={t("shell.empty.debugPrompt")} onClick={send} />
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3 text-[10.5px] text-muted">
                <span className="inline-flex items-center gap-1.5"><FolderCode size={12} aria-hidden />{config?.workspace ? t("shell.empty.workspaceConnected") : t("shell.empty.workspaceMissing")}</span>
                <span className="h-3 w-px bg-border-soft" aria-hidden />
                <span>{t("shell.empty.slashHint")}</span>
              </div>
              {config && !config.hasKey && (
                <button onClick={() => openSettings("providers")} className="primary-action mt-6 flex w-fit items-center gap-2 px-3.5 py-2 text-[11px] font-medium">
                  {t("shell.empty.connectModel")} <ArrowRight size={13} aria-hidden />
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-7 pb-4">
              {messages.map((message) => <div key={message.id} className="msg-in"><Message message={message} /></div>)}
            </div>
          )}
        </div>
      </div>
      <Composer
        streaming={streaming}
        disabled={!config || !currentId || sessionModelPendingIds.has(currentId)}
        sessionId={currentId}
        model={currentModelId}
        provider={currentProviderId}
        providers={config?.providers ?? []}
        hasWorkspace={Boolean(config?.workspace)}
        onSend={send}
        onStop={stop}
        onCommand={runCommand}
        onModelChange={(providerId, modelId) => void changeSessionModel(providerId, modelId)}
      />
    </main>
  );

  return (
    <div className="app-shell flex h-full w-full flex-col">
      <Titlebar
        title={currentTitle}
        developerOpen={developerOpen}
        activityOpen={activityOpen}
        swapped={preferences.swapped}
        onToggleDeveloper={toggleDeveloper}
        onToggleActivity={toggleActivity}
        onSwapRails={() => patchShell({ swapped: !preferences.swapped })}
        onOpenSettings={() => openSettings("model")}
        onOpenKeybinds={() => openSettings("keybinds")}
      />
      <ShellLayout
        developer={developerRail}
        conversation={conversation}
        activity={activityRail}
        developerOpen={developerOpen}
        activityOpen={activityOpen}
        swapped={preferences.swapped}
        developerWidth={preferences.developerWidth}
        activityWidth={preferences.activityWidth}
      />
      <StatusBar
        status={gatewayStatus}
        connected={gatewayConnected}
        streaming={streaming}
        tokens={tokens}
        contextWindow={contextWindow}
        sessionStartedAt={currentSession?.createdAt}
        turnStartedAt={turnStartedAt}
        agents={agentRuns}
        turbo={turbo}
        developerOpen={developerOpen}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenCron={openCron}
        onOpenMissions={openMissions}
        onOpenProviders={() => openSettings("providers")}
        onToggleTurbo={toggleTurbo}
        onToggleDeveloper={toggleDeveloper}
      />
      {settingsOpen && config && (
        <Settings config={config} onClose={() => setSettingsOpen(false)} onSaved={setConfig} initialSection={settingsSection} />
      )}
      <CronPanel
        open={cronOpen}
        onClose={() => setCronOpen(false)}
        onOpenSession={(id) => { setCurrentId(id); setCronOpen(false); }}
      />
      <PipelineMissionPanel
        open={missionOpen}
        onClose={() => setMissionOpen(false)}
        onConfigure={() => openSettings("model")}
        pipelines={config?.pipelines}
        sessionId={currentId || undefined}
      />
      <CommandPalette
        open={paletteOpen && !settingsOpen && !cronOpen && !missionOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        onNew={newSession}
        onOpenSettings={() => openSettings("model")}
        onSelectSession={setCurrentId}
      />
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function terminalPermission(config: AppConfig | null): string {
  const engine = config?.engine;
  if (!engine || !isRecord(engine.permissions)) return "auto";
  return typeof engine.permissions.terminal === "string" ? engine.permissions.terminal : "auto";
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function StarterPrompt({ icon, title, text, onClick }: { icon: React.ReactNode; title: string; text: string; onClick: (text: string) => void }) {
  return (
    <button onClick={() => onClick(text)} className="starter-card group text-left">
      <span className="flex items-center justify-between text-secondary">
        <span className="starter-icon">{icon}</span>
        <ArrowRight size={13} className="opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
      </span>
      <span className="mt-5 block text-[11.5px] font-medium text-foreground">{title}</span>
      <span className="mt-1 block text-[10.5px] leading-[1.5] text-muted">{text}</span>
    </button>
  );
}
