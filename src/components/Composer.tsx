import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, Layers3, X, Maximize2, Minimize2, Mic, Plus, FileText, Folder, Image as ImageIcon, Clipboard, MessageSquareText, Volume2, VolumeX } from "lucide-react";
import { getSlashCommands, parseSlash, resolveSlashCommand } from "@/lib/slash-commands";
import { gateway } from "@/lib/gateway";
import {
  $queuedPromptsBySession,
  dequeueQueuedPrompt,
  enqueueQueuedPrompt,
  removeQueuedPrompt,
} from "@/store/composer-queue";
import { useAtom } from "@/store/atom";
import { setUiSetting, useUiSettings } from "@/store/settings";
import { addSnippet, useSnippets } from "@/store/snippets";
import { createRecognizer, isSpeechRecognitionSupported, isSpeechSynthesisSupported, type Recognizer } from "@/lib/speech";
import { ModelPill } from "./composer/ModelPill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  dropdownMenuRow,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface ComposerProps {
  streaming: boolean;
  disabled?: boolean;
  sessionId?: string | null;
  model: string;
  provider: string;
  hasWorkspace?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onCommand: (name: string, arg?: string) => void;
  onModelChange: (providerId: string, modelId: string) => void;
}

interface MentionState {
  query: string;
  start: number;
  entries: { name: string; path: string; dir: boolean }[];
  index: number;
}

