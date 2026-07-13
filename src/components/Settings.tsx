import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  Blocks,
  Box,
  BrainCircuit,
  FolderOpen,
  Info,
  Keyboard,
  MessageSquare,
  Palette,
  Network,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { gateway } from "@/lib/gateway";
import { rebaseImportedPipelines } from "@/lib/pipeline-import";
import type { AppConfig } from "@/lib/types";
import { Button } from "@/components/ui";
import { BoolField, EnumField, Field, NumberField, TextField } from "@/components/settings/ConfigField";
import { ThemeGrid } from "@/components/settings/ThemeGrid";
import { KeybindPanel } from "@/components/settings/KeybindPanel";
import { ModelSettings } from "@/components/settings/models/ModelSettings";
import { ProvidersSettings } from "@/components/settings/providers/ProvidersSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
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
  appearance: <Palette className="size-4" />,
  notifications: <Bell className="size-4" />,
  keybinds: <Keyboard className="size-4" />,
  advanced: <SlidersHorizontal className="size-4" />,
  about: <Info className="size-4" />,
};

function GroupTitle({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</h4>;
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
  const [engineError, setEngineError] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (saveTimer.current) clearTimeout(saveTimer.current);
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
        onSaved(next);
        flash();
        return true;
      } catch {
        // The draft remains editable while the local gateway is unavailable.
        return false;
      }
    },
    [onSaved, flash],
  );

  const scheduleSave = useCallback(
    (patch: Partial<{ provider: string; model: string; workspace: string }>) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persist(patch), 500);
    },
    [persist],
  );

  const saveEngine = useCallback(() => {
    try {
      const parsed = engineText.trim() ? JSON.parse(engineText) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("engine-object-required");
      setEngineError(false);
      void persist({ engine: parsed as Record<string, unknown> });
    } catch {
      setEngineError(true);
    }
  }, [engineText, persist]);

  const [engine, setEngine] = useState<Record<string, unknown>>(() => ({ ...(config.engine ?? {}) }));
  const getEngineField = (path: string, fallback: unknown): unknown => {
    let current: unknown = engine;
    for (const key of path.split(".")) {
      if (current == null || typeof current !== "object") return fallback;
      current = (current as Record<string, unknown>)[key];
    }
    return current ?? fallback;
  };
  const setEngineField = (path: string, value: unknown) => {
    setEngine((previous) => {
      const next: Record<string, unknown> = JSON.parse(JSON.stringify(previous));
      const keys = path.split(".");
      let current = next;
      for (let index = 0; index < keys.length - 1; index++) {
        if (typeof current[keys[index]] !== "object" || current[keys[index]] == null) current[keys[index]] = {};
        current = current[keys[index]] as Record<string, unknown>;
      }
      current[keys[keys.length - 1]] = value;
      setEngineText(JSON.stringify(next, null, 2));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persist({ engine: next }), 500);
      return next;
    });
  };

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

  const overlay = (
    <div
      className="fixed inset-x-0 top-[var(--app-titlebar-h)] bottom-[var(--app-statusbar-h)] z-[100] grid min-h-0 place-items-center bg-black/78 p-3 sm:p-5"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
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
              <span className={cn("text-[12px] text-success transition-opacity", savedFlash ? "opacity-100" : "opacity-0")}>
                {t("settings.saved")}
              </span>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
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
                        value={String(getEngineField("permissions.terminal", "auto")) as "off" | "auto" | "turbo"}
                        options={[
                          { value: "off", label: t("settings.options.off") },
                          { value: "auto", label: t("settings.options.auto") },
                          { value: "turbo", label: t("settings.options.turbo") },
                        ]}
                        onChange={(value) => setEngineField("permissions.terminal", value)}
                      />
                      <EnumField
                        label={t("settings.permissions.review.label")}
                        hint={t("settings.permissions.review.hint")}
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
                        value={String(getEngineField("permissions.web", "read")) as "off" | "search" | "read"}
                        options={[
                          { value: "off", label: t("settings.options.off") },
                          { value: "search", label: t("settings.options.search") },
                          { value: "read", label: t("settings.options.read") },
                        ]}
                        onChange={(value) => setEngineField("permissions.web", value)}
                      />
                      <NumberField
                        label={t("settings.commandTimeout.label")}
                        hint={t("settings.commandTimeout.hint")}
                        value={Number(getEngineField("commandTimeoutMs", 60000))}
                        min={5000} max={600000} step={5000}
                        format={(value) => t("settings.units.secondsShort", { count: Math.round(value / 1000) })}
                        onChange={(value) => setEngineField("commandTimeoutMs", value)}
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

              {visibleSection === "skills" && <SkillsSettings workspace={workspace} />}

              {visibleSection === "chat" && (
                <div className="space-y-6">
                  <section>
                    <GroupTitle>{t("settings.groups.chat")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
                      <Field label={t("settings.personality.label")} hint={t("settings.personality.hint")} stacked>
                        <textarea
                          value={String(getEngineField("personality", ""))}
                          onChange={(event) => setEngineField("personality", event.target.value)}
                          spellCheck={false}
                          rows={3}
                          placeholder={t("settings.personality.placeholder")}
                          className="w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary"
                        />
                      </Field>
                      <BoolField label={t("settings.sendOnEnter.label")} hint={t("settings.sendOnEnter.hint")} value={ui.sendOnEnter} onChange={(value) => setUiSetting("sendOnEnter", value)} />
                      <BoolField label={t("settings.richRendering.label")} hint={t("settings.richRendering.hint")} value={ui.richRendering} onChange={(value) => setUiSetting("richRendering", value)} />
                      <BoolField label={t("settings.showReasoning.label")} hint={t("settings.showReasoning.hint")} value={ui.showReasoning} onChange={(value) => setUiSetting("showReasoning", value)} />
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
                      <NumberField label={t("settings.maxSteps.label")} hint={t("settings.maxSteps.hint")} value={Number(getEngineField("maxSteps", 12))} min={1} max={60} step={1} onChange={(value) => setEngineField("maxSteps", value)} />
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
                        </>
                      )}
                      <NumberField label={t("settings.contextSoft.label")} hint={t("settings.contextSoft.hint")} value={Number(getEngineField("contextBudget.softPct", 0.75))} min={0.3} max={0.95} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => setEngineField("contextBudget.softPct", value)} />
                      <NumberField label={t("settings.contextHard.label")} hint={t("settings.contextHard.hint")} value={Number(getEngineField("contextBudget.hardPct", 0.9))} min={0.5} max={0.99} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onChange={(value) => setEngineField("contextBudget.hardPct", value)} />
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
                    <GroupTitle>{t("settings.groups.gbrain")}</GroupTitle>
                    <div className="divide-y divide-border-soft">
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
                          <TextField label={t("settings.gbrain.command.label")} hint={t("settings.gbrain.command.hint")} value={String(getEngineField("memory.gbrain.command", "gbrain"))} placeholder="gbrain" onChange={(value) => setEngineField("memory.gbrain.command", value)} />
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
                    <div className="grid size-12 place-items-center rounded-lg border border-border-soft bg-accent text-[22px] font-semibold text-foreground">K</div>
                    <div>
                      <div className="text-[16px] font-bold">Kyrei</div>
                      <div className="text-[12px] text-muted">{t("settings.about.tagline")}</div>
                    </div>
                  </div>
                  <div className="divide-y divide-border-soft text-[13px]">
                    <div className="flex justify-between py-2"><span className="text-muted">{t("settings.about.version")}</span><span>{__APP_VERSION__}</span></div>
                    <div className="flex justify-between py-2"><span className="text-muted">{t("settings.about.engine")}</span><span>Kyrei Engine v2</span></div>
                    <div className="flex justify-between py-2"><span className="text-muted">{t("settings.about.provider")}</span><span className="truncate">{provider || "—"}</span></div>
                  </div>
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
