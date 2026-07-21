import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  BarChart3,
  Bell,
  Blocks,
  Box,
  BrainCircuit,
  FolderOpen,
  Info,
  Keyboard,
  KeyRound,
  Layers3,
  MessageSquare,
  Palette,
  Network,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { gateway } from "@/lib/gateway";
import { rebaseImportedPipelines } from "@/lib/pipeline-import";
import type {
  AppConfig,
  GBrainRuntimeStatus,
  LocalPostgresRuntimeStatus,
  MemoryIndexRuntimeStatus,
  McpRuntimeStatus,
  ProjectMcpConfigStatus,
  EffectivePromptPreview,
  SessionMirrorRuntimeStatus,
  SessionMirrorParityResult,
  MessagingRuntimeStatus,
} from "@/lib/types";
import { Button, Input } from "@/components/ui";
import { BoolField, EnumField, Field, NumberField, TextField } from "@/components/settings/ConfigField";
import { ThemeGrid } from "@/components/settings/ThemeGrid";
import { KeybindPanel } from "@/components/settings/KeybindPanel";
import { ModelSettings } from "@/components/settings/models/ModelSettings";
import { ProvidersSettings } from "@/components/settings/providers/ProvidersSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { SessionsSettings } from "@/components/settings/SessionsSettings";
import { AboutUpdatePanel } from "@/components/settings/AboutUpdatePanel";
import { UsageSettings } from "@/components/settings/UsageSettings";
import { AccessTokensSettings } from "@/components/settings/AccessTokensSettings";
import { CapacitySettings } from "@/components/settings/CapacitySettings";
import { ExperimentalSettings } from "@/components/settings/ExperimentalSettings";
import { PermissionRulesEditor } from "@/components/settings/security/PermissionRulesEditor";
import { LtmDecisionsPanel } from "@/components/settings/LtmDecisionsPanel";
import { KyreiMark } from "@/components/brand/KyreiMark";
import {
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  type SettingsSectionId,
  type VisibleSettingsSectionId,
} from "@/components/settings/settings-registry";
import { applyTheme, getTheme } from "@/lib/theme";
import { applyCustomTheme, clearCustomTheme, isCustomThemeActive, parseVscodeTheme } from "@/lib/vscode-theme";
import { isSpeechRecognitionSupported, isSpeechSynthesisSupported, speak } from "@/lib/speech";
import {
  applyScale,
  resetUiSettings,
  setUiSetting,
  useUiSettings,
  playChime,
} from "@/store/settings";
import { LANGUAGES, useI18n, setLang, type Lang } from "@/i18n";
import { cn } from "@/lib/utils";
import { importPermissionRules } from "@/lib/permission-rules";

interface SettingsProps {
  config: AppConfig;
  onClose: () => void;
  onSaved: (config: AppConfig) => void;
  initialSection?: SettingsSectionId;
}

export type SectionId = SettingsSectionId;

const SECTION_ICONS: Record<VisibleSettingsSectionId, ReactNode> = {
  model: <Box className="size-4" />,
  providers: <Network className="size-4" />,
  workspace: <FolderOpen className="size-4" />,
  skills: <Blocks className="size-4" />,
  chat: <MessageSquare className="size-4" />,
  memory: <BrainCircuit className="size-4" />,
  sessions: <Archive className="size-4" />,
  usage: <BarChart3 className="size-4" />,
  organization: <KeyRound className="size-4" />,
  capacity: <Layers3 className="size-4" />,
  appearance: <Palette className="size-4" />,
  notifications: <Bell className="size-4" />,
  keybinds: <Keyboard className="size-4" />,
  advanced: <SlidersHorizontal className="size-4" />,
  about: <Info className="size-4" />,
};

