import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  FolderOpen,
  Info,
  Keyboard,
  MessageSquare,
  Mic,
  Palette,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { gateway, type ModelCatalogEntry } from "@/lib/gateway";
import type { AppConfig } from "@/lib/types";
import { Button, Input } from "@/components/ui";
import { BoolField, EnumField, Field, NumberField, TextField } from "@/components/settings/ConfigField";
import { ThemeGrid } from "@/components/settings/ThemeGrid";
import { KeybindPanel } from "@/components/settings/KeybindPanel";
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
  initialSection?: SectionId;
}

export type SectionId = "general" | "chat" | "appearance" | "notifications" | "voice" | "keybinds" | "advanced" | "about";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "Модель и провайдер", icon: <Server className="size-4" /> },
  { id: "chat", label: "Чат", icon: <MessageSquare className="size-4" /> },
  { id: "appearance", label: "Оформление", icon: <Palette className="size-4" /> },
  { id: "notifications", label: "Уведомления", icon: <Bell className="size-4" /> },
  { id: "voice", label: "Голос", icon: <Mic className="size-4" /> },
  { id: "keybinds", label: "Клавиши", icon: <Keyboard className="size-4" /> },
  { id: "advanced", label: "Продвинутые", icon: <SlidersHorizontal className="size-4" /> },
  { id: "about", label: "О программе", icon: <Info className="size-4" /> },
];