export function Composer({
  streaming,
  disabled,
  sessionId,
  model,
  provider,
  hasWorkspace,
  onSend,
  onStop,
  onCommand,
  onModelChange,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const { sendOnEnter, voiceInput, voiceLang, autoSpeak } = useUiSettings();
  const [listening, setListening] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const snippets = useSnippets(t);
  const recognizer = useRef<Recognizer | null>(null);
  const dictationBase = useRef("");
  const micSupported = isSpeechRecognitionSupported();
  const speechSupported = isSpeechSynthesisSupported();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const history = useRef<string[]>([]);
  const browse = useRef<number | null>(null);
  const draining = useRef(false);

  const queues = useAtom($queuedPromptsBySession);
  const queued = sessionId ? queues[sessionId] ?? [] : [];

  const slashCommands = useMemo(() => getSlashCommands(t), [t]);
  const suggestions = useMemo(() => {
    if (slashDismissed) return [];
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
    const q = value.slice(1).toLowerCase();
    return slashCommands.filter((c) => c.name.startsWith(q));
  }, [value, slashDismissed, slashCommands]);

  useEffect(() => { setSel(0); setSlashDismissed(false); }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cap = expanded ? Math.round(window.innerHeight * 0.55) : 220;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [value, expanded]);

  // Auto-drain the queue one prompt at a time whenever the session goes idle.
  useEffect(() => {
    if (streaming || !sessionId || queued.length === 0 || draining.current) return;
    draining.current = true;
    const head = dequeueQueuedPrompt(sessionId);
    draining.current = false;
    if (head) onSend(head.text);
  }, [streaming, sessionId, queued.length, onSend]);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    // Slash commands dispatch locally.
    if (text.startsWith("/")) {
      const { name, arg } = parseSlash(text);
      const command = resolveSlashCommand(name);
      if (command) {
        onCommand(command.id, arg || undefined);
        setValue("");
        return;
      }
    }
    if (streaming) {
      // Busy → queue for the next turn instead of dropping the message.
      if (sessionId) enqueueQueuedPrompt(sessionId, { text, attachments: [] });
      setValue("");
      return;
    }
    if (history.current[history.current.length - 1] !== text) history.current.push(text);
    browse.current = null;
    onSend(text);
    setValue("");
  };
  const toggleDictation = () => {
    if (listening) {
      recognizer.current?.stop();
      setListening(false);
      return;
    }
    dictationBase.current = value ? value.replace(/\s*$/, "") + " " : "";
    const rec = createRecognizer({
      lang: voiceLang || undefined,
      onResult: (transcript, isFinal) => {
        if (isFinal) {
          dictationBase.current = (dictationBase.current + transcript).replace(/\s*$/, "") + " ";
          setValue(dictationBase.current);
        } else {
          setValue(dictationBase.current + transcript);
        }
      },
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    });
    if (!rec) return;
    recognizer.current = rec;
    rec.start();
    // Reflect actual state on the next tick — if start() threw internally the
    // recognizer never began, so don't leave the mic pulsing forever.
    setListening(true);
    ref.current?.focus();
  };

  useEffect(() => () => recognizer.current?.stop(), []);

  // Append local context or a saved snippet at the end and focus.
  const insertText = (text: string) => {
    if (!text) return;
    const base = value.replace(/\s*$/, "");
    const next = base ? `${base} ${text}` : text;
    setValue(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      const pos = next.length;
      try { el?.setSelectionRange(pos, pos); } catch { /* ignore */ }
    });
  };

  // Native OS file/folder/image picker → insert resolved absolute paths.
  const openPicker = (opts: { accept?: string; dir?: boolean } = {}) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (opts.accept) input.accept = opts.accept;
    if (opts.dir) (input as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      const paths = files.map((f) => window.kyrei?.getPathForFile?.(f) || f.name).filter(Boolean);
      if (!paths.length) return;
      if (opts.dir) insertText(paths[0].replace(/[\\/][^\\/]*$/, "") || paths[0]);
      else insertText(paths.join(" "));
    };
    input.click();
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) { insertText(text.trim()); return; }
    } catch { /* denied */ }
    try {
      const items = await navigator.clipboard.read();
      if (items.some((it) => it.types.some((type) => type.startsWith("image/")))) insertText(t("chat.composer.pastedImage"));
    } catch { /* denied */ }
  };

  const saveSnippet = () => {
    const text = value.trim();
    if (!text) return;
    const title = window.prompt(t("chat.snippets.namePrompt"), text.slice(0, 32)) ?? "";
    addSnippet(title, text);
  };

  const pickSuggestion = (index: number) => {
    const c = suggestions[index];
    if (!c) return;
    if (c.arg) {
      setValue(`/${c.name} `);
      ref.current?.focus();
    } else {
      onCommand(c.name);
      setValue("");
    }
  };

  // ── @-mention completion (jail-safe via gateway) ────────────────────────
  const refreshMention = (text: string, caret: number) => {
    if (!hasWorkspace) return setMention(null);
    const before = text.slice(0, caret);
    const m = /@(\S*)$/.exec(before);
    if (!m) return setMention(null);
    const query = m[1];
    const start = caret - m[0].length;
    void gateway
      .completePath(query)
      .then((entries) => setMention({ query, start, entries: entries.slice(0, 8), index: 0 }))
      .catch(() => setMention(null));
  };

  const applyMention = (index: number) => {
    if (!mention) return;
    const entry = mention.entries[index];
    if (!entry) return;
    const kind = entry.dir ? "folder" : "file";
    const caret = ref.current?.selectionStart ?? value.length;
    const ref2 = `@${kind}:${entry.path}${entry.dir ? "/" : ""} `;
    const next = value.slice(0, mention.start) + ref2 + value.slice(caret);
    setValue(next);
    setMention(null);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.entries.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMention({ ...mention, index: (mention.index + 1) % mention.entries.length }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMention({ ...mention, index: (mention.index - 1 + mention.entries.length) % mention.entries.length }); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mention.index); return; }
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
    }

    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Tab") { e.preventDefault(); setValue(`/${suggestions[sel].name} `); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickSuggestion(sel); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true); return; }
    }

    // Send semantics honor the sendOnEnter preference. Cmd/Ctrl+Enter always
    // submits (steer/force), regardless of the mode.
    if (e.key === "Enter") {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd) { e.preventDefault(); submit(); return; }
      if (sendOnEnter && !e.shiftKey) { e.preventDefault(); submit(); return; }
      // sendOnEnter === false → plain Enter inserts a newline (default behavior).
    }

    const h = history.current;
    if (e.key === "ArrowUp") {
      if (!h.length || value.includes("@")) return;
      if (browse.current === null) { if (value.trim() !== "") return; browse.current = h.length; }
      browse.current = Math.max(0, browse.current - 1);
      e.preventDefault();
      setValue(h[browse.current]);
    } else if (e.key === "ArrowDown" && browse.current !== null) {
      e.preventDefault();
      browse.current += 1;
      if (browse.current >= h.length) { browse.current = null; setValue(""); }
      else setValue(h[browse.current]);
    }
  };

  return (
    <div className="composer-area shrink-0 px-4 pb-3 pt-2 max-sm:px-2">
      <div className="relative mx-auto max-w-[52rem]">
        {/* Queue panel */}
        {queued.length > 0 && (
          <div className="mb-2 overflow-hidden rounded-xl border border-border-soft bg-surface/70">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-muted">
              <Layers3 className="size-3.5" /> {t("chat.queue.count", { count: queued.length })}
            </div>
            <div className="composer-queue-list max-h-[min(14rem,30vh)] overflow-y-auto">
              {queued.map((q) => (
                <div key={q.id} className="flex items-center gap-2 border-t border-border-soft px-3 py-1.5 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate text-secondary">{q.text}</span>
                  <button
                    onClick={() => sessionId && removeQueuedPrompt(sessionId, q.id)}
                    className="grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-(--ui-row-hover) hover:text-foreground"
                    aria-label={t("chat.queue.remove")}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* @-mention popover */}
        {mention && mention.entries.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-80 overflow-hidden rounded-xl bg-elevated py-1 shadow-nous overlay-blur">
            {mention.entries.map((e, i) => (
              <button
                key={e.path}
                onMouseDown={(ev) => { ev.preventDefault(); applyMention(i); }}
                onMouseEnter={() => setMention({ ...mention, index: i })}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px]", i === mention.index && "bg-(--ui-row-hover)")}
              >
                <span className={cn("truncate", e.dir ? "text-primary" : "text-secondary")}>{e.name}{e.dir ? "/" : ""}</span>
                <span className="ml-auto truncate text-[10.5px] text-muted">{e.path}</span>
              </button>
            ))}
          </div>
        )}

        {/* Slash popover */}
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-xl bg-elevated py-1 shadow-nous overlay-blur">
            {suggestions.map((c, i) => (
              <button
                key={c.name}
                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(i); }}
                onMouseEnter={() => setSel(i)}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left", i === sel && "bg-(--ui-row-hover)")}
              >
                <span className="font-mono text-[13px] text-primary">{c.command}</span>
                {c.arg && <span className="font-mono text-[11px] text-muted">{c.arg}</span>}
                <span className="ml-auto text-[11.5px] text-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}

        <div className={cn(
          "composer-card rounded-[10px] border border-border-soft px-2.5 py-2 transition-all focus-within:border-(--ui-composer-focus)",
          (expanded || value.includes("\n")) && "is-stacked",
        )}>
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            data-composer-input
            onChange={(e) => {
              setValue(e.target.value);
              browse.current = null;
              refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => window.setTimeout(() => setMention(null), 120)}
            placeholder={disabled ? t("chat.composer.connecting") : t("chat.composer.placeholder")}
            className={cn(
              "w-full resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted",
              expanded ? "min-h-[40vh] max-h-[55vh]" : "min-h-[24px] max-h-[220px]",
            )}
          />
          <div className="composer-controls">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                   className="composer-tool grid size-7 place-items-center rounded-md text-muted transition-colors hover:text-foreground data-[state=open]:bg-(--ui-row-active) data-[state=open]:text-foreground"
                  title={t("chat.composer.addContext")}
                  aria-label={t("chat.composer.addContext")}
                >
                  <Plus size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-64">
                <DropdownMenuLabel>{t("chat.composer.attach")}</DropdownMenuLabel>
                <DropdownMenuItem className={dropdownMenuRow} onSelect={(e) => { e.preventDefault(); openPicker(); }}>
                  <FileText size={15} /> {t("chat.composer.attachFiles")}
                </DropdownMenuItem>
                <DropdownMenuItem className={dropdownMenuRow} onSelect={(e) => { e.preventDefault(); openPicker({ dir: true }); }}>
                  <Folder size={15} /> {t("chat.composer.attachFolder")}
                </DropdownMenuItem>
                <DropdownMenuItem className={dropdownMenuRow} onSelect={(e) => { e.preventDefault(); openPicker({ accept: "image/*" }); }}>
                  <ImageIcon size={15} /> {t("chat.composer.attachImages")}
                </DropdownMenuItem>
                <DropdownMenuItem className={dropdownMenuRow} onSelect={(e) => { e.preventDefault(); void pasteFromClipboard(); }}>
                  <Clipboard size={15} /> {t("chat.composer.pasteClipboard")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className={dropdownMenuRow}>
                    <MessageSquareText size={15} /> {t("chat.snippets.menu")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-60">
                    {snippets.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-muted">{t("chat.snippets.empty")}</div>
                    ) : (
                      snippets.map((s) => (
                        <DropdownMenuItem key={s.id} className={dropdownMenuRow} onSelect={() => insertText(s.text)}>
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        </DropdownMenuItem>
                      ))
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className={cn(dropdownMenuRow, "text-muted")} disabled={!value.trim()} onSelect={(e) => { e.preventDefault(); saveSnippet(); }}>
                      <Plus size={14} /> {t("chat.snippets.saveCurrent")}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <div className="px-2 py-1 text-[11px] leading-snug text-muted">
                  {t("chat.composer.contextHint")}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <ModelPill model={model} provider={provider} onModelChange={onModelChange} />
            <button
              onClick={() => setExpanded((v) => !v)}
              className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-(--ui-row-hover) hover:text-foreground"
              title={expanded ? t("chat.composer.collapse") : t("chat.composer.expand")}
              aria-label={expanded ? t("chat.composer.collapse") : t("chat.composer.expand")}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            {voiceInput && micSupported && (
              <button
                onClick={toggleDictation}
                className={cn(
                  "grid size-7 place-items-center rounded-md transition-colors",
                  listening
                    ? "animate-pulse bg-danger/20 text-danger"
                    : "text-muted hover:bg-(--ui-row-hover) hover:text-foreground",
                )}
                title={listening ? t("chat.composer.stopDictation") : t("chat.composer.startDictation")}
                aria-label={listening ? t("chat.composer.stopDictation") : t("chat.composer.startDictation")}
                aria-pressed={listening}
              >
                <Mic size={14} />
              </button>
            )}
            {speechSupported && (
              <button
                onClick={() => setUiSetting("autoSpeak", !autoSpeak)}
                className={cn(
                  "grid size-7 place-items-center rounded-md transition-colors",
                  autoSpeak
                    ? "bg-(--ui-row-active) text-foreground"
                    : "text-muted hover:bg-(--ui-row-hover) hover:text-foreground",
                )}
                title={autoSpeak ? t("chat.composer.disableSpeech") : t("chat.composer.enableSpeech")}
                aria-label={autoSpeak ? t("chat.composer.disableSpeech") : t("chat.composer.enableSpeech")}
                aria-pressed={autoSpeak}
              >
                {autoSpeak ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
            )}
            <div className="ml-auto">
              {streaming ? (
                <div className="flex items-center gap-1">
                  {value.trim() && (
                    <button
                      onClick={submit}
                      className="send-button grid size-8 place-items-center rounded-[8px] bg-foreground text-bg transition-all hover:-translate-y-px"
                      title={t("chat.composer.queue")}
                      aria-label={t("chat.composer.queue")}
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                  <button
                    onClick={onStop}
                    className="grid size-8 place-items-center rounded-[8px] bg-danger text-white transition-colors hover:brightness-110"
                    title={t("chat.composer.stop")}
                    aria-label={t("chat.composer.stop")}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={submit}
                  disabled={!value.trim()}
                   className="send-button grid size-8 place-items-center rounded-[8px] bg-foreground text-bg transition-all hover:-translate-y-px disabled:translate-y-0 disabled:opacity-30"
                  title={t("chat.composer.send")}
                  aria-label={t("chat.composer.send")}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