function GroupTitle({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</h4>;
}

function permissionRulesInput(engine: Record<string, unknown>): unknown {
  if (!Object.hasOwn(engine, "permissions") || engine.permissions === undefined) return [];
  const permissions = engine.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return permissions;
  if (!Object.hasOwn(permissions, "rules") || (permissions as Record<string, unknown>).rules === undefined) return [];
  return (permissions as Record<string, unknown>).rules;
}

type EditableMcpServer = Record<string, unknown> & {
  id?: string;
  transport?: "stdio" | "streamable-http" | "unsupported";
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
};

function editableMcpServers(value: unknown): EditableMcpServer[] {
  if (!Array.isArray(value)) return [];
  return value.filter((server): server is EditableMcpServer => Boolean(server) && typeof server === "object" && !Array.isArray(server));
}

function defaultMcpServerId(servers: readonly EditableMcpServer[]): string {
  const used = new Set(servers.map((server) => typeof server.id === "string" ? server.id : ""));
  for (let index = 1; index <= 99; index += 1) {
    const candidate = `server-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `server-${Date.now().toString(36)}`;
}

export function Settings({ config, onClose, onSaved, initialSection = "model" }: SettingsProps) {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const visibleSection = resolveSettingsSection(section);
  const { t, lang } = useI18n();
  const ui = useUiSettings();
  const sttSupported = isSpeechRecognitionSupported();
  const ttsSupported = isSpeechSynthesisSupported();

  const [provider, setProvider] = useState(config.provider);
  const [model, setModel] = useState(config.model);
  const [workspace, setWorkspace] = useState(config.workspace);
  const [engineText, setEngineText] = useState(() => JSON.stringify(config.engine ?? {}, null, 2));
  const [engine, setEngine] = useState<Record<string, unknown>>(() => ({ ...(config.engine ?? {}) }));
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const [engineError, setEngineError] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const workspaceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkspaceSave = useRef<Partial<{ provider: string; model: string; workspace: string }> | null>(null);
  const pendingEngineSave = useRef<Record<string, unknown> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const themeImportRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [customActive, setCustomActive] = useState(isCustomThemeActive());
  const [customError, setCustomError] = useState(false);
  const [backupImportError, setBackupImportError] = useState(false);
  const [gbrainStatus, setGbrainStatus] = useState<GBrainRuntimeStatus | null>(null);
  const [gbrainBusy, setGbrainBusy] = useState(false);
  const [gbrainCheckFailed, setGbrainCheckFailed] = useState(false);
  const [memoryIndexStatus, setMemoryIndexStatus] = useState<MemoryIndexRuntimeStatus | null>(null);
  const [memoryIndexBusy, setMemoryIndexBusy] = useState(false);
  const [memoryIndexCheckFailed, setMemoryIndexCheckFailed] = useState(false);
  const [memoryReindexNote, setMemoryReindexNote] = useState<string | null>(null);
  const [sessionMirrorStatus, setSessionMirrorStatus] = useState<SessionMirrorRuntimeStatus | null>(null);
  const [sessionMirrorParity, setSessionMirrorParity] = useState<SessionMirrorParityResult | null>(null);
  const [sessionMirrorBusy, setSessionMirrorBusy] = useState(false);
  const [sessionMirrorNote, setSessionMirrorNote] = useState<string | null>(null);
  const [effectivePromptPreview, setEffectivePromptPreview] = useState<EffectivePromptPreview | null>(null);
  const [effectivePromptBusy, setEffectivePromptBusy] = useState(false);
  const [effectivePromptFailed, setEffectivePromptFailed] = useState(false);
  const [ltmConsolidateBusy, setLtmConsolidateBusy] = useState(false);
  const [ltmConsolidateNote, setLtmConsolidateNote] = useState<string | null>(null);
  const [messagingStatus, setMessagingStatus] = useState<MessagingRuntimeStatus | null>(null);
  const [messagingBusy, setMessagingBusy] = useState(false);
  const [messagingTokenOnce, setMessagingTokenOnce] = useState<string | null>(null);
  const [messagingNote, setMessagingNote] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpRuntimeStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [projectMcpStatus, setProjectMcpStatus] = useState<ProjectMcpConfigStatus | null>(null);
  const [projectMcpText, setProjectMcpText] = useState("");
  const [projectMcpBusy, setProjectMcpBusy] = useState(false);
  const [projectMcpError, setProjectMcpError] = useState(false);
  const [localPostgresStatus, setLocalPostgresStatus] = useState<LocalPostgresRuntimeStatus | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    const shellWasInert = appShell?.hasAttribute("inert") ?? false;
    const previousAriaHidden = appShell?.getAttribute("aria-hidden") ?? null;
    (closeRef.current ?? dialogRef.current)?.focus({ preventScroll: true });
    appShell?.setAttribute("inert", "");
    appShell?.setAttribute("aria-hidden", "true");

    const onKey = (event: KeyboardEvent) => {
      // Radix portals own their keyboard interaction while a nested dialog is open.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (appShell) {
        if (!shellWasInert) appShell.removeAttribute("inert");
        if (previousAriaHidden === null) appShell.removeAttribute("aria-hidden");
        else appShell.setAttribute("aria-hidden", previousAriaHidden);
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => () => {
    if (workspaceSaveTimer.current) clearTimeout(workspaceSaveTimer.current);
    if (engineSaveTimer.current) clearTimeout(engineSaveTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const flash = useCallback(() => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1200);
  }, []);

  const persist = useCallback(
    async (patch: Partial<{
      provider: string;
      apiKey: string;
      model: string;
      activeProviderId: string;
      activeModelId: string;
      providers: AppConfig["providers"];
      modelAssignments: AppConfig["modelAssignments"];
      orchestration: AppConfig["orchestration"];
      pipelines: AppConfig["pipelines"];
      workspace: string;
      engine: Record<string, unknown>;
    }>) => {
      try {
        const next = await gateway.setConfig(patch);
        setSaveFailed(false);
        onSaved(next);
        flash();
        return true;
      } catch {
        // The draft remains editable while the local gateway is unavailable.
        setSaveFailed(true);
        return false;
      }
    },
    [onSaved, flash],
  );

  const scheduleSave = useCallback(
    (patch: Partial<{ provider: string; model: string; workspace: string }>) => {
      pendingWorkspaceSave.current = { ...(pendingWorkspaceSave.current ?? {}), ...patch };
      if (workspaceSaveTimer.current) clearTimeout(workspaceSaveTimer.current);
      workspaceSaveTimer.current = setTimeout(() => {
        const pending = pendingWorkspaceSave.current;
        pendingWorkspaceSave.current = null;
        workspaceSaveTimer.current = null;
        if (pending) void persist(pending);
      }, 500);
    },
    [persist],
  );

  const flushWorkspaceSave = useCallback(async () => {
    if (workspaceSaveTimer.current) clearTimeout(workspaceSaveTimer.current);
    workspaceSaveTimer.current = null;
    const pending = pendingWorkspaceSave.current;
    pendingWorkspaceSave.current = null;
    return pending ? persist(pending) : true;
  }, [persist]);

  const flushEngineSave = useCallback(async () => {
    if (engineSaveTimer.current) clearTimeout(engineSaveTimer.current);
    engineSaveTimer.current = null;
    const pending = pendingEngineSave.current;
    pendingEngineSave.current = null;
    return pending ? persist({ engine: pending }) : true;
  }, [persist]);

  const closeSettings = useCallback(async () => {
    await Promise.all([flushWorkspaceSave(), flushEngineSave()]);
    onClose();
  }, [flushEngineSave, flushWorkspaceSave, onClose]);
  onCloseRef.current = () => void closeSettings();

  const saveEngine = useCallback(() => {
    try {
      const parsed = engineText.trim() ? JSON.parse(engineText) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("engine-object-required");
      const next = parsed as Record<string, unknown>;
      setEngineError(false);
      if (engineSaveTimer.current) clearTimeout(engineSaveTimer.current);
      engineSaveTimer.current = null;
      pendingEngineSave.current = null;
      engineRef.current = next;
      setEngine(next);
      void persist({ engine: next });
    } catch {
      setEngineError(true);
    }
  }, [engineText, persist]);

  // Keep this accessor identity-stable. Health effects depend on the callback;
  // closing over `engine` made every status update look like a configuration
  // change and re-fired all memory probes in a loop.
  const getEngineField = useCallback((path: string, fallback: unknown): unknown => {
    let current: unknown = engineRef.current;
    for (const key of path.split(".")) {
      if (current == null || typeof current !== "object") return fallback;
      current = (current as Record<string, unknown>)[key];
    }
    return current ?? fallback;
  }, []);
  const setEngineField = (path: string, value: unknown, persistImmediately = false) => {
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(engineRef.current));
    const keys = path.split(".");
    let current = next;
    for (let index = 0; index < keys.length - 1; index++) {
      if (typeof current[keys[index]] !== "object" || current[keys[index]] == null) current[keys[index]] = {};
      current = current[keys[index]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
    engineRef.current = next;
    setEngine(next);
    setEngineText(JSON.stringify(next, null, 2));
    if (engineSaveTimer.current) clearTimeout(engineSaveTimer.current);
    pendingEngineSave.current = next;
    if (persistImmediately) void flushEngineSave();
    else engineSaveTimer.current = setTimeout(() => void flushEngineSave(), 500);
  };

  const mcpServers = editableMcpServers(getEngineField("mcp.servers", []));
  const replaceMcpServer = (index: number, nextServer: EditableMcpServer) => {
    setEngineField("mcp.servers", mcpServers.map((server, serverIndex) => serverIndex === index ? nextServer : server));
  };
  const removeMcpServer = (index: number) => {
    setEngineField("mcp.servers", mcpServers.filter((_, serverIndex) => serverIndex !== index));
  };
  const addMcpServer = () => {
    setEngineField("mcp.servers", [...mcpServers, { id: defaultMcpServerId(mcpServers), transport: "stdio", command: "" }]);
  };

  const checkGBrain = useCallback(async () => {
    // A changed command is meaningful only after the gateway has the same
    // persisted configuration as this settings screen.
    if (!await flushEngineSave()) return;
    setGbrainBusy(true);
    setGbrainCheckFailed(false);
    try {
      setGbrainStatus(await gateway.getGBrainStatus());
    } catch {
      // The status endpoint normally returns a structured unavailable state.
      // This fallback covers a temporarily unreachable local gateway only.
      setGbrainCheckFailed(true);
    } finally {
      setGbrainBusy(false);
    }
  }, [flushEngineSave]);

  const checkMemoryIndex = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setMemoryIndexBusy(true);
    setMemoryIndexCheckFailed(false);
    try {
      setMemoryIndexStatus(await gateway.getMemoryIndexStatus());
    } catch {
      setMemoryIndexCheckFailed(true);
    } finally {
      setMemoryIndexBusy(false);
    }
  }, [flushEngineSave]);

  const checkMcp = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setMcpBusy(true);
    try {
      setMcpStatus(await gateway.getMcpStatus());
    } catch {
      setMcpStatus({ enabled: true, state: "error", servers: [], message: "gateway_unreachable" });
    } finally {
      setMcpBusy(false);
    }
  }, [flushEngineSave]);

  const checkProjectMcp = useCallback(async () => {
    setProjectMcpBusy(true);
    setProjectMcpError(false);
    try {
      const status = await gateway.getProjectMcpConfig();
      setProjectMcpStatus(status);
      setProjectMcpText(JSON.stringify(status.config, null, 2));
    } catch {
      setProjectMcpError(true);
    } finally {
      setProjectMcpBusy(false);
    }
  }, []);

  const saveProjectMcp = useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(projectMcpText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    } catch {
      setProjectMcpError(true);
      return;
    }
    setProjectMcpBusy(true);
    setProjectMcpError(false);
    try {
      const status = await gateway.saveProjectMcpConfig(parsed as ProjectMcpConfigStatus["config"]);
      setProjectMcpStatus(status);
      setProjectMcpText(JSON.stringify(status.config, null, 2));
      await checkMcp();
    } catch {
      setProjectMcpError(true);
    } finally {
      setProjectMcpBusy(false);
    }
  }, [checkMcp, projectMcpText]);

  const setProjectMcpTrust = useCallback(async (trusted: boolean) => {
    setProjectMcpBusy(true);
    setProjectMcpError(false);
    try {
      const status = await gateway.setProjectMcpTrust(trusted);
      setProjectMcpStatus(status);
      await checkMcp();
    } catch {
      setProjectMcpError(true);
    } finally {
      setProjectMcpBusy(false);
    }
  }, [checkMcp]);

  const checkLocalPostgres = useCallback(async () => {
    try {
      setLocalPostgresStatus(await gateway.getLocalPostgresStatus());
    } catch {
      setLocalPostgresStatus({ state: "unavailable", reason: "gateway_unreachable" });
    }
  }, []);

  const reindexMemoryIndex = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setMemoryIndexBusy(true);
    setMemoryIndexCheckFailed(false);
    setMemoryReindexNote(null);
    try {
      const result = await gateway.reindexMemoryIndex();
      setMemoryIndexStatus(result.status);
      setMemoryReindexNote(
        result.ok
          ? t("settings.projectMemory.reindexOk", {
              upserted: result.upserted,
              sources: result.sources.join(", ") || "—",
            })
          : t("settings.projectMemory.reindexFailed"),
      );
    } catch {
      setMemoryIndexCheckFailed(true);
      setMemoryReindexNote(t("settings.projectMemory.reindexFailed"));
    } finally {
      setMemoryIndexBusy(false);
    }
  }, [flushEngineSave, t]);

  const checkSessionMirror = useCallback(async ({ persist = true, silent = false }: {
    persist?: boolean;
    silent?: boolean;
  } = {}) => {
    if (persist && !await flushEngineSave()) return;
    if (!silent) setSessionMirrorBusy(true);
    try {
      const [status, parity] = await Promise.all([
        gateway.getSessionMirrorStatus(),
        gateway.getSessionMirrorParity().catch(() => null),
      ]);
      setSessionMirrorStatus(status);
      setSessionMirrorParity(parity);
    } catch {
      setSessionMirrorStatus({
        enabled: Boolean(getEngineField("memory.sessionMirror.enabled", true)),
        readSearch: Boolean(getEngineField("memory.sessionMirror.readSearch", true)),
        enginePrimary: Boolean(getEngineField("memory.sessionMirror.enginePrimary", true)),
        state: "error",
        sessionCount: 0,
        message: "check_failed",
      });
      setSessionMirrorParity(null);
    } finally {
      if (!silent) setSessionMirrorBusy(false);
    }
  }, [flushEngineSave, getEngineField]);

  const syncSessionMirror = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setSessionMirrorBusy(true);
    setSessionMirrorNote(null);
    try {
      const result = await gateway.syncSessionMirror();
      setSessionMirrorNote(
        result.alreadyRunning
          ? t("settings.projectMemory.sessionMirror.syncAlreadyRunning")
          : result.resumed
            ? t("settings.projectMemory.sessionMirror.syncResumed")
            : t("settings.projectMemory.sessionMirror.syncStarted", {
                sessions: result.sessions,
                messages: result.messages,
              }),
      );
      await checkSessionMirror({ persist: false, silent: true });
    } catch {
      setSessionMirrorNote(t("settings.projectMemory.sessionMirror.syncFailed"));
    } finally {
      setSessionMirrorBusy(false);
    }
  }, [checkSessionMirror, flushEngineSave, t]);

  const inspectEffectivePrompt = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setEffectivePromptBusy(true);
    setEffectivePromptFailed(false);
    try {
      setEffectivePromptPreview(await gateway.getEffectivePromptPreview());
    } catch {
      setEffectivePromptFailed(true);
    } finally {
      setEffectivePromptBusy(false);
    }
  }, [flushEngineSave]);

  const consolidateLtm = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setLtmConsolidateBusy(true);
    setLtmConsolidateNote(null);
    try {
      const result = await gateway.consolidateLtm();
      setLtmConsolidateNote(
        result.ok
          ? t("settings.projectMemory.ltm.consolidateOk", { via: result.via ?? "typescript" })
          : t("settings.projectMemory.ltm.consolidateFailed", {
              error: result.error ?? "unknown",
            }),
      );
    } catch {
      setLtmConsolidateNote(t("settings.projectMemory.ltm.consolidateFailed", { error: "request_failed" }));
    } finally {
      setLtmConsolidateBusy(false);
    }
  }, [flushEngineSave, t]);

  const checkMessaging = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setMessagingBusy(true);
    try {
      setMessagingStatus(await gateway.getMessagingStatus());
    } catch {
      setMessagingStatus(null);
    } finally {
      setMessagingBusy(false);
    }
  }, [flushEngineSave]);

  const rotateMessagingToken = useCallback(async () => {
    if (!await flushEngineSave()) return;
    setMessagingBusy(true);
    setMessagingNote(null);
    try {
      const result = await gateway.rotateMessagingToken();
      setMessagingStatus(result.status);
      setMessagingTokenOnce(result.token);
      setMessagingNote(t("settings.messaging.tokenOk"));
    } catch {
      setMessagingNote(t("settings.messaging.tokenFailed"));
    } finally {
      setMessagingBusy(false);
    }
  }, [flushEngineSave, t]);

  useEffect(() => {
    if (visibleSection === "memory") {
      void checkGBrain();
      void checkMemoryIndex();
      void checkSessionMirror();
      void checkMcp();
      void checkProjectMcp();
      void checkLocalPostgres();
    }
    if (visibleSection === "notifications") {
      void checkMessaging();
    }
  }, [checkGBrain, checkMemoryIndex, checkSessionMirror, checkMcp, checkProjectMcp, checkLocalPostgres, checkMessaging, visibleSection]);

  useEffect(() => {
    if (visibleSection !== "memory" || sessionMirrorStatus?.sync?.state !== "running") return;
    const timer = window.setInterval(() => {
      void checkSessionMirror({ persist: false, silent: true });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [checkSessionMirror, sessionMirrorStatus?.sync?.state, visibleSection]);

  const initializeGBrain = useCallback(async () => {
    // Persist a just-edited command before invoking it; otherwise a delayed
    // settings save could initialize a different executable than the user saw.
    if (!await flushEngineSave()) return;
    setGbrainBusy(true);
    setGbrainCheckFailed(false);
    try {
      const result = await gateway.initializeGBrain();
      setGbrainStatus(result.status);
      const nextEngine = { ...(result.config.engine ?? {}) };
      pendingEngineSave.current = null;
      engineRef.current = nextEngine;
      setEngine(nextEngine);
      setEngineText(JSON.stringify(nextEngine, null, 2));
      setSaveFailed(false);
      onSaved(result.config);
      flash();
    } catch {
      setGbrainCheckFailed(true);
    } finally {
      setGbrainBusy(false);
    }
  }, [flash, flushEngineSave, onSaved]);

  const importTheme = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const seeds = parseVscodeTheme(String(reader.result), file.name.replace(/\.jsonc?$/, ""));
      if (!seeds) {
        setCustomError(true);
        return;
      }
      applyCustomTheme(seeds);
      setCustomActive(true);
      setCustomError(false);
    };
    reader.readAsText(file);
  };

  const pickFolder = async () => {
    const result = await gateway.chooseFolder();
    if (result.folder) {
      setWorkspace(result.folder);
      onSaved(result);
      flash();
    }
  };

  const exportConfig = () => {
    const data = {
      version: 3,
      provider,
      model,
      activeProviderId: config.activeProviderId,
      activeModelId: config.activeModelId,
      providers: config.providers.map(({ hasKey: _hasKey, ...profile }) => profile),
      modelAssignments: config.modelAssignments,
      orchestration: config.orchestration,
      pipelines: config.pipelines,
      workspace,
      engine: safeEngine(engineText),
      ui,
      lang,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kyrei-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importConfig = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result));
        const importedPipelines = rebaseImportedPipelines(
          data.pipelines,
          config.pipelines ?? { version: 1, generation: 0, definitions: [] },
        );
        const importedEngine = data.engine && typeof data.engine === "object" && !Array.isArray(data.engine)
          ? data.engine as Record<string, unknown>
          : undefined;
        const saved = await persist({
          provider: String(data.provider ?? provider),
          model: String(data.model ?? model),
          ...(Array.isArray(data.providers) ? { providers: data.providers } : {}),
          ...(data.modelAssignments && typeof data.modelAssignments === "object" ? { modelAssignments: data.modelAssignments } : {}),
          ...(data.orchestration && typeof data.orchestration === "object" ? { orchestration: data.orchestration } : {}),
          ...(importedPipelines ? { pipelines: importedPipelines } : {}),
          ...(typeof data.activeProviderId === "string" ? { activeProviderId: data.activeProviderId } : {}),
          ...(typeof data.activeModelId === "string" ? { activeModelId: data.activeModelId } : {}),
          workspace: String(data.workspace ?? workspace),
          engine: importedEngine ?? safeEngine(engineText),
        });
        if (!saved) {
          setBackupImportError(true);
          return;
        }
        if (typeof data.provider === "string") setProvider(data.provider);
        if (typeof data.model === "string") setModel(data.model);
        if (typeof data.workspace === "string") setWorkspace(data.workspace);
        if (importedEngine) {
          setEngine(importedEngine);
          setEngineText(JSON.stringify(importedEngine, null, 2));
        }
        if (data.ui && typeof data.ui === "object") {
          for (const [key, value] of Object.entries(data.ui)) setUiSetting(key as never, value as never);
          if (typeof data.ui.scale === "number") applyScale(data.ui.scale);
        }
        if (data.lang === "ru" || data.lang === "en") setLang(data.lang);
        setBackupImportError(false);
      } catch {
        setBackupImportError(true);
      }
    };
    reader.readAsText(file);
  };

  const sectionMeta = SETTINGS_SECTIONS.find((entry) => entry.id === visibleSection)!;
  const permissionRules = importPermissionRules(permissionRulesInput(engine));
  const gbrainStatusTitle = gbrainCheckFailed
    ? t("settings.gbrain.status.error")
    : !gbrainStatus
      ? t("settings.gbrain.status.checking")
      : gbrainStatus.state === "ready"
        ? t(gbrainStatus.doctorStatus === "warnings" ? "settings.gbrain.status.readyWarnings" : "settings.gbrain.status.ready")
        : gbrainStatus.state === "not_initialized"
          ? t(gbrainStatus.provider === "builtin" ? "settings.gbrain.status.builtinNotInitialized" : "settings.gbrain.status.notInitialized")
          : gbrainStatus.state === "unavailable"
            ? t("settings.gbrain.status.unavailable")
            : t("settings.gbrain.status.error");
  const gbrainStatusHint = gbrainStatus?.state === "ready" && gbrainStatus.mode === "off"
    ? t("settings.gbrain.status.accessDisabled")
    : gbrainStatus?.state === "not_initialized"
      ? t(gbrainStatus.provider === "builtin" ? "settings.gbrain.status.builtinInitializeHint" : "settings.gbrain.status.initializeHint")
      : gbrainStatus?.state === "unavailable"
        ? t("settings.gbrain.status.unavailableHint")
        : undefined;
  const runtimeHealthHint = (status: {
    degraded?: boolean;
    stale?: boolean;
    healthReason?: string;
    consecutiveFailures?: number;
  } | null | undefined) => status?.stale
    ? t("settings.runtimeHealth.stale", {
        reason: status.healthReason || t("settings.runtimeHealth.unknownReason"),
      })
    : status?.degraded
      ? t("settings.runtimeHealth.degraded", {
          count: status.consecutiveFailures ?? 1,
          reason: status.healthReason || t("settings.runtimeHealth.unknownReason"),
        })
      : null;

  const overlay = (
    <div
      className="fixed inset-x-0 top-[var(--app-titlebar-h)] bottom-[var(--app-statusbar-h)] z-[100] grid min-h-0 place-items-center bg-black/78 p-3 sm:p-5"
      onClick={(event) => { if (event.target === event.currentTarget) void closeSettings(); }}
    >
      <div
        ref={dialogRef}
        className="flex h-full max-h-full min-h-0 w-full min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-nous overlay-blur"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <nav className="hidden min-h-0 w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-bg/45 p-3 min-[761px]:flex">
          <div className="px-2 pb-3 pt-1 text-[15px] font-semibold">{t("settings.title")}</div>
          {SETTINGS_SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                visibleSection === entry.id
                  ? "bg-elevated text-foreground"
                  : "text-secondary hover:bg-(--ui-row-hover)",
              )}
            >
              <span className="text-muted">{SECTION_ICONS[entry.id]}</span>
              {t(entry.labelKey)}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
            <select
              aria-label={t("settings.sectionNav")}
              value={visibleSection}
              onChange={(event) => setSection(event.target.value as VisibleSettingsSectionId)}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 text-[13px] text-foreground outline-none min-[761px]:hidden"
            >
              {SETTINGS_SECTIONS.map((entry) => (
                <option key={entry.id} value={entry.id}>{t(entry.labelKey)}</option>
              ))}
            </select>
            <span className="hidden text-[14px] font-semibold min-[761px]:block">{t(sectionMeta.labelKey)}</span>
            <div className="ml-auto flex items-center gap-3">
              <span
                className={cn(
                  "text-[12px] transition-opacity",
                  saveFailed ? "text-danger" : "text-success",
                  saveFailed || savedFlash ? "opacity-100" : "opacity-0",
                )}
                role={saveFailed ? "alert" : "status"}
              >
                {t(saveFailed ? "settings.saveFailed" : "settings.saved")}
              </span>
              <button
                ref={closeRef}
                type="button"
                onClick={() => void closeSettings()}
                className="rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
                aria-label={t("common.close")}
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="mx-auto w-full max-w-5xl">
              {visibleSection === "model" && (
                <ModelSettings
                  config={config}
                  onSaved={(next) => {
                    setProvider(next.provider);
                    setModel(next.model);
                    onSaved(next);
                    flash();
                  }}
                />
              )}

              {visibleSection === "providers" && (
                <ProvidersSettings
                  config={config}
                  onSaved={(next) => {
                    setProvider(next.provider);
                    setModel(next.model);
                    onSaved(next);
                    flash();
                  }}
                />
              )}

              {visibleSection === "workspace" && (
                <div className="space-y-6">
                  <section>
                    <GroupTitle>{t("settings.groups.workspaceSafety")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <TextField
                        label={t("settings.workspace.label")}
                        hint={t("settings.workspace.hint")}
                        value={workspace}
                        placeholder={t("settings.workspace.empty")}
                        onChange={(value) => { setWorkspace(value); scheduleSave({ workspace: value }); }}
                        trailing={<Button variant="secondary" onClick={() => void pickFolder()}><FolderOpen size={15} /> {t("settings.workspace.choose")}</Button>}
                      />
                      <EnumField
                        label={t("settings.permissions.terminal.label")}
                        hint={t("settings.permissions.terminal.hint")}
                        disabled={permissionRules.issues.length > 0}
                        value={String(getEngineField("permissions.terminal", "auto")) as "off" | "auto" | "turbo"}
                        options={[
                          { value: "off", label: t("settings.options.off") },
                          { value: "auto", label: t("settings.options.auto") },
                          { value: "turbo", label: t("settings.options.turbo") },
                        ]}
                        onChange={(value) => setEngineField("permissions.terminal", value)}
                      />
                      <EnumField
                        label={t("settings.executionMode.label")}
                        hint={t("settings.executionMode.hint")}
                        value={String(getEngineField("executionMode", "autopilot")) as "autopilot" | "supervised"}
                        options={[
                          { value: "autopilot", label: t("settings.executionMode.autopilot") },
                          { value: "supervised", label: t("settings.executionMode.supervised") },
                        ]}
                        onChange={(value) => setEngineField("executionMode", value)}
                      />
                      <Field label={t("settings.protectedPaths.label")} hint={t("settings.protectedPaths.hint")} stacked>
                        <textarea
                          className="min-h-[72px] w-full rounded-md border border-border-soft bg-elevated/40 px-2.5 py-2 font-mono text-[12px] text-foreground"
                          value={(Array.isArray(getEngineField("permissions.protectedPaths", []))
                            ? (getEngineField("permissions.protectedPaths", []) as string[])
                            : []
                          ).join("\n")}
                          onChange={(event) => {
                            const lines = event.target.value
                              .split("\n")
                              .map((line) => line.trim())
                              .filter(Boolean)
                              .slice(0, 64);
                            setEngineField("permissions.protectedPaths", lines);
                          }}
                          spellCheck={false}
                        />
                      </Field>
                      <EnumField
                        label={t("settings.permissions.review.label")}
                        hint={t("settings.permissions.review.hint")}
                        disabled={permissionRules.issues.length > 0}
                        value={String(getEngineField("permissions.review", "agent")) as "always" | "agent" | "request"}
                        options={[
                          { value: "always", label: t("settings.options.always") },
                          { value: "agent", label: t("settings.options.agent") },
                          { value: "request", label: t("settings.options.request") },
                        ]}
                        onChange={(value) => setEngineField("permissions.review", value)}
                      />
                      <EnumField
                        label={t("settings.permissions.sandbox.label")}
                        hint={t("settings.permissions.sandbox.hint")}
                        value={String(getEngineField("sandbox", "off")) as "off" | "strict" | "strict-required"}
                        options={[
                          { value: "off", label: t("settings.options.off") },
                          { value: "strict", label: t("settings.options.strict") },
                          { value: "strict-required", label: t("settings.options.strictRequired") },
                        ]}
                        onChange={(value) => setEngineField("sandbox", value)}
                      />
                      <EnumField
                        label={t("settings.permissions.web.label")}
                        hint={t("settings.permissions.web.hint")}
                        disabled={permissionRules.issues.length > 0}
                        value={String(getEngineField("permissions.web", "read")) as "off" | "search" | "read"}
                        options={[
                          { value: "off", label: t("settings.options.off") },
                          { value: "search", label: t("settings.options.search") },
                          { value: "read", label: t("settings.options.read") },
                        ]}
                        onChange={(value) => setEngineField("permissions.web", value)}
                      />
                      <PermissionRulesEditor
                        rules={permissionRules.rules}
                        importIssueCount={permissionRules.issues.length}
                        onChange={(rules) => setEngineField("permissions.rules", rules, true)}
                      />
                      <NumberField
                        label={t("settings.fileReadLimit.label")}
                        hint={t("settings.fileReadLimit.hint")}
                        value={Number(getEngineField("fileReadMaxChars", 250000))}
                        min={10000} max={2000000} step={10000}
                        format={(value) => `${Math.round(value / 1000)}k`}
                        onChange={(value) => setEngineField("fileReadMaxChars", value)}
                      />
                      <NumberField
                        label={t("settings.toolOutputLimit.label")}
                        hint={t("settings.toolOutputLimit.hint")}
                        value={Number(getEngineField("maxToolOutput", 12000))}
                        min={2000} max={100000} step={1000}
                        onChange={(value) => setEngineField("maxToolOutput", value)}
                      />
                    </div>
                  </section>
                </div>
              )}

              {visibleSection === "skills" && (
                <SkillsSettings
                  workspace={workspace}
                  getEngineField={getEngineField}
                  setEngineField={setEngineField}
                />
              )}

              {visibleSection === "sessions" && (
                <SessionsSettings
                  onRestored={async () => {
                    // Sidebar list is owned by App; fire a soft refresh if listeners exist.
                    window.dispatchEvent(new CustomEvent("kyrei:sessions-refresh"));
                  }}
                />
              )}

              {visibleSection === "usage" && (
                <UsageSettings
                  config={config}
                  getCurrentEngine={() => engineRef.current}
                  onSaved={(next) => {
                    setProvider(next.provider);
                    setModel(next.model);
                    // Rehydrate local engine SoT so Memory toggles cannot clobber
                    // reliability/budget saved from UsageSettings.
                    const nextEngine = { ...((next.engine ?? {}) as Record<string, unknown>) };
                    setEngine(nextEngine);
                    engineRef.current = nextEngine;
                    setEngineText(JSON.stringify(nextEngine, null, 2));
                    pendingEngineSave.current = null;
                    onSaved(next);
                    flash();
                  }}
                />
              )}

              {visibleSection === "organization" && (
                <AccessTokensSettings
                  config={config}
                  onSaved={(next) => {
                    setProvider(next.provider);
                    setModel(next.model);
                    onSaved(next);
                    flash();
                  }}
                />
              )}

              {visibleSection === "capacity" && (
                <CapacitySettings
                  config={config}
                  onSaved={(next) => {
                    setProvider(next.provider);
                    setModel(next.model);
                    const nextEngine = { ...((next.engine ?? {}) as Record<string, unknown>) };
                    setEngine(nextEngine);
                    engineRef.current = nextEngine;
                    setEngineText(JSON.stringify(nextEngine, null, 2));
                    pendingEngineSave.current = null;
                    onSaved(next);
                    flash();
                  }}
                />
              )}

              {visibleSection === "chat" && (
                <div className="space-y-6">
                  <section>
                    <GroupTitle>{t("settings.groups.chat")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <EnumField
                        label={t("settings.codingMode.label")}
                        hint={t("settings.codingMode.hint")}
                        value={((): "auto" | "plan" | "build" | "polish" | "deepreep" => {
                          const raw = String(getEngineField("codingMode", "auto"));
                          if (raw === "plan" || raw === "build" || raw === "polish" || raw === "deepreep") return raw;
                          return "auto";
                        })()}
                        options={[
                          { value: "auto", label: t("settings.codingMode.auto") },
                          { value: "plan", label: t("settings.codingMode.plan") },
                          { value: "build", label: t("settings.codingMode.build") },
                          { value: "polish", label: t("settings.codingMode.polish") },
                          { value: "deepreep", label: t("settings.codingMode.deepreep") },
                        ]}
                        onChange={(value) => {
                          setEngineField("codingMode", value);
                          const assignments = config.modelAssignments;
                          const pick = value === "build" || value === "polish" || value === "plan" || value === "deepreep"
                            ? (assignments as Record<string, { providerId?: string; modelId?: string } | undefined> | undefined)?.[value]
                            : undefined;
                          if (pick?.providerId && pick?.modelId) {
                            void gateway.setConfig({
                              activeProviderId: pick.providerId,
                              activeModelId: pick.modelId,
                            }).then((next) => onSaved(next)).catch(() => undefined);
                          }
                        }}
                      />
                      <Field label={t("settings.promptInspector.label")} hint={t("settings.promptInspector.hint")} stacked>
                        <div className="space-y-2 rounded-lg border border-border-soft bg-elevated/45 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[12px] text-muted">
                              {effectivePromptPreview
                                ? t("settings.promptInspector.summary", {
                                    version: effectivePromptPreview.version,
                                    chars: effectivePromptPreview.chars,
                                    tools: effectivePromptPreview.availableTools.length,
                                  })
                                : t("settings.promptInspector.empty")}
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void inspectEffectivePrompt()}
                              disabled={effectivePromptBusy}
                            >
                              {effectivePromptBusy
                                ? t("settings.promptInspector.loading")
                                : effectivePromptPreview
                                  ? t("settings.promptInspector.refresh")
                                  : t("settings.promptInspector.open")}
                            </Button>
                          </div>
                          {effectivePromptFailed && (
                            <p className="text-[12px] text-danger">{t("settings.promptInspector.failed")}</p>
                          )}
                          {effectivePromptPreview && (
                            <>
                              <p className="text-[12px] text-muted">{t("settings.promptInspector.omissions")}</p>
                              <details className="rounded-md border border-border-soft bg-bg/60">
                                <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-foreground">
                                  {t("settings.promptInspector.stable")}
                                </summary>
                                <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border-soft px-3 py-2 text-[11px] leading-4 text-secondary">
                                  {effectivePromptPreview.stable}
                                </pre>
                              </details>
                              {effectivePromptPreview.volatile && (
                                <details className="rounded-md border border-border-soft bg-bg/60">
                                  <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-foreground">
                                    {t("settings.promptInspector.volatile")}
                                  </summary>
                                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border-soft px-3 py-2 text-[11px] leading-4 text-secondary">
                                    {effectivePromptPreview.volatile}
                                  </pre>
                                </details>
                              )}
                            </>
                          )}
                        </div>
                      </Field>
                      <Field label={t("settings.personality.label")} hint={t("settings.personality.hint")} stacked>
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-1.5">
                            {([
                              "none",
                              "helpful",
                              "concise",
                              "technical",
                              "teacher",
                              "reviewer",
                              "implementer",
                              "custom",
                            ] as const).map((id) => {
                              const active = String(getEngineField("personalityPresetId", "none") || "none") === id
                                || (id === "custom"
                                  && !["none", "helpful", "concise", "technical", "teacher", "reviewer", "implementer"]
                                    .includes(String(getEngineField("personalityPresetId", "none"))));
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  className={cn(
                                    "rounded-md border px-2 py-1 text-[11px] transition-colors",
                                    active
                                      ? "border-primary/50 bg-primary/10 text-primary"
                                      : "border-border-soft bg-elevated/40 text-secondary hover:bg-(--ui-row-hover)",
                                  )}
                                  onClick={() => {
                                    if (id === "none") {
                                      setEngineField("personalityPresetId", "none");
                                      setEngineField("personality", "");
                                      return;
                                    }
                                    if (id === "custom") {
                                      setEngineField("personalityPresetId", "custom");
                                      return;
                                    }
                                    const bodies: Record<string, string> = {
                                      helpful: "You are a helpful, friendly AI assistant. Be clear, accurate, and collaborative.",
                                      concise: "You are a concise assistant. Keep responses brief and to the point; prefer bullets and short patches.",
                                      technical: "You are a technical expert. Provide detailed, accurate technical information with precise identifiers and trade-offs.",
                                      teacher: "You are a patient teacher. Explain concepts clearly with examples, then give the concrete next step.",
                                      reviewer: "You are a careful code reviewer. Prioritize correctness, security, and maintainability; call out risks explicitly.",
                                      implementer: "You are a pragmatic implementer. Prefer small, verifiable changes, run checks when possible, and avoid drive-by refactors.",
                                    };
                                    setEngineField("personalityPresetId", id);
                                    setEngineField("personality", bodies[id] ?? "");
                                  }}
                                >
                                  {t(`settings.personality.preset.${id}` as const)}
                                </button>
                              );
                            })}
                          </div>
                          {(String(getEngineField("personalityPresetId", "none")) === "custom"
                            || String(getEngineField("personalityPresetId", "none")) === "none"
                            || Boolean(String(getEngineField("personality", "")).trim())) && (
                            <textarea
                              value={String(getEngineField("personality", ""))}
                              onChange={(event) => {
                                setEngineField("personality", event.target.value);
                                const id = String(getEngineField("personalityPresetId", "none"));
                                if (id !== "custom" && id !== "none") {
                                  setEngineField("personalityPresetId", "custom");
                                } else if (!event.target.value.trim() && id === "custom") {
                                  setEngineField("personalityPresetId", "none");
                                } else if (event.target.value.trim() && id === "none") {
                                  setEngineField("personalityPresetId", "custom");
                                }
                              }}
                              spellCheck={false}
                              rows={3}
                              placeholder={t("settings.personality.placeholder")}
                              className="w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary"
                            />
                          )}
                        </div>
                      </Field>
                      <BoolField label={t("settings.sendOnEnter.label")} hint={t("settings.sendOnEnter.hint")} value={ui.sendOnEnter} onChange={(value) => setUiSetting("sendOnEnter", value)} />
                      <BoolField label={t("settings.richRendering.label")} hint={t("settings.richRendering.hint")} value={ui.richRendering} onChange={(value) => setUiSetting("richRendering", value)} />
                      <BoolField label={t("settings.showReasoning.label")} hint={t("settings.showReasoning.hint")} value={ui.showReasoning} onChange={(value) => setUiSetting("showReasoning", value)} />
                      <TextField
                        label={t("settings.timezone.label")}
                        hint={t("settings.timezone.hint")}
                        value={String(getEngineField("timezone", ""))}
                        placeholder={t("settings.timezone.placeholder")}
                        onChange={(value) => setEngineField("timezone", value)}
                      />
                      <EnumField
                        label={t("settings.defaultReasoning.label")}
                        hint={t("settings.defaultReasoning.hint")}
                        value={((): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "off" => {
                          const raw = String(getEngineField("defaultReasoningEffort", "") || "");
                          if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh" || raw === "off") return raw;
                          return "none";
                        })()}
                        options={[
                          { value: "none", label: t("settings.options.reasoningNone") },
                          { value: "minimal", label: t("settings.options.reasoningMinimal") },
                          { value: "low", label: t("settings.options.reasoningLow") },
                          { value: "medium", label: t("settings.options.reasoningMedium") },
                          { value: "high", label: t("settings.options.reasoningHigh") },
                          { value: "xhigh", label: t("settings.options.reasoningXhigh") },
                          { value: "off", label: t("settings.options.reasoningOff") },
                        ]}
                        onChange={(value) => setEngineField("defaultReasoningEffort", value === "none" ? "" : value)}
                      />
                      <EnumField
                        label={t("settings.imageInputMode.label")}
                        hint={t("settings.imageInputMode.hint")}
                        value={((): "auto" | "native" | "text" => {
                          const raw = String(getEngineField("imageInputMode", "auto") || "auto");
                          return raw === "native" || raw === "text" ? raw : "auto";
                        })()}
                        options={[
                          { value: "auto", label: t("settings.options.imageAuto") },
                          { value: "native", label: t("settings.options.imageNative") },
                          { value: "text", label: t("settings.options.imageText") },
                        ]}
                        onChange={(value) => setEngineField("imageInputMode", value)}
                      />
                      <EnumField
                        label={t("settings.toolView.label")}
                        hint={t("settings.toolView.hint")}
                        value={ui.toolView}
                        options={[
                          { value: "compact", label: t("settings.options.compact") },
                          { value: "technical", label: t("settings.options.technical") },
                        ]}
                        onChange={(value) => setUiSetting("toolView", value)}
                      />
                    </div>
                  </section>
                  <section>
                    <GroupTitle>{t("settings.groups.toolsContext")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <NumberField label={t("settings.maxSteps.label")} hint={t("settings.maxSteps.hint")} value={Number(getEngineField("maxSteps", 12))} min={1} max={200} step={1} onChange={(value) => setEngineField("maxSteps", value)} />
                      <BoolField
                        label={t("settings.delegation.enabled.label")}
                        hint={t("settings.delegation.enabled.hint")}
                        value={Boolean(getEngineField("delegation.enabled", true))}
                        onChange={(value) => setEngineField("delegation.enabled", value)}
                      />
                      {Boolean(getEngineField("delegation.enabled", true)) && (
                        <>
                          <NumberField label={t("settings.delegation.maxTasks.label")} hint={t("settings.delegation.maxTasks.hint")} value={Number(getEngineField("delegation.maxTasks", 3))} min={1} max={8} step={1} onChange={(value) => setEngineField("delegation.maxTasks", value)} />
                          <NumberField label={t("settings.delegation.maxParallel.label")} hint={t("settings.delegation.maxParallel.hint")} value={Number(getEngineField("delegation.maxParallel", 3))} min={1} max={8} step={1} onChange={(value) => setEngineField("delegation.maxParallel", value)} />
                          <NumberField label={t("settings.delegation.maxSteps.label")} hint={t("settings.delegation.maxSteps.hint")} value={Number(getEngineField("delegation.maxSteps", 8))} min={1} max={24} step={1} onChange={(value) => setEngineField("delegation.maxSteps", value)} />
                          <NumberField
                            label={t("settings.delegation.timeout.label")}
                            hint={t("settings.delegation.timeout.hint")}
                            value={Number(getEngineField("delegation.idleTimeoutMs", getEngineField("delegation.timeoutMs", 180_000)))}
                            min={1_000}
                            max={3_600_000}
                            step={1_000}
                            format={(value) => t("settings.units.secondsShort", { count: Math.round(value / 1_000) })}
                            onChange={(value) => {
                              setEngineField("delegation.idleTimeoutMs", value);
                              setEngineField("delegation.timeoutMs", value);
                              const currentMaxRuntime = Number(getEngineField("delegation.maxRuntimeMs", 1_800_000));
                              if (currentMaxRuntime < value) setEngineField("delegation.maxRuntimeMs", value);
                            }}
                          />
                          <NumberField
                            label={t("settings.delegation.maxRuntime.label")}
                            hint={t("settings.delegation.maxRuntime.hint")}
                            value={Number(getEngineField("delegation.maxRuntimeMs", 1_800_000))}
                            min={1_000}
                            max={7_200_000}
                            step={1_000}
                            format={(value) => t("settings.units.secondsShort", { count: Math.round(value / 1_000) })}
                            onChange={(value) => {
                              const idleTimeoutMs = Number(getEngineField("delegation.idleTimeoutMs", getEngineField("delegation.timeoutMs", 180_000)));
                              setEngineField("delegation.maxRuntimeMs", Math.max(idleTimeoutMs, value));
                            }}
                          />
                        </>
                      )}
                      <NumberField label={t("settings.contextSoft.label")} hint={t("settings.contextSoft.hint")} value={Number(getEngineField("contextBudget.softPct", 0.75))} min={0.3} max={0.95} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => setEngineField("contextBudget.softPct", value)} />
                      <NumberField label={t("settings.contextHard.label")} hint={t("settings.contextHard.hint")} value={Number(getEngineField("contextBudget.hardPct", 0.9))} min={0.5} max={0.99} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => setEngineField("contextBudget.hardPct", value)} />
                      <BoolField
                        label={t("settings.compression.enabled.label")}
                        hint={t("settings.compression.enabled.hint")}
                        value={Boolean(getEngineField("compression.enabled", true))}
                        onChange={(value) => setEngineField("compression.enabled", value)}
                      />
                      {Boolean(getEngineField("compression.enabled", true)) && (
                        <>
                          <NumberField
                            label={t("settings.compression.protectLastN.label")}
                            hint={t("settings.compression.protectLastN.hint")}
                            value={Number(getEngineField("compression.protectLastN", 6))}
                            min={1}
                            max={100}
                            step={1}
                            onChange={(value) => setEngineField("compression.protectLastN", value)}
                          />
                          <NumberField
                            label={t("settings.compression.pruneToChars.label")}
                            hint={t("settings.compression.pruneToChars.hint")}
                            value={Number(getEngineField("compression.pruneToChars", 500))}
                            min={100}
                            max={20_000}
                            step={100}
                            onChange={(value) => setEngineField("compression.pruneToChars", value)}
                          />
                        </>
                      )}
                      <BoolField
                        label={t("settings.compression.summaryEnabled.label")}
                        hint={t("settings.compression.summaryEnabled.hint")}
                        value={Boolean(getEngineField("compression.summaryEnabled", true))}
                        onChange={(value) => setEngineField("compression.summaryEnabled", value)}
                      />
                      {Boolean(getEngineField("compression.summaryEnabled", true)) && (
                        <>
                          <BoolField
                            label={t("settings.compression.summaryUseLlm.label")}
                            hint={t("settings.compression.summaryUseLlm.hint")}
                            value={Boolean(getEngineField("compression.summaryUseLlm", false))}
                            onChange={(value) => setEngineField("compression.summaryUseLlm", value)}
                          />
                          <NumberField
                            label={t("settings.compression.protectFirstN.label")}
                            hint={t("settings.compression.protectFirstN.hint")}
                            value={Number(getEngineField("compression.protectFirstN", 2))}
                            min={0}
                            max={50}
                            step={1}
                            onChange={(value) => setEngineField("compression.protectFirstN", value)}
                          />
                        </>
                      )}
                      <BoolField
                        label={t("settings.toolLoop.hardStop.label")}
                        hint={t("settings.toolLoop.hardStop.hint")}
                        value={Boolean(getEngineField("reliability.toolLoop.hardStopEnabled", true))}
                        onChange={(value) => setEngineField("reliability.toolLoop.hardStopEnabled", value)}
                      />
                      <NumberField
                        label={t("settings.toolLoop.repeated.label")}
                        hint={t("settings.toolLoop.repeated.hint")}
                        value={Number(getEngineField("reliability.toolLoop.repeatedCallThreshold", 3))}
                        min={2}
                        max={20}
                        step={1}
                        onChange={(value) => setEngineField("reliability.toolLoop.repeatedCallThreshold", value)}
                      />
                      <NumberField
                        label={t("settings.toolLoop.healAfter.label")}
                        hint={t("settings.toolLoop.healAfter.hint")}
                        value={Number(getEngineField("reliability.toolLoop.healAfterFailures", 3))}
                        min={1}
                        max={20}
                        step={1}
                        onChange={(value) => setEngineField("reliability.toolLoop.healAfterFailures", value)}
                      />
                    </div>
                  </section>
                </div>
              )}

              {visibleSection === "appearance" && (
                <div className="space-y-6">
                  <section>
                    <GroupTitle>{t("settings.groups.theme")}</GroupTitle>
                    <ThemeGrid />
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => themeImportRef.current?.click()}>{t("settings.theme.import")}</Button>
                      {customActive && <Button size="sm" variant="ghost" onClick={() => { clearCustomTheme(); applyTheme(getTheme()); setCustomActive(false); }}>{t("settings.theme.resetCustom")}</Button>}
                      {customError && <span className="text-[12px] text-danger">{t("settings.theme.importError")}</span>}
                      <input ref={themeImportRef} type="file" accept="application/json,.json,.jsonc" className="hidden" onChange={(event) => event.target.files?.[0] && importTheme(event.target.files[0])} />
                    </div>
                  </section>
                  <div className="divide-y divide-border-soft">
                    <EnumField label={t("settings.language.label")} value={lang} options={LANGUAGES.map((entry) => ({ value: entry.id, label: entry.label }))} onChange={(value: Lang) => setLang(value)} />
                    <NumberField label={t("settings.scale.label")} hint={t("settings.scale.hint")} value={ui.scale} min={0.85} max={1.3} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => { setUiSetting("scale", value); applyScale(value); }} />
                    <EnumField
                      label={t("settings.density.label")}
                      value={ui.density}
                      options={[
                        { value: "comfortable", label: t("settings.options.comfortable") },
                        { value: "compact", label: t("settings.options.dense") },
                      ]}
                      onChange={(value) => setUiSetting("density", value)}
                    />
                    <EnumField
                      label={t("settings.chatBackground.label")}
                      hint={t("settings.chatBackground.hint")}
                      value={ui.chatBackground}
                      options={[
                        { value: "follow-theme", label: t("settings.chatBackground.followTheme") },
                        { value: "peonies", label: t("settings.chatBackground.peonies") },
                      ]}
                      onChange={(value) => setUiSetting("chatBackground", value)}
                    />
                  </div>
                </div>
              )}

              {visibleSection === "notifications" && (
                <div className="space-y-6">
                  <section>
                    <GroupTitle>{t("settings.groups.notifications")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <BoolField label={t("settings.notify.master.label")} hint={t("settings.notify.master.hint")} value={ui.notify} onChange={(value) => setUiSetting("notify", value)} />
                      <BoolField label={t("settings.notify.sound.label")} hint={t("settings.notify.sound.hint")} value={ui.notifySound} onChange={(value) => setUiSetting("notifySound", value)} />
                      <Field label={t("settings.notify.testSound")}><Button variant="outline" size="sm" onClick={playChime} disabled={!ui.notifySound}>{t("settings.notify.play")}</Button></Field>
                      <BoolField label={t("settings.notify.native.label")} hint={t("settings.notify.native.hint")} value={ui.notifyNative} onChange={(value) => setUiSetting("notifyNative", value)} />
                    </div>
                  </section>
                  <section>
                    <GroupTitle>{t("settings.groups.messaging")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <BoolField
                        label={t("settings.messaging.enabled.label")}
                        hint={t("settings.messaging.enabled.hint")}
                        value={Boolean(getEngineField("messaging.enabled", false))}
                        onChange={(value) => setEngineField("messaging.enabled", value)}
                      />
                      {Boolean(getEngineField("messaging.enabled", false)) && (
                        <>
                          <BoolField
                            label={t("settings.messaging.autoRun.label")}
                            hint={t("settings.messaging.autoRun.hint")}
                            value={Boolean(getEngineField("messaging.autoRun", false))}
                            onChange={(value) => setEngineField("messaging.autoRun", value)}
                          />
                          <Field label={t("settings.messaging.token.label")} hint={t("settings.messaging.token.hint")} stacked>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={messagingBusy}
                                onClick={() => void rotateMessagingToken()}
                              >
                                {messagingBusy
                                  ? t("settings.messaging.tokenBusy")
                                  : t("settings.messaging.tokenRotate")}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={messagingBusy}
                                onClick={() => void checkMessaging()}
                              >
                                {t("settings.messaging.refresh")}
                              </Button>
                              <span className="text-[12px] text-muted">
                                {messagingStatus?.hasToken
                                  ? t("settings.messaging.tokenPresent")
                                  : t("settings.messaging.tokenMissing")}
                              </span>
                            </div>
                            {messagingTokenOnce && (
                              <p className="mt-2 break-all rounded-md border border-border-soft bg-elevated/50 px-2 py-1.5 font-mono text-[11px] text-foreground">
                                {messagingTokenOnce}
                              </p>
                            )}
                            {messagingNote && (
                              <p className="mt-1 text-[12px] text-muted">{messagingNote}</p>
                            )}
                            {messagingStatus?.note && (
                              <p className="mt-1 text-[11px] text-muted">{messagingStatus.note}</p>
                            )}
                            {messagingStatus && messagingStatus.recent.length > 0 && (
                              <ul className="mt-2 space-y-1 text-[11px] text-muted">
                                {messagingStatus.recent.slice(0, 5).map((entry) => (
                                  <li key={entry.id}>
                                    {entry.at.slice(11, 19)} · {entry.channel} · {entry.sessionId.slice(0, 12)}… · {entry.preview}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </Field>
                        </>
                      )}
                    </div>
                  </section>
                  <section>
                    <GroupTitle>{t("settings.groups.voice")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      {!sttSupported && !ttsSupported && <p className="py-2 text-[12px] text-warning">{t("settings.voice.unavailable")}</p>}
                      <BoolField label={t("settings.voice.input.label")} hint={sttSupported ? t("settings.voice.input.hint") : t("settings.voice.inputUnavailable")} value={ui.voiceInput && sttSupported} onChange={(value) => setUiSetting("voiceInput", value)} />
                      <BoolField label={t("settings.voice.speak.label")} hint={ttsSupported ? t("settings.voice.speak.hint") : t("settings.voice.speakUnavailable")} value={ui.autoSpeak && ttsSupported} onChange={(value) => setUiSetting("autoSpeak", value)} />
                      <TextField label={t("settings.voice.language.label")} hint={t("settings.voice.language.hint")} value={ui.voiceLang} placeholder={lang === "ru" ? "ru-RU" : "en-US"} onChange={(value) => setUiSetting("voiceLang", value)} />
                      <Field label={t("settings.voice.test")}>
                        <Button variant="outline" size="sm" disabled={!ttsSupported} onClick={() => speak(t("settings.voice.testText"), { lang: ui.voiceLang || undefined })}>{t("settings.notify.play")}</Button>
                      </Field>
                      <p className="py-2 text-[11px] leading-snug text-muted">{t("settings.voice.privacy")}</p>
                    </div>
                  </section>
                </div>
              )}

              {visibleSection === "keybinds" && <KeybindPanel />}

              {visibleSection === "memory" && (
                <div className="space-y-6">
                  <section>
                    <GroupTitle>{t("settings.groups.mcp")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <BoolField
                        label={t("settings.mcp.enabled.label")}
                        hint={t("settings.mcp.enabled.hint")}
                        value={Boolean(getEngineField("mcp.enabled", false))}
                        onChange={(value) => setEngineField("mcp.enabled", value)}
                      />
                      {Boolean(getEngineField("mcp.enabled", false)) && (
                        <>
                          <Field label={t("settings.mcp.servers.label")} hint={t("settings.mcp.servers.hint")} stacked>
                            <div className="space-y-2">
                              {mcpServers.length === 0 && (
                                <p className="rounded-md border border-dashed border-border-soft px-3 py-2 text-[12px] text-muted">
                                  {t("settings.mcp.servers.empty")}
                                </p>
                              )}
                              {mcpServers.map((server, index) => {
                                const transport = server.transport === "streamable-http" ? "streamable-http" : "stdio";
                                const args = Array.isArray(server.args) ? server.args : [];
                                return (
                                  <article key={`${server.id ?? "server"}-${index}`} className="rounded-md border border-border-soft bg-surface/55 p-3">
                                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_12rem_auto]">
                                      <label className="space-y-1">
                                        <span className="text-[10px] text-muted">{t("settings.mcp.servers.id")}</span>
                                        <Input
                                          value={server.id ?? ""}
                                          onChange={(event) => replaceMcpServer(index, { ...server, id: event.target.value })}
                                          aria-label={t("settings.mcp.servers.id")}
                                        />
                                      </label>
                                      <label className="space-y-1">
                                        <span className="text-[10px] text-muted">{t("settings.mcp.servers.transport")}</span>
                                        <select
                                          value={transport}
                                          className="h-9 w-full rounded-md border border-border bg-bg px-2 text-[12px] text-foreground outline-none focus:border-primary"
                                          aria-label={t("settings.mcp.servers.transport")}
                                          onChange={(event) => {
                                            const nextTransport: "stdio" | "streamable-http" = event.target.value === "streamable-http" ? "streamable-http" : "stdio";
                                            const nextServer: EditableMcpServer = { ...server, transport: nextTransport };
                                            if (nextTransport === "streamable-http") {
                                              delete nextServer.command;
                                              delete nextServer.args;
                                              delete nextServer.env;
                                              delete nextServer.cwd;
                                            } else {
                                              delete nextServer.url;
                                              delete nextServer.headers;
                                            }
                                            replaceMcpServer(index, nextServer);
                                          }}
                                        >
                                          <option value="stdio">{t("settings.mcp.servers.stdio")}</option>
                                          <option value="streamable-http">{t("settings.mcp.servers.http")}</option>
                                        </select>
                                      </label>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        className="self-end text-muted hover:text-danger"
                                        onClick={() => removeMcpServer(index)}
                                        aria-label={t("settings.mcp.servers.remove", { id: server.id || String(index + 1) })}
                                      >
                                        <Trash2 className="size-3.5" aria-hidden />
                                      </Button>
                                    </div>
                                    {transport === "streamable-http" ? (
                                      <label className="mt-2 block space-y-1">
                                        <span className="text-[10px] text-muted">{t("settings.mcp.servers.url")}</span>
                                        <Input
                                          value={server.url ?? ""}
                                          placeholder="https://example.com/mcp"
                                          onChange={(event) => replaceMcpServer(index, { ...server, url: event.target.value })}
                                          aria-label={t("settings.mcp.servers.url")}
                                        />
                                      </label>
                                    ) : (
                                      <>
                                        <label className="mt-2 block space-y-1">
                                          <span className="text-[10px] text-muted">{t("settings.mcp.servers.command")}</span>
                                          <Input
                                            value={server.command ?? ""}
                                            placeholder={t("settings.mcp.servers.commandPlaceholder")}
                                            onChange={(event) => replaceMcpServer(index, { ...server, command: event.target.value })}
                                            aria-label={t("settings.mcp.servers.command")}
                                          />
                                        </label>
                                        <label className="mt-2 block space-y-1">
                                          <span className="text-[10px] text-muted">{t("settings.mcp.servers.args")}</span>
                                          <textarea
                                            value={args.join("\n")}
                                            rows={2}
                                            spellCheck={false}
                                            onChange={(event) => replaceMcpServer(index, {
                                              ...server,
                                              args: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
                                            })}
                                            aria-label={t("settings.mcp.servers.args")}
                                            className="w-full resize-y rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:border-primary"
                                          />
                                        </label>
                                      </>
                                    )}
                                  </article>
                                );
                              })}
                              <Button type="button" variant="outline" size="sm" onClick={addMcpServer}>
                                <Plus className="size-3.5" aria-hidden />
                                {t("settings.mcp.servers.add")}
                              </Button>
                            </div>
                            <details className="mt-2 rounded-md border border-border-soft px-3 py-2">
                              <summary className="cursor-pointer text-[11px] text-muted">{t("settings.mcp.servers.advanced")}</summary>
                            <textarea
                              value={(() => {
                                try {
                                  return JSON.stringify(getEngineField("mcp.servers", []) ?? [], null, 2);
                                } catch {
                                  return "[]";
                                }
                              })()}
                              onChange={(event) => {
                                try {
                                  const parsed = JSON.parse(event.target.value || "[]");
                                  if (!Array.isArray(parsed)) throw new Error("array");
                                  setEngineField("mcp.servers", parsed);
                                } catch {
                                  // keep typing; do not save invalid mid-edit — user can fix via Apply JSON
                                }
                              }}
                              onBlur={(event) => {
                                try {
                                  const parsed = JSON.parse(event.target.value || "[]");
                                  if (!Array.isArray(parsed)) throw new Error("array");
                                  setEngineField("mcp.servers", parsed, true);
                                } catch {
                                  /* invalid left as-is until corrected */
                                }
                              }}
                              spellCheck={false}
                              rows={6}
                              aria-label={t("settings.mcp.servers.label")}
                              className="mt-2 w-full resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
                            />
                            </details>
                          </Field>
                          <NumberField
                            label={t("settings.mcp.timeout.label")}
                            hint={t("settings.mcp.timeout.hint")}
                            value={Number(getEngineField("mcp.timeoutMs", 30_000))}
                            min={1_000}
                            max={300_000}
                            step={1_000}
                            format={(value) => t("settings.units.secondsShort", { count: Math.round(value / 1_000) })}
                            onChange={(value) => setEngineField("mcp.timeoutMs", value)}
                          />
                          <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-foreground">{t("settings.mcp.status.label")}</p>
                              <p className="text-[11px] leading-snug text-muted">
                                {!mcpStatus
                                  ? t("settings.mcp.status.unknown")
                                  : mcpStatus.state === "ready"
                                    ? t("settings.mcp.status.ready", { count: mcpStatus.servers.length })
                                    : mcpStatus.state === "no_servers"
                                      ? t("settings.mcp.status.noServers")
                                      : mcpStatus.state === "disabled"
                                        ? t("settings.mcp.status.disabled")
                                        : t("settings.mcp.status.error")}
                              </p>
                              {mcpStatus?.servers.map((server) => (
                                <p key={server.id} className="mt-0.5 text-[11px] text-muted">
                                  <span className={server.ok ? "text-success" : "text-warning"}>{server.ok ? "●" : "●"}</span>{" "}
                                  <span className="font-mono">{server.id}</span>{" "}
                                  {server.source && <span>{t(`settings.mcp.status.scope.${server.source}`)} · </span>}
                                  {server.ok
                                    ? t("settings.mcp.status.tools", { count: server.toolCount })
                                    : server.error ?? t("settings.mcp.status.failed")}
                                </p>
                              ))}
                            </div>
                            <Button variant="outline" size="sm" onClick={() => void checkMcp()} disabled={mcpBusy}>
                              {mcpBusy ? t("settings.mcp.status.checking") : t("settings.mcp.status.check")}
                            </Button>
                          </div>
                        </>
                      )}
                      <Field label={t("settings.mcp.project.label")} hint={t("settings.mcp.project.hint")} stacked>
                        <div className="rounded-md border border-border-soft bg-surface/55 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[12px] font-medium text-foreground">
                                {projectMcpError
                                  ? t("settings.mcp.project.status.error")
                                  : !projectMcpStatus
                                    ? t("settings.mcp.project.status.loading")
                                    : !projectMcpStatus.workspace
                                      ? t("settings.mcp.project.status.noWorkspace")
                                      : !projectMcpStatus.exists
                                        ? t("settings.mcp.project.status.missing")
                                        : !projectMcpStatus.valid
                                          ? t("settings.mcp.project.status.invalid")
                                          : projectMcpStatus.trusted && projectMcpStatus.config.enabled
                                            ? t("settings.mcp.project.status.active")
                                            : projectMcpStatus.trusted
                                              ? t("settings.mcp.project.status.disabled")
                                              : t("settings.mcp.project.status.review")}
                              </p>
                              {projectMcpStatus?.workspace && (
                                <p className="mt-0.5 font-mono text-[10px] text-muted">{projectMcpStatus.path}</p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                              <Button variant="outline" size="sm" onClick={() => void checkProjectMcp()} disabled={projectMcpBusy}>
                                {t("settings.mcp.project.refresh")}
                              </Button>
                              {projectMcpStatus?.exists && projectMcpStatus.valid && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void setProjectMcpTrust(!projectMcpStatus.trusted)}
                                  disabled={projectMcpBusy}
                                >
                                  {projectMcpStatus.trusted ? t("settings.mcp.project.untrust") : t("settings.mcp.project.trust")}
                                </Button>
                              )}
                            </div>
                          </div>
                          {projectMcpStatus?.workspace && (
                            <>
                              <textarea
                                value={projectMcpText}
                                onChange={(event) => { setProjectMcpText(event.target.value); setProjectMcpError(false); }}
                                spellCheck={false}
                                rows={7}
                                aria-label={t("settings.mcp.project.label")}
                                className="mt-3 w-full resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
                              />
                              <div className="mt-2 flex flex-wrap gap-2">
                                {!projectMcpStatus.exists && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setProjectMcpText(JSON.stringify({ version: 1, enabled: true, servers: [] }, null, 2))}
                                  >
                                    {t("settings.mcp.project.create")}
                                  </Button>
                                )}
                                <Button type="button" size="sm" onClick={() => void saveProjectMcp()} disabled={projectMcpBusy}>
                                  {projectMcpBusy ? t("settings.mcp.project.saving") : t("settings.mcp.project.save")}
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      </Field>
                    </div>
                  </section>
                  <section>
                    <GroupTitle>{t("settings.groups.projectMemory")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <Field label={t("settings.projectMemory.intro.label")} hint={t("settings.projectMemory.intro.hint")} stacked>
                        <div className="rounded-lg border border-border-soft bg-elevated/45 px-3 py-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2.5">
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-foreground" role="status">
                                {memoryIndexCheckFailed
                                  ? t("settings.projectMemory.status.error")
                                  : !memoryIndexStatus
                                    ? t("settings.projectMemory.status.checking")
                                    : memoryIndexStatus.state === "ready"
                                      ? t("settings.projectMemory.status.ready")
                                      : memoryIndexStatus.state === "disabled"
                                        ? t("settings.projectMemory.status.disabled")
                                        : memoryIndexStatus.state === "no_workspace"
                                          ? t("settings.projectMemory.status.noWorkspace")
                                          : t("settings.projectMemory.status.error")}
                              </p>
                              {memoryIndexStatus?.state === "ready" && (
                                <p className="mt-0.5 text-[12px] leading-snug text-muted">
                                  {t("settings.projectMemory.status.docs", {
                                    count: memoryIndexStatus.docCount,
                                    backend: memoryIndexStatus.backend,
                                    vectors: memoryIndexStatus.vectorSearch,
                                  })}
                                </p>
                              )}
                              {runtimeHealthHint(memoryIndexStatus) && (
                                <p className="mt-1 text-[12px] text-warning" role="status">
                                  {runtimeHealthHint(memoryIndexStatus)}
                                </p>
                              )}
                              {memoryIndexStatus && (
                                <p className="mt-0.5 text-[12px] leading-snug text-muted">
                                  {t("settings.projectMemory.status.tierA", {
                                    memory: memoryIndexStatus.tierA.memoryMd ? t("settings.projectMemory.yes") : t("settings.projectMemory.no"),
                                    notes: memoryIndexStatus.tierA.notesMd ? t("settings.projectMemory.yes") : t("settings.projectMemory.no"),
                                    plan: memoryIndexStatus.tierA.plan ? t("settings.projectMemory.yes") : t("settings.projectMemory.no"),
                                    handoffs: memoryIndexStatus.tierA.handoffs,
                                    decisions: memoryIndexStatus.tierA.ltmDecisions ? t("settings.projectMemory.yes") : t("settings.projectMemory.no"),
                                    graph: memoryIndexStatus.tierA.projectIndex ? t("settings.projectMemory.yes") : t("settings.projectMemory.no"),
                                  })}
                                </p>
                              )}
                              {memoryReindexNote && <p className="mt-1 text-[12px] text-muted">{memoryReindexNote}</p>}
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => void checkMemoryIndex()} disabled={memoryIndexBusy}>
                                {memoryIndexBusy ? t("settings.projectMemory.status.checking") : t("settings.projectMemory.check")}
                              </Button>
                              <Button size="sm" onClick={() => void reindexMemoryIndex()} disabled={memoryIndexBusy}>
                                {memoryIndexBusy ? t("settings.projectMemory.reindexing") : t("settings.projectMemory.reindex")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </Field>
                      <BoolField
                        label={t("settings.projectMemory.ltm.label")}
                        hint={t("settings.projectMemory.ltm.hint")}
                        value={Boolean(getEngineField("memory.ltm.enabled", true))}
                        onChange={(value) => setEngineField("memory.ltm.enabled", value)}
                      />
                      {Boolean(getEngineField("memory.ltm.enabled", true)) && (
                        <Field label={t("settings.projectMemory.ltm.consolidate.label")} hint={t("settings.projectMemory.ltm.consolidate.hint")} stacked>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void consolidateLtm()}
                              disabled={ltmConsolidateBusy}
                            >
                              {ltmConsolidateBusy
                                ? t("settings.projectMemory.ltm.consolidating")
                                : t("settings.projectMemory.ltm.consolidate")}
                            </Button>
                            {ltmConsolidateNote && (
                              <p className="text-[12px] text-muted">{ltmConsolidateNote}</p>
                            )}
                          </div>
                        </Field>
                      )}
                      {Boolean(getEngineField("memory.ltm.enabled", true)) && (
                        <Field label={t("settings.ltmDecisions.label")} hint={t("settings.ltmDecisions.fieldHint")} stacked>
                          <LtmDecisionsPanel />
                        </Field>
                      )}
                      <GroupTitle>{t("settings.groups.memoryRecall")}</GroupTitle>
                      <div className="divide-y divide-border-soft">
                        <BoolField
                          label={t("settings.memoryRecall.mmr.label")}
                          hint={t("settings.memoryRecall.mmr.hint")}
                          value={Boolean(getEngineField("memory.recall.mmrEnabled", true))}
                          onChange={(value) => setEngineField("memory.recall.mmrEnabled", value)}
                        />
                        <BoolField
                          label={t("settings.memoryRecall.cluster.label")}
                          hint={t("settings.memoryRecall.cluster.hint")}
                          value={Boolean(getEngineField("memory.recall.clusterEnabled", true))}
                          onChange={(value) => setEngineField("memory.recall.clusterEnabled", value)}
                        />
                        <BoolField
                          label={t("settings.memoryRecall.decay.label")}
                          hint={t("settings.memoryRecall.decay.hint")}
                          value={Boolean(getEngineField("memory.decay.enabled", true))}
                          onChange={(value) => setEngineField("memory.decay.enabled", value)}
                        />
                        <BoolField
                          label={t("settings.memoryRecall.citeOrRefuse.label")}
                          hint={t("settings.memoryRecall.citeOrRefuse.hint")}
                          value={Boolean(getEngineField("memory.citeOrRefuse.enabled", false))}
                          onChange={(value) => setEngineField("memory.citeOrRefuse.enabled", value)}
                        />
                      </div>
                      <GroupTitle>{t("settings.groups.memoryCurator")}</GroupTitle>
                      <div className="divide-y divide-border-soft">
                        <BoolField
                          label={t("settings.memoryCurator.enabled.label")}
                          hint={t("settings.memoryCurator.enabled.hint")}
                          value={Boolean(getEngineField("memory.curator.enabled", true))}
                          onChange={(value) => setEngineField("memory.curator.enabled", value)}
                        />
                        {Boolean(getEngineField("memory.curator.enabled", true)) && (
                          <>
                            <BoolField
                              label={t("settings.memoryCurator.autoOnArchive.label")}
                              hint={t("settings.memoryCurator.autoOnArchive.hint")}
                              value={Boolean(getEngineField("memory.curator.autoOnArchive", true))}
                              onChange={(value) => setEngineField("memory.curator.autoOnArchive", value)}
                            />
                            <EnumField
                              label={t("settings.memoryCurator.applyMode.label")}
                              hint={t("settings.memoryCurator.applyMode.hint")}
                              value={((): "propose" | "apply_safe" | "apply_all" => {
                                const raw = String(getEngineField("memory.curator.applyMode", "apply_safe"));
                                return raw === "propose" || raw === "apply_all" ? raw : "apply_safe";
                              })()}
                              options={[
                                { value: "propose", label: t("settings.options.curatorPropose") },
                                { value: "apply_safe", label: t("settings.options.curatorSafe") },
                                { value: "apply_all", label: t("settings.options.curatorAll") },
                              ]}
                              onChange={(value) => setEngineField("memory.curator.applyMode", value)}
                            />
                            <BoolField
                              label={t("settings.memoryCurator.useLlm.label")}
                              hint={t("settings.memoryCurator.useLlm.hint")}
                              value={Boolean(getEngineField("memory.curator.useLlm", true))}
                              onChange={(value) => setEngineField("memory.curator.useLlm", value)}
                            />
                            {Boolean(getEngineField("memory.curator.useLlm", true)) && (
                              <EnumField
                                label={t("settings.memoryCurator.modelSource.label")}
                                hint={t("settings.memoryCurator.modelSource.hint")}
                                value={((): "worker" | "session" | "default" => {
                                  const raw = String(getEngineField("memory.curator.modelSource", "worker"));
                                  return raw === "session" || raw === "default" ? raw : "worker";
                                })()}
                                options={[
                                  { value: "worker", label: t("settings.options.curatorModelWorker") },
                                  { value: "session", label: t("settings.options.curatorModelSession") },
                                  { value: "default", label: t("settings.options.curatorModelDefault") },
                                ]}
                                onChange={(value) => setEngineField("memory.curator.modelSource", value)}
                              />
                            )}
                          </>
                        )}
                      </div>
                      <BoolField
                        label={t("settings.projectMemory.planning.label")}
                        hint={t("settings.projectMemory.planning.hint")}
                        value={Boolean(getEngineField("planning.enabled", true))}
                        onChange={(value) => setEngineField("planning.enabled", value)}
                      />
                      <BoolField
                        label={t("settings.reliability.goalVerify.label")}
                        hint={t("settings.reliability.goalVerify.hint")}
                        value={Boolean(getEngineField("reliability.goalVerify", true))}
                        onChange={(value) => setEngineField("reliability.goalVerify", value)}
                      />
                      <BoolField
                        label={t("settings.reliability.healHandoff.label")}
                        hint={t("settings.reliability.healHandoff.hint")}
                        value={Boolean(getEngineField("reliability.healHandoff", true))}
                        onChange={(value) => setEngineField("reliability.healHandoff", value)}
                      />
                      <BoolField
                        label={t("settings.projectMemory.indexEnabled.label")}
                        hint={t("settings.projectMemory.indexEnabled.hint")}
                        value={Boolean(getEngineField("memory.index.enabled", true))}
                        onChange={(value) => setEngineField("memory.index.enabled", value)}
                      />
                      {Boolean(getEngineField("memory.index.enabled", true)) && (
                        <>
                          <EnumField
                            label={t("settings.projectMemory.indexBackend.label")}
                            hint={t("settings.projectMemory.indexBackend.hint")}
                            value={String(getEngineField("memory.index.backend", "sqlite")) as "sqlite" | "postgres" | "off"}
                            options={[
                              { value: "sqlite", label: t("settings.projectMemory.indexBackend.sqlite") },
                              { value: "postgres", label: t("settings.projectMemory.indexBackend.postgres") },
                              { value: "off", label: t("settings.projectMemory.indexBackend.off") },
                            ]}
                            onChange={(value) => setEngineField("memory.index.backend", value)}
                          />
                          <Field label={t("settings.projectMemory.localPostgres.label")} stacked>
                            <div className="rounded-lg border border-border-soft bg-elevated/45 px-3 py-2.5">
                              <p className="text-[12px] font-medium text-foreground" role="status">
                                {localPostgresStatus?.state === "ready"
                                  ? t("settings.projectMemory.localPostgres.ready", { port: localPostgresStatus.port ?? "?" })
                                  : localPostgresStatus?.state === "starting"
                                    ? t("settings.projectMemory.localPostgres.starting")
                                    : localPostgresStatus?.state === "error"
                                      ? t("settings.projectMemory.localPostgres.error")
                                      : localPostgresStatus?.state === "unavailable"
                                        ? t("settings.projectMemory.localPostgres.unavailable")
                                        : t("settings.projectMemory.localPostgres.idle")}
                              </p>
                              <p className="mt-1 text-[11px] text-muted">
                                {t("settings.projectMemory.localPostgres.hint")}
                              </p>
                            </div>
                          </Field>
                          {String(getEngineField("memory.index.backend", "sqlite")) === "postgres" && (
                            <TextField
                              label={t("settings.projectMemory.connectionString.label")}
                              hint={t("settings.projectMemory.connectionString.hint")}
                              value={String(getEngineField("memory.index.connectionString", ""))}
                              placeholder="postgres://user@localhost:5432/kyrei"
                              onChange={(value) => {
                                setEngineField("memory.index.connectionString", value);
                                setEngineField("memory.index.connectionSource", "external");
                              }}
                            />
                          )}
                        </>
                      )}
                      <BoolField
                        label={t("settings.projectMemory.sessionMirror.label")}
                        hint={t("settings.projectMemory.sessionMirror.hint")}
                        value={Boolean(getEngineField("memory.sessionMirror.enabled", true))}
                        onChange={(value) => setEngineField("memory.sessionMirror.enabled", value)}
                      />
                      {Boolean(getEngineField("memory.sessionMirror.enabled", true)) && (
                        <>
                          <BoolField
                            label={t("settings.projectMemory.sessionMirrorRead.label")}
                            hint={t("settings.projectMemory.sessionMirrorRead.hint")}
                            value={Boolean(getEngineField("memory.sessionMirror.readSearch", true))}
                            onChange={(value) => setEngineField("memory.sessionMirror.readSearch", value)}
                          />
                          <BoolField
                            label={t("settings.projectMemory.sessionMirrorPrimary.label")}
                            hint={t("settings.projectMemory.sessionMirrorPrimary.hint")}
                            value={Boolean(getEngineField("memory.sessionMirror.enginePrimary", true))}
                            onChange={(value) => setEngineField("memory.sessionMirror.enginePrimary", value)}
                          />
                          <Field label={t("settings.projectMemory.sessionMirror.status.label")} stacked>
                            <div className="rounded-lg border border-border-soft bg-elevated/45 px-3 py-2.5">
                              <div className="flex flex-wrap items-center justify-between gap-2.5">
                                <div className="min-w-0">
                                  <p className="text-[13px] font-medium text-foreground" role="status">
                                    {sessionMirrorBusy && !sessionMirrorStatus
                                      ? t("settings.projectMemory.sessionMirror.status.checking")
                                      : !sessionMirrorStatus
                                        ? t("settings.projectMemory.sessionMirror.status.checking")
                                        : sessionMirrorStatus.state === "ready"
                                          ? t("settings.projectMemory.sessionMirror.status.ready", {
                                              count: sessionMirrorStatus.sessionCount,
                                            })
                                          : sessionMirrorStatus.state === "disabled"
                                            ? t("settings.projectMemory.sessionMirror.status.disabled")
                                            : t("settings.projectMemory.sessionMirror.status.error")}
                                  </p>
                                  {sessionMirrorNote && (
                                    <p className="mt-1 text-[12px] text-muted">{sessionMirrorNote}</p>
                                  )}
                                  {runtimeHealthHint(sessionMirrorStatus) && (
                                    <p className="mt-1 text-[12px] text-warning" role="status">
                                      {runtimeHealthHint(sessionMirrorStatus)}
                                    </p>
                                  )}
                                  {sessionMirrorStatus?.sync?.state === "running" && (
                                    <p className="mt-1 text-[12px] text-muted">
                                      {t("settings.projectMemory.sessionMirror.progress", {
                                        completed: sessionMirrorStatus.sync.completedSessions,
                                        total: sessionMirrorStatus.sync.totalSessions,
                                        messages: sessionMirrorStatus.sync.completedMessages,
                                      })}
                                    </p>
                                  )}
                                  {sessionMirrorStatus?.sync?.state === "completed" && (
                                    <p className="mt-1 text-[12px] text-muted">
                                      {t("settings.projectMemory.sessionMirror.syncCompleted", {
                                        sessions: sessionMirrorStatus.sync.totalSessions,
                                        messages: sessionMirrorStatus.sync.totalMessages,
                                      })}
                                    </p>
                                  )}
                                  {sessionMirrorStatus?.sync?.state === "failed" && (
                                    <p className="mt-1 text-[12px] text-warning">
                                      {t("settings.projectMemory.sessionMirror.syncPaused", {
                                        error: sessionMirrorStatus.sync.error || "mirror_sync_failed",
                                      })}
                                    </p>
                                  )}
                                  {sessionMirrorParity && (
                                    <p className="mt-1 text-[12px] text-muted">
                                      {t("settings.projectMemory.sessionMirror.parity", {
                                        jsonSessions: sessionMirrorParity.json.sessions,
                                        mirrorSessions: sessionMirrorParity.mirror.sessions,
                                        missing: sessionMirrorParity.missingInMirror.length,
                                      })}
                                      {" · "}
                                      {sessionMirrorParity.schemaReady
                                        ? t("settings.projectMemory.sessionMirror.schemaReady")
                                        : null}
                                      {sessionMirrorParity.schemaReady ? " · " : null}
                                      {sessionMirrorParity.cutoverReady
                                        ? t("settings.projectMemory.sessionMirror.cutoverReady")
                                        : t("settings.projectMemory.sessionMirror.cutoverBlocked")}
                                    </p>
                                  )}
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void checkSessionMirror()}
                                    disabled={sessionMirrorBusy}
                                  >
                                    {sessionMirrorBusy
                                      ? t("settings.projectMemory.sessionMirror.status.checking")
                                      : t("settings.projectMemory.check")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={() => void syncSessionMirror()}
                                    disabled={sessionMirrorBusy || sessionMirrorStatus?.sync?.state === "running"}
                                  >
                                    {sessionMirrorBusy
                                      ? t("settings.projectMemory.sessionMirror.syncing")
                                      : sessionMirrorStatus?.sync?.state === "failed" && sessionMirrorStatus.sync.resumable
                                        ? t("settings.projectMemory.sessionMirror.syncResume")
                                        : t("settings.projectMemory.sessionMirror.sync")}
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </Field>
                        </>
                      )}
                      {Boolean(getEngineField("memory.index.enabled", true)) && (
                        <>
                          <EnumField
                            label={t("settings.projectMemory.embedMode.label")}
                            hint={t("settings.projectMemory.embedMode.hint")}
                            value={String(getEngineField("memory.index.embed.mode", "lexical")) as "lexical" | "http"}
                            options={[
                              { value: "lexical", label: t("settings.projectMemory.embedMode.lexical") },
                              { value: "http", label: t("settings.projectMemory.embedMode.http") },
                            ]}
                            onChange={(value) => setEngineField("memory.index.embed.mode", value)}
                          />
                          {String(getEngineField("memory.index.embed.mode", "lexical")) === "http" && (
                            <>
                              <TextField
                                label={t("settings.projectMemory.embedBase.label")}
                                hint={t("settings.projectMemory.embedBase.hint")}
                                value={String(getEngineField("memory.index.embed.baseURL", "http://127.0.0.1:11434/v1"))}
                                placeholder="http://127.0.0.1:11434/v1"
                                onChange={(value) => setEngineField("memory.index.embed.baseURL", value)}
                              />
                              <TextField
                                label={t("settings.projectMemory.embedModel.label")}
                                hint={t("settings.projectMemory.embedModel.hint")}
                                value={String(getEngineField("memory.index.embed.model", "nomic-embed-text"))}
                                placeholder="nomic-embed-text"
                                onChange={(value) => setEngineField("memory.index.embed.model", value)}
                              />
                              <TextField
                                label={t("settings.projectMemory.embedKey.label")}
                                hint={t("settings.projectMemory.embedKey.hint")}
                                value={String(getEngineField("memory.index.embed.apiKey", ""))}
                                placeholder=""
                                onChange={(value) => setEngineField("memory.index.embed.apiKey", value)}
                              />
                            </>
                          )}
                        </>
                      )}
                      <BoolField
                        label={t("settings.projectMemory.openviking.label")}
                        hint={t("settings.projectMemory.openviking.hint")}
                        value={Boolean(getEngineField("memory.openviking.enabled", false))}
                        onChange={(value) => setEngineField("memory.openviking.enabled", value)}
                      />
                      {Boolean(getEngineField("memory.openviking.enabled", false)) && (
                        <TextField
                          label={t("settings.projectMemory.openvikingBase.label")}
                          hint={t("settings.projectMemory.openvikingBase.hint")}
                          value={String(getEngineField("memory.openviking.baseURL", "http://127.0.0.1:1933"))}
                          placeholder="http://127.0.0.1:1933"
                          onChange={(value) => setEngineField("memory.openviking.baseURL", value)}
                        />
                      )}
                    </div>
                  </section>
                  <section>
                    <GroupTitle>{t("settings.groups.gbrain")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <Field label={t("settings.gbrain.setup.label")} hint={t("settings.gbrain.setup.hint")} stacked>
                        <div className="rounded-lg border border-border-soft bg-elevated/45 px-3 py-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2.5">
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-foreground" role="status">{gbrainStatusTitle}</p>
                              {gbrainStatusHint && <p className="mt-0.5 text-[12px] leading-snug text-muted">{gbrainStatusHint}</p>}
                              {runtimeHealthHint(gbrainStatus) && (
                                <p className="mt-1 text-[12px] text-warning" role="status">
                                  {runtimeHealthHint(gbrainStatus)}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => void checkGBrain()} disabled={gbrainBusy}>
                                {gbrainBusy ? t("settings.gbrain.status.checking") : t("settings.gbrain.check")}
                              </Button>
                              {gbrainStatus?.state === "not_initialized" && (
                                <Button size="sm" onClick={() => void initializeGBrain()} disabled={gbrainBusy}>
                                  {gbrainBusy ? t("settings.gbrain.initializing") : t("settings.gbrain.initialize")}
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </Field>
                      <EnumField
                        label={t("settings.gbrain.provider.label")}
                        hint={t("settings.gbrain.provider.hint")}
                        value={String(getEngineField("memory.gbrain.provider", "builtin")) as "builtin" | "external-cli"}
                        options={[
                          { value: "builtin", label: t("settings.gbrain.provider.builtin") },
                          { value: "external-cli", label: t("settings.gbrain.provider.external") },
                        ]}
                        onChange={(value) => setEngineField("memory.gbrain.provider", value)}
                      />
                      {String(getEngineField("memory.gbrain.provider", "builtin")) === "external-cli" && (
                        <TextField
                          label={t("settings.gbrain.command.label")}
                          hint={t("settings.gbrain.command.hint")}
                          value={String(getEngineField("memory.gbrain.command", "gbrain"))}
                          placeholder="gbrain"
                          onChange={(value) => setEngineField("memory.gbrain.command", value)}
                        />
                      )}
                      <EnumField
                        label={t("settings.gbrain.mode.label")}
                        hint={t("settings.gbrain.mode.hint")}
                        value={String(getEngineField("memory.gbrain.mode", "off")) as "off" | "read" | "read-write"}
                        options={[
                          { value: "off", label: t("settings.options.disabled") },
                          { value: "read", label: t("settings.options.readOnly") },
                          { value: "read-write", label: t("settings.options.readWrite") },
                        ]}
                        onChange={(value) => setEngineField("memory.gbrain.mode", value)}
                      />
                      {String(getEngineField("memory.gbrain.mode", "off")) !== "off" && (
                        <>
                          <TextField label={t("settings.gbrain.source.label")} hint={t("settings.gbrain.source.hint")} value={String(getEngineField("memory.gbrain.source", ""))} placeholder="personal" onChange={(value) => setEngineField("memory.gbrain.source", value)} />
                          <NumberField label={t("settings.gbrain.timeout.label")} hint={t("settings.gbrain.timeout.hint")} value={Number(getEngineField("memory.gbrain.timeoutMs", 180_000))} min={1_000} max={600_000} step={1_000} format={(value) => t("settings.units.secondsShort", { count: Math.round(value / 1_000) })} onChange={(value) => setEngineField("memory.gbrain.timeoutMs", value)} />
                          <NumberField label={t("settings.gbrain.output.label")} hint={t("settings.gbrain.output.hint")} value={Number(getEngineField("memory.gbrain.maxOutputBytes", 200_000))} min={1_024} max={1_000_000} step={1_024} format={(value) => t("settings.units.kilobytesShort", { count: Math.round(value / 1_024) })} onChange={(value) => setEngineField("memory.gbrain.maxOutputBytes", value)} />
                        </>
                      )}
                    </div>
                  </section>
                </div>
              )}

              {visibleSection === "advanced" && (
                <div className="space-y-6">
                  <ExperimentalSettings config={config} onSaved={onSaved} />
                  <section>
                    <GroupTitle>{t("settings.groups.maintenance")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <Field label={t("settings.backup.label")} hint={t("settings.backup.hint")} stacked>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={exportConfig}>{t("settings.backup.export")}</Button>
                          <Button size="sm" variant="outline" onClick={() => importRef.current?.click()}>{t("settings.backup.import")}</Button>
                        </div>
                        {backupImportError && <p className="text-[12px] text-danger">{t("settings.backup.importError")}</p>}
                      </Field>
                      <Field label={t("settings.reset.label")} hint={t("settings.reset.hint")}>
                        <Button variant="outline" size="sm" onClick={() => { resetUiSettings(); applyScale(1); }}>{t("settings.reset.action")}</Button>
                      </Field>
                    </div>
                  </section>
                  <section>
                    <GroupTitle>{t("settings.groups.expert")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <NumberField label={t("settings.apiRetries.label")} hint={t("settings.apiRetries.hint")} value={Number(getEngineField("apiMaxRetries", 2))} min={0} max={10} step={1} onChange={(value) => setEngineField("apiMaxRetries", value)} />
                    </div>
                  </section>
                  <section>
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <h4 className="text-[13px] font-medium text-foreground">{t("settings.engineJson.label")}</h4>
                      <Button size="sm" variant="secondary" onClick={saveEngine}>{t("settings.engineJson.apply")}</Button>
                    </div>
                    <p className="mb-2 text-[12px] leading-snug text-muted">{t("settings.engineJson.hint")}</p>
                    <textarea value={engineText} onChange={(event) => setEngineText(event.target.value)} spellCheck={false} rows={12} aria-label={t("settings.engineJson.label")} className="w-full resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary" />
                    {engineError && <p className="mt-1 text-[12px] text-danger">{t("settings.engineJson.invalid")}</p>}
                  </section>
                  <input ref={importRef} type="file" accept="application/json" className="hidden" onChange={(event) => event.target.files?.[0] && importConfig(event.target.files[0])} />
                </div>
              )}

              {visibleSection === "about" && (
                <div className="space-y-3 py-2">
                  <div className="flex items-center gap-3">
                    <KyreiMark size="xl" />
                    <div>
                      <div className="text-[16px] font-bold">Kyrei</div>
                      <div className="text-[12px] text-muted">{t("settings.about.tagline")}</div>
                    </div>
                  </div>
                  <div className="divide-y divide-border-soft text-[13px]">
                    <div className="flex justify-between py-2"><span className="text-muted">{t("settings.about.version")}</span><span>{__APP_VERSION__}</span></div>
                    <div className="flex justify-between py-2"><span className="text-muted">{t("settings.about.engine")}</span><span>{t("settings.about.engineValue")}</span></div>
                    <div className="flex justify-between py-2"><span className="text-muted">{t("settings.about.provider")}</span><span className="truncate">{provider || "—"}</span></div>
                  </div>
                  <AboutUpdatePanel />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}

function safeEngine(text: string): Record<string, unknown> {
  try {
    const value = text.trim() ? JSON.parse(text) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