export function Settings({ config, onClose, onSaved, initialSection = "general" }: SettingsProps) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const { lang } = useI18n();
  const ui = useUiSettings();
  const sttSupported = isSpeechRecognitionSupported();
  const ttsSupported = isSpeechSynthesisSupported();

  // ── Gateway-config draft (debounced autosave) ──────────────────────────
  const [provider, setProvider] = useState(config.provider);
  const [model, setModel] = useState(config.model);
  const [workspace, setWorkspace] = useState(config.workspace);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [engineText, setEngineText] = useState(() => JSON.stringify(config.engine ?? {}, null, 2));
  const [engineError, setEngineError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const themeImportRef = useRef<HTMLInputElement | null>(null);
  const [customActive, setCustomActive] = useState(isCustomThemeActive());
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    gateway.getModels().then((r) => setModels(r.models)).catch(() => {});
  }, []);

  const flash = useCallback(() => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  }, []);

  const persist = useCallback(
    async (patch: Partial<{ provider: string; apiKey: string; model: string; workspace: string; engine: Record<string, unknown> }>) => {
      try {
        const next = await gateway.setConfig(patch);
        onSaved(next);
        flash();
      } catch {
        /* gateway offline — keep local draft */
      }
    },
    [onSaved, flash],
  );

  // Debounced autosave for the text-y gateway fields.
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
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("объект");
      setEngineError(null);
      void persist({ engine: parsed as Record<string, unknown> });
    } catch {
      setEngineError("Некорректный JSON — не сохранено");
    }
  }, [engineText, persist]);

  // Structured engine-config editing (Hermes-style fields over the real
  // EngineConfig keys). Updates a local object + debounced-persists + keeps the
  // raw JSON editor in sync.
  const [engine, setEngine] = useState<Record<string, unknown>>(() => ({ ...(config.engine ?? {}) }));
  const getEngineField = (path: string, fallback: unknown): unknown => {
    let o: unknown = engine;
    for (const k of path.split(".")) {
      if (o == null || typeof o !== "object") return fallback;
      o = (o as Record<string, unknown>)[k];
    }
    return o ?? fallback;
  };
  const setEngineField = (path: string, value: unknown) => {
    setEngine((prev) => {
      const next: Record<string, unknown> = JSON.parse(JSON.stringify(prev));
      const keys = path.split(".");
      let o = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof o[keys[i]] !== "object" || o[keys[i]] == null) o[keys[i]] = {};
        o = o[keys[i]] as Record<string, unknown>;
      }
      o[keys[keys.length - 1]] = value;
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
        setCustomError("Не удалось разобрать тему");
        return;
      }
      applyCustomTheme(seeds);
      setCustomActive(true);
      setCustomError(null);
    };
    reader.readAsText(file);
  };

  const pickFolder = async () => {    const r = await gateway.chooseFolder();
    if (r.folder) {
      setWorkspace(r.folder);
      onSaved(r);
      flash();
    }
  };

  const exportConfig = () => {
    const data = { provider, model, workspace, hasKey: config.hasKey, engine: safeEngine(engineText), ui, lang };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kyrei-config.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importConfig = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (typeof data.provider === "string") setProvider(data.provider);
        if (typeof data.model === "string") setModel(data.model);
        if (typeof data.workspace === "string") setWorkspace(data.workspace);
        if (data.engine && typeof data.engine === "object") setEngineText(JSON.stringify(data.engine, null, 2));
        if (data.ui && typeof data.ui === "object") {
          for (const [k, v] of Object.entries(data.ui)) setUiSetting(k as never, v as never);
          if (typeof data.ui.scale === "number") applyScale(data.ui.scale);
        }
        if (data.lang === "ru" || data.lang === "en") setLang(data.lang);
        void persist({
          provider: String(data.provider ?? provider),
          model: String(data.model ?? model),
          workspace: String(data.workspace ?? workspace),
          engine: safeEngine(data.engine ? JSON.stringify(data.engine) : engineText),
        });
      } catch {
        /* ignore malformed import */
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex h-[min(88vh,44rem)] w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-surface shadow-nous overlay-blur"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Nav pane ── */}
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-bg/40 p-3">
          <div className="px-2 pb-2 pt-1 text-[15px] font-bold">Настройки</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                section === s.id ? "bg-elevated text-foreground" : "text-secondary hover:bg-(--ui-row-hover)",
              )}
            >
              <span className="text-muted">{s.icon}</span>
              {s.label}
            </button>
          ))}
          <div className="mt-auto space-y-1 pt-3">
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={exportConfig}>
              Экспорт конфига
            </Button>
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => importRef.current?.click()}>
              Импорт конфига
            </Button>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && importConfig(e.target.files[0])}
            />
          </div>
        </nav>

        {/* ── Content pane ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <span className="text-[14px] font-semibold">{SECTIONS.find((s) => s.id === section)?.label}</span>
            <div className="flex items-center gap-3">
              <span className={cn("text-[12px] text-success transition-opacity", savedFlash ? "opacity-100" : "opacity-0")}>
                Сохранено
              </span>
              <button onClick={onClose} className="text-muted hover:text-foreground" aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            {section === "general" && (
              <div className="divide-y divide-border-soft">
                <TextField
                  label="Провайдер (Base URL)"
                  hint="Совместимый с OpenAI endpoint. Провайдер по умолчанию не задаётся — укажите свой."
                  value={provider}
                  placeholder="https://api.openai.com/v1"
                  onChange={(v) => { setProvider(v); scheduleSave({ provider: v }); }}
                />
                <TextField
                  label="API-ключ"
                  hint={config.hasKey ? "Ключ сохранён. Оставьте пустым, чтобы не менять." : "Ключ хранится локально и не показывается обратно."}
                  type="password"
                  value={apiKey}
                  placeholder={config.hasKey ? "••••••••" : "sk-…"}
                  onChange={setApiKey}
                  trailing={
                    <Button variant="secondary" disabled={!apiKey.trim()} onClick={() => { void persist({ apiKey: apiKey.trim() }); setApiKey(""); }}>
                      Сохранить
                    </Button>
                  }
                />
                <Field label="Модель" hint="Известные модели подсказываются; можно ввести вручную." stacked>
                  <Input
                    list="kyrei-model-list"
                    value={model}
                    placeholder="gpt-4o-mini"
                    onChange={(e) => { setModel(e.target.value); scheduleSave({ model: e.target.value }); }}
                  />
                  <datalist id="kyrei-model-list">
                    {models.map((m) => <option key={`${m.provider}:${m.id}`} value={m.id}>{m.provider}</option>)}
                  </datalist>
                </Field>
                <Field label="Модели для ролей" hint="Названия моделей для основного ответа, коротких задач и планирования. Движок использует их при запуске оркестрации." stacked>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className="space-y-1 text-[11px] text-muted">
                      <span>Основная</span>
                      <Input value={String(getEngineField("providerRoles.default", "default"))} placeholder="default" onChange={(e) => setEngineField("providerRoles.default", e.target.value)} />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted">
                      <span>Быстрая</span>
                      <Input value={String(getEngineField("providerRoles.small", "small"))} placeholder="small" onChange={(e) => setEngineField("providerRoles.small", e.target.value)} />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted">
                      <span>План</span>
                      <Input value={String(getEngineField("providerRoles.plan", "plan"))} placeholder="plan" onChange={(e) => setEngineField("providerRoles.plan", e.target.value)} />
                    </label>
                  </div>
                </Field>
                <TextField
                  label="Рабочая папка"
                  hint="Включает файловые инструменты. Все операции ограничены этой папкой (jail)."
                  value={workspace}
                  placeholder="не выбрана"
                  onChange={(v) => { setWorkspace(v); scheduleSave({ workspace: v }); }}
                  trailing={
                    <Button variant="secondary" onClick={pickFolder}>
                      <FolderOpen size={15} /> Выбрать
                    </Button>
                  }
                />
              </div>
            )}

            {section === "chat" && (
              <div className="divide-y divide-border-soft">
                <Field label="Личность ассистента" hint="Стиль/тон для новых ответов. Добавляется в системный промпт движка." stacked>
                  <textarea
                    value={String(getEngineField("personality", ""))}
                    onChange={(e) => setEngineField("personality", e.target.value)}
                    spellCheck={false}
                    rows={3}
                    placeholder="Например: краткий технический эксперт; отвечай по делу, без воды."
                    className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60"
                  />
                </Field>
                <BoolField
                  label="Отправка по Enter"
                  hint="Enter — отправить, Shift+Enter — перенос строки. Иначе Cmd/Ctrl+Enter."
                  value={ui.sendOnEnter}
                  onChange={(v) => setUiSetting("sendOnEnter", v)}
                />
                <BoolField
                  label="Форматирование сообщений"
                  hint="Markdown, подсветка кода, формулы."
                  value={ui.richRendering}
                  onChange={(v) => setUiSetting("richRendering", v)}
                />
              </div>
            )}

            {section === "appearance" && (
              <div className="space-y-4">
                <div>
                  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Тема</h4>
                  <ThemeGrid />
                  <div className="mt-2.5 flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => themeImportRef.current?.click()}>
                      Импорт темы VS Code
                    </Button>
                    {customActive && (
                      <Button size="sm" variant="ghost" onClick={() => { clearCustomTheme(); applyTheme(getTheme()); setCustomActive(false); }}>
                        Сбросить кастомную
                      </Button>
                    )}
                    {customError && <span className="text-[12px] text-danger">{customError}</span>}
                    <input
                      ref={themeImportRef}
                      type="file"
                      accept="application/json,.json,.jsonc"
                      className="hidden"
                      onChange={(e) => e.target.files?.[0] && importTheme(e.target.files[0])}
                    />
                  </div>
                </div>
                <div className="divide-y divide-border-soft">
                  <EnumField
                    label="Язык интерфейса"
                    value={lang}
                    options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
                    onChange={(v: Lang) => setLang(v)}
                  />
                  <NumberField
                    label="Масштаб интерфейса"
                    hint="Размер текста и элементов."
                    value={ui.scale}
                    min={0.85}
                    max={1.3}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => { setUiSetting("scale", v); applyScale(v); }}
                  />
                  <EnumField
                    label="Плотность"
                    value={ui.density}
                    options={[
                      { value: "comfortable", label: "Свободно" },
                      { value: "compact", label: "Плотно" },
                    ]}
                    onChange={(v) => setUiSetting("density", v)}
                  />
                  <EnumField
                    label="Вид инструментов по умолчанию"
                    hint="Компактно — свёрнуто; технически — с деталями."
                    value={ui.toolView}
                    options={[
                      { value: "compact", label: "Компактно" },
                      { value: "technical", label: "Технически" },
                    ]}
                    onChange={(v) => setUiSetting("toolView", v)}
                  />
                </div>
              </div>
            )}

            {section === "notifications" && (
              <div className="divide-y divide-border-soft">
                <BoolField
                  label="Уведомления"
                  hint="Главный переключатель для всех уведомлений."
                  value={ui.notify}
                  onChange={(v) => setUiSetting("notify", v)}
                />
                <BoolField
                  label="Звук завершения"
                  hint="Короткий сигнал по завершении ответа."
                  value={ui.notifySound}
                  onChange={(v) => setUiSetting("notifySound", v)}
                />
                <Field label="Проверить звук">
                  <Button variant="outline" size="sm" onClick={playChime} disabled={!ui.notifySound}>Воспроизвести</Button>
                </Field>
                <BoolField
                  label="Системные уведомления"
                  hint="Нативное уведомление ОС, когда окно свёрнуто."
                  value={ui.notifyNative}
                  onChange={(v) => setUiSetting("notifyNative", v)}
                />
              </div>
            )}

            {section === "voice" && (
              <div className="divide-y divide-border-soft">
                {!sttSupported && !ttsSupported && (
                  <p className="py-2 text-[12px] text-warning">Голосовые функции недоступны в этой среде.</p>
                )}
                <BoolField
                  label="Голосовой ввод (диктовка)"
                  hint={sttSupported ? "Кнопка микрофона в композере — распознавание речи через Web Speech API." : "Распознавание речи недоступно в этой среде."}
                  value={ui.voiceInput && sttSupported}
                  onChange={(v) => setUiSetting("voiceInput", v)}
                />
                <BoolField
                  label="Авто-озвучка ответов"
                  hint={ttsSupported ? "Зачитывать ответы ассистента вслух по завершении хода." : "Синтез речи недоступен в этой среде."}
                  value={ui.autoSpeak && ttsSupported}
                  onChange={(v) => setUiSetting("autoSpeak", v)}
                />
                <TextField
                  label="Язык речи (BCP-47)"
                  hint="Например, ru-RU или en-US. Пусто — язык системы."
                  value={ui.voiceLang}
                  placeholder="ru-RU"
                  onChange={(v) => setUiSetting("voiceLang", v)}
                />
                <Field label="Проверить озвучку">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!ttsSupported}
                    onClick={() => speak("Проверка синтеза речи Kyrei.", { lang: ui.voiceLang || undefined })}
                  >
                    Воспроизвести
                  </Button>
                </Field>
                <p className="py-2 text-[11px] leading-snug text-muted">
                  Голосовые функции используют Web Speech API среды Kyrei. Распознавание может задействовать облачный сервис платформы.
                </p>
              </div>
            )}

            {section === "keybinds" && <KeybindPanel />}

            {section === "advanced" && (
              <div className="space-y-4">
                <div>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Движок</h4>
                  <div className="divide-y divide-border-soft">
                    <NumberField
                      label="Макс. шагов"
                      hint="Предел итераций инструментов за ход."
                      value={Number(getEngineField("maxSteps", 12))}
                      min={1} max={60} step={1}
                      onChange={(v) => setEngineField("maxSteps", v)}
                    />
                    <NumberField
                      label="Ретраи API"
                      hint="Повторы запроса к провайдеру при временных сбоях."
                      value={Number(getEngineField("apiMaxRetries", 2))}
                      min={0} max={10} step={1}
                      onChange={(v) => setEngineField("apiMaxRetries", v)}
                    />
                    <NumberField
                      label="Таймаут команды"
                      hint="Максимум на одну команду терминала."
                      value={Number(getEngineField("commandTimeoutMs", 60000))}
                      min={5000} max={600000} step={5000}
                      format={(v) => `${Math.round(v / 1000)}с`}
                      onChange={(v) => setEngineField("commandTimeoutMs", v)}
                    />
                    <NumberField
                      label="Лимит вывода инструмента"
                      hint="Максимум символов из одного результата."
                      value={Number(getEngineField("maxToolOutput", 12000))}
                      min={2000} max={100000} step={1000}
                      onChange={(v) => setEngineField("maxToolOutput", v)}
                    />
                    <NumberField
                      label="Лимит чтения файла"
                      hint="Максимум символов, возвращаемых read_file (отдельно от вывода инструментов)."
                      value={Number(getEngineField("fileReadMaxChars", 250000))}
                      min={10000} max={2000000} step={10000}
                      format={(v) => `${Math.round(v / 1000)}k`}
                      onChange={(v) => setEngineField("fileReadMaxChars", v)}
                    />
                    <EnumField
                      label="Терминал (автономность)"
                      hint="off — спрашивать всегда; auto — по правилам; turbo — без подтверждений."
                      value={String(getEngineField("permissions.terminal", "auto")) as "off" | "auto" | "turbo"}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "auto", label: "Auto" },
                        { value: "turbo", label: "Turbo" },
                      ]}
                      onChange={(v) => setEngineField("permissions.terminal", v)}
                    />
                    <EnumField
                      label="Ревью правок"
                      hint="always — подтверждать всегда; agent — на усмотрение агента; request — по запросу."
                      value={String(getEngineField("permissions.review", "agent")) as "always" | "agent" | "request"}
                      options={[
                        { value: "always", label: "Always" },
                        { value: "agent", label: "Agent" },
                        { value: "request", label: "Request" },
                      ]}
                      onChange={(v) => setEngineField("permissions.review", v)}
                    />
                    <NumberField
                      label="Контекст: мягкий порог"
                      hint="Доля окна, после которой начинается компакция."
                      value={Number(getEngineField("contextBudget.softPct", 0.75))}
                      min={0.3} max={0.95} step={0.05}
                      format={(v) => `${Math.round(v * 100)}%`}
                      onChange={(v) => setEngineField("contextBudget.softPct", v)}
                    />
                    <NumberField
                      label="Контекст: жёсткий порог"
                      hint="Доля окна, при которой компакция принудительна."
                      value={Number(getEngineField("contextBudget.hardPct", 0.9))}
                      min={0.5} max={0.99} step={0.05}
                      format={(v) => `${Math.round(v * 100)}%`}
                      onChange={(v) => setEngineField("contextBudget.hardPct", v)}
                    />
                    <EnumField
                      label="Песочница команд"
                      hint="strict — изолировать run_command (best-effort)."
                      value={String(getEngineField("sandbox", "off")) as "off" | "strict"}
                      options={[
                        { value: "off", label: "Off" },
                        { value: "strict", label: "Strict" },
                      ]}
                      onChange={(v) => setEngineField("sandbox", v)}
                    />
                    <TextField
                      label="Fallback-цепочка моделей"
                      hint="Через запятую — резервные модели при ошибке основной."
                      value={(getEngineField("fallbackChain", []) as string[]).join(", ")}
                      placeholder="gpt-4o-mini, claude-3-5-sonnet"
                      onChange={(v) => setEngineField("fallbackChain", v.split(",").map((s) => s.trim()).filter(Boolean))}
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <h4 className="text-[13px] font-medium text-foreground">Конфигурация движка (JSON)</h4>
                    <Button size="sm" variant="secondary" onClick={saveEngine}>Применить</Button>
                  </div>
                  <p className="mb-2 text-[12px] leading-snug text-muted">
                    Тонкая настройка целиком. Проверяется движком (fail-open).
                  </p>
                  <textarea
                    value={engineText}
                    onChange={(e) => setEngineText(e.target.value)}
                    spellCheck={false}
                    rows={12}
                    className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary/60"
                  />
                  {engineError && <p className="mt-1 text-[12px] text-danger">{engineError}</p>}
                </div>
                <div className="border-t border-border-soft pt-3">
                  <Button variant="outline" size="sm" onClick={() => { resetUiSettings(); applyScale(1); }}>
                    Сбросить настройки интерфейса
                  </Button>
                </div>
              </div>
            )}

            {section === "about" && (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-3">
                  <div className="grid size-12 place-items-center rounded-xl border border-border-soft bg-accent text-[22px] font-semibold text-foreground">K</div>
                  <div>
                    <div className="text-[16px] font-bold">Kyrei</div>
                    <div className="text-[12px] text-muted">Локальный AI-агент для работы с кодом</div>
                  </div>
                </div>
                <div className="divide-y divide-border-soft text-[13px]">
                  <div className="flex justify-between py-2"><span className="text-muted">Версия</span><span>{__APP_VERSION__}</span></div>
                  <div className="flex justify-between py-2"><span className="text-muted">Движок</span><span>Kyrei Engine v2</span></div>
                  <div className="flex justify-between py-2"><span className="text-muted">Провайдер</span><span className="truncate">{provider || "—"}</span></div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function safeEngine(text: string): Record<string, unknown> {
  try {
    const v = text.trim() ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
