import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Square, Layers3, X, Maximize2, Minimize2, Mic, Plus, FileText, Folder, Image as ImageIcon, Clipboard, MessageSquareText, Volume2, VolumeX, Puzzle, Check, Bot, ShieldCheck, History } from "lucide-react";
import { getSlashCommands, parseSlash, resolveSlashCommand } from "@/lib/slash-commands";
import { gateway } from "@/lib/gateway";
import {
  $queuedPromptsBySession,
  dequeueQueuedPrompt,
  enqueueQueuedPrompt,
  removeQueuedPrompt,
} from "@/store/composer-queue";
import { subscribeComposerSkillSelection } from "@/store/composer-skills";
import { useAtom } from "@/store/atom";
import { setUiSetting, useUiSettings } from "@/store/settings";
import { addSnippet, useSnippets } from "@/store/snippets";
import {
  stashSessionDraft,
  takeSessionDraft,
  type ComposerAttachment,
} from "@/store/composer-draft";
import { createRecognizer, isSpeechRecognitionSupported, isSpeechSynthesisSupported, type Recognizer } from "@/lib/speech";
import { ModelPill } from "./composer/ModelPill";
import { ModePill } from "./composer/ModePill";
import type { CodingMode } from "@/lib/coding-mode";
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
import { shouldRestoreComposerFocus } from "@/lib/composer-focus";
import { useI18n } from "@/i18n";
import type { ProviderProfile, SkillInfo } from "@/lib/types";

const MAX_SELECTED_SKILLS = 32;

interface ComposerProps {
  streaming: boolean;
  stopping?: boolean;
  disabled?: boolean;
  sessionId?: string | null;
  model: string;
  provider: string;
  providers?: readonly ProviderProfile[];
  hasWorkspace?: boolean;
  onSend: (
    text: string,
    skillIds?: string[],
    images?: Array<{ name: string; mediaType: string; data: string }>,
  ) => void;
  /** Team role skills are configured in Team settings to keep assignments explicit. */
  skillsSelectable?: boolean;
  /** Kiro-style execution mode: autopilot vs supervised file review. */
  executionMode?: "autopilot" | "supervised";
  onExecutionModeChange?: (mode: "autopilot" | "supervised") => void;
  /** Agent workflow mode: auto / plan / build / polish / deepreep. */
  codingMode?: CodingMode;
  onCodingModeChange?: (mode: CodingMode) => void;
  /** View all agent file changes and optional revert-all. */
  onViewChanges?: () => void;
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
  stopping = false,
  disabled,
  sessionId,
  model,
  provider,
  providers = [],
  hasWorkspace,
  onSend,
  onStop,
  onCommand,
  onModelChange,
  skillsSelectable = true,
  executionMode = "autopilot",
  codingMode = "auto",
  onCodingModeChange,
  onExecutionModeChange,
  onViewChanges,
}: ComposerProps) {
  const initialDraft = takeSessionDraft(sessionId);
  const [value, setValue] = useState(() => initialDraft.text);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => initialDraft.attachments);
  const [sel, setSel] = useState(0);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const { sendOnEnter, voiceInput, voiceLang, autoSpeak } = useUiSettings();
  const [listening, setListening] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const snippets = useSnippets(t);
  const recognizer = useRef<Recognizer | null>(null);
  const dictationBase = useRef("");
  const micSupported = isSpeechRecognitionSupported();
  const speechSupported = isSpeechSynthesisSupported();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const restoreComposerFocus = useRef(false);
  const history = useRef<string[]>([]);
  const browse = useRef<number | null>(null);
  const draining = useRef(false);
  const activeDraftScope = useRef(sessionId);
  const valueRef = useRef(value);
  const busy = streaming || stopping;
  const enabledSkills = useMemo(
    () => skills.filter((skill) => skill.enabled).sort((left, right) => left.name.localeCompare(right.name)),
    [skills],
  );

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const updateDraft = useCallback((text: string, nextAttachments?: ComposerAttachment[]) => {
    valueRef.current = text;
    setValue(text);
    if (nextAttachments) {
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
    }
    stashSessionDraft(activeDraftScope.current, text, attachmentsRef.current);
  }, []);

  const revokePreview = (item: ComposerAttachment) => {
    if (item.previewUrl?.startsWith("blob:")) {
      try { URL.revokeObjectURL(item.previewUrl); } catch { /* ignore */ }
    }
  };

  const addImageFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    const remaining = Math.max(0, 6 - attachmentsRef.current.filter((a) => a.kind === "image").length);
    const slice = images.slice(0, remaining);
    const next: ComposerAttachment[] = [...attachmentsRef.current];
    for (const file of slice) {
      if (file.size > 4 * 1024 * 1024) continue;
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (!dataBase64) continue;
      const mediaType = file.type === "image/jpg" ? "image/jpeg" : (file.type || "image/png");
      next.push({
        id: `img-${globalThis.crypto.randomUUID()}`,
        kind: "image",
        label: file.name || "image",
        mediaType,
        dataBase64,
        previewUrl: URL.createObjectURL(file),
        detail: `${Math.round(file.size / 1024)} KB`,
      });
    }
    updateDraft(valueRef.current, next);
  }, [updateDraft]);

  const removeAttachment = useCallback((id: string) => {
    const prev = attachmentsRef.current.find((a) => a.id === id);
    if (prev) revokePreview(prev);
    updateDraft(valueRef.current, attachmentsRef.current.filter((a) => a.id !== id));
  }, [updateDraft]);

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
    if (!skillsSelectable) setSelectedSkillIds([]);
  }, [skillsSelectable]);
  useEffect(() => {
    let active = true;
    void gateway.listSkills()
      .then((result) => { if (active) setSkills(result.skills); })
      .catch(() => { if (active) setSkills([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (activeDraftScope.current === sessionId) return;
    stashSessionDraft(activeDraftScope.current, valueRef.current, attachmentsRef.current);
    const restored = takeSessionDraft(sessionId);
    activeDraftScope.current = sessionId;
    valueRef.current = restored.text;
    setValue(restored.text);
    attachmentsRef.current = restored.attachments;
    setAttachments(restored.attachments);
    setExpanded(restored.text.includes("\n"));
    setSelectedSkillIds([]);
    browse.current = null;
  }, [sessionId]);
  useEffect(() => () => {
    stashSessionDraft(activeDraftScope.current, valueRef.current, attachmentsRef.current);
  }, []);
  useEffect(() => {
    const restoreDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown; focus?: boolean }>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      updateDraft(text);
      setExpanded(text.includes("\n"));
      browse.current = null;
      window.requestAnimationFrame(() => {
        const input = ref.current;
        if (!input) return;
        const end = text.length;
        input.setSelectionRange(end, end);
        if (detail?.focus !== false) input.focus();
      });
    };
    window.addEventListener("kyrei:set-composer-draft", restoreDraft);
    return () => window.removeEventListener("kyrei:set-composer-draft", restoreDraft);
  }, [updateDraft]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cap = expanded ? Math.round(window.innerHeight * 0.55) : 220;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [value, expanded]);

  // Electron can temporarily hand focus to a native surface during a renderer
  // update. Keep an already active composer active when the window returns,
  // without taking focus from Settings or another modal.
  useEffect(() => {
    const rememberComposerFocus = () => {
      restoreComposerFocus.current = document.activeElement === ref.current;
    };
    const restoreAfterWindowFocus = () => {
      window.requestAnimationFrame(() => {
        const input = ref.current;
        const shell = document.querySelector<HTMLElement>(".app-shell");
        if (input && shouldRestoreComposerFocus({
          hadComposerFocus: restoreComposerFocus.current,
          disabled: Boolean(disabled),
          documentHasFocus: document.hasFocus(),
          shellIsInert: shell?.hasAttribute("inert") ?? false,
        })) {
          input.focus({ preventScroll: true });
        }
        restoreComposerFocus.current = false;
      });
    };
    window.addEventListener("blur", rememberComposerFocus);
    window.addEventListener("focus", restoreAfterWindowFocus);
    return () => {
      window.removeEventListener("blur", rememberComposerFocus);
      window.removeEventListener("focus", restoreAfterWindowFocus);
    };
  }, [disabled]);

  // Auto-drain the queue one prompt at a time whenever the session goes idle.
  useEffect(() => {
    if (busy || !sessionId || queued.length === 0 || draining.current) return;
    draining.current = true;
    const head = dequeueQueuedPrompt(sessionId);
    draining.current = false;
    if (head) {
      const images = head.attachments
        ?.filter((a) => a.kind === "image" && a.dataBase64 && a.mediaType)
        .map((a) => ({ name: a.label, mediaType: a.mediaType!, data: a.dataBase64! }));
      onSend(head.text, head.skillIds, images?.length ? images : undefined);
    }
  }, [busy, sessionId, queued.length, onSend]);

  const submit = () => {
    const text = value.trim();
    const imagePayload = attachmentsRef.current
      .filter((a) => a.kind === "image" && a.dataBase64 && a.mediaType)
      .map((a) => ({
        name: a.label,
        mediaType: a.mediaType!,
        data: a.dataBase64!,
      }));
    if (!text && !imagePayload.length) return;
    // Slash commands dispatch locally (text only).
    if (text.startsWith("/") && !imagePayload.length) {
      const { name, arg } = parseSlash(text);
      const command = resolveSlashCommand(name);
      if (command) {
        onCommand(command.id, arg || undefined);
        updateDraft("", []);
        return;
      }
    }
    if (busy) {
      // Busy → queue for the next turn instead of dropping the message.
      if (sessionId) {
        enqueueQueuedPrompt(sessionId, {
          text,
          attachments: attachmentsRef.current,
          skillIds: selectedSkillIds,
        });
      }
      for (const a of attachmentsRef.current) revokePreview(a);
      updateDraft("", []);
      setSelectedSkillIds([]);
      return;
    }
    if (text && history.current[history.current.length - 1] !== text) history.current.push(text);
    browse.current = null;
    onSend(text, selectedSkillIds, imagePayload.length ? imagePayload : undefined);
    for (const a of attachmentsRef.current) revokePreview(a);
    updateDraft("", []);
    setSelectedSkillIds([]);
  };
  const toggleSkill = (id: string) => {
    setSelectedSkillIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : current.length >= MAX_SELECTED_SKILLS ? current : [...current, id]);
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
          updateDraft(dictationBase.current);
        } else {
          updateDraft(dictationBase.current + transcript);
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
    updateDraft(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      const pos = next.length;
      try { el?.setSelectionRange(pos, pos); } catch { /* ignore */ }
    });
  };

  // Native OS file/folder/image picker → paths for files/folders; real image chips for images.
  const openPicker = (opts: { accept?: string; dir?: boolean; images?: boolean } = {}) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (opts.accept) input.accept = opts.accept;
    if (opts.dir) (input as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      if (opts.images || opts.accept?.includes("image")) {
        void addImageFiles(files);
        return;
      }
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
      const imageFiles: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        imageFiles.push(new File([blob], `clipboard.${type.split("/")[1] || "png"}`, { type }));
      }
      if (imageFiles.length) void addImageFiles(imageFiles);
    } catch { /* denied */ }
  };

  // Inline paste: keep text paste native; attach image files as chips.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const hasText = items.some((item) => item.kind === "string");
    const imageFiles = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (imageFiles.length && !hasText) {
      event.preventDefault();
      void addImageFiles(imageFiles);
    }
  };

  // Inline drop: attach images as chips; never navigate the window.
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    void addImageFiles(images);
  };

  const saveSnippet = () => {
    const text = value.trim();
    if (!text) return;
    const title = window.prompt(t("chat.snippets.namePrompt"), text.slice(0, 32)) ?? "";
    addSnippet(title, text);
  };

  const sendControls = busy ? (
    <div className="composer-send-cluster">
      {(value.trim() || attachments.length > 0) && (
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
        disabled={stopping}
        className="grid size-8 place-items-center rounded-[8px] bg-danger text-white transition-colors hover:brightness-110"
        title={stopping ? t("chat.composer.stopping") : t("chat.composer.stop")}
        aria-label={stopping ? t("chat.composer.stopping") : t("chat.composer.stop")}
        aria-busy={stopping}
      >
        <Square size={13} fill="currentColor" />
      </button>
    </div>
  ) : (
    <div className="composer-send-cluster">
      <button
        onClick={submit}
        disabled={!value.trim() && attachments.length === 0}
        className="send-button grid size-8 place-items-center rounded-[8px] bg-foreground text-bg transition-all hover:-translate-y-px disabled:translate-y-0 disabled:opacity-30"
        title={t("chat.composer.send")}
        aria-label={t("chat.composer.send")}
      >
        <ArrowUp size={16} />
      </button>
    </div>
  );

  useEffect(() => subscribeComposerSkillSelection((skillId) => {
    setSelectedSkillIds((current) => current.includes(skillId) || current.length >= MAX_SELECTED_SKILLS
      ? current
      : [...current, skillId]);
    requestAnimationFrame(() => ref.current?.focus());
  }), []);

  const pickSuggestion = (index: number) => {
    const c = suggestions[index];
    if (!c) return;
    if (c.arg) {
      updateDraft(`/${c.name} `);
      ref.current?.focus();
    } else {
      onCommand(c.name);
      updateDraft("");
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
    updateDraft(next);
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
      if (e.key === "Tab") { e.preventDefault(); updateDraft(`/${suggestions[sel].name} `); return; }
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
      updateDraft(h[browse.current]);
    } else if (e.key === "ArrowDown" && browse.current !== null) {
      e.preventDefault();
      browse.current += 1;
      if (browse.current >= h.length) { browse.current = null; updateDraft(""); }
      else updateDraft(h[browse.current]);
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

        <div
          className="composer-card rounded-[10px] border border-border-soft px-2.5 py-2 transition-all focus-within:border-(--ui-composer-focus)"
          onPointerDownCapture={(event) => {
            if (disabled || (event.target as Element).closest("button, a, input, select, [role=button]")) return;
            window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
          }}
        >
          {attachments.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1.5">
              {attachments.map((item) => (
                <li
                  key={item.id}
                  className="flex max-w-full items-center gap-1.5 rounded-md border border-border-soft bg-elevated/50 py-0.5 pl-1 pr-1"
                >
                  {item.kind === "image" && item.previewUrl ? (
                    <img src={item.previewUrl} alt="" className="size-7 rounded object-cover" />
                  ) : (
                    <ImageIcon className="size-3.5 text-muted" />
                  )}
                  <span className="min-w-0 max-w-[10rem] truncate text-[11px] text-secondary">{item.label}</span>
                  <button
                    type="button"
                    className="grid size-5 place-items-center rounded text-muted hover:bg-(--ui-row-hover) hover:text-foreground"
                    onClick={() => removeAttachment(item.id)}
                    aria-label={t("chat.composer.removeAttachment")}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            data-composer-input
            onChange={(e) => {
              updateDraft(e.target.value);
              browse.current = null;
              refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDrop={onDrop}
            onBlur={() => window.setTimeout(() => setMention(null), 120)}
            placeholder={disabled ? t("chat.composer.connecting") : t("chat.composer.placeholder")}
            className={cn(
              "w-full resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted",
              expanded ? "min-h-[40vh] max-h-[55vh]" : "min-h-[24px] max-h-[220px]",
            )}
          />
          <div className="composer-footer">
            <div className="composer-footer-tools">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="composer-tool composer-context-trigger grid size-7 place-items-center rounded-md text-muted transition-colors hover:text-foreground data-[state=open]:bg-(--ui-row-active) data-[state=open]:text-foreground"
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
                  <DropdownMenuItem className={dropdownMenuRow} onSelect={(e) => { e.preventDefault(); openPicker({ accept: "image/*", images: true }); }}>
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
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className={dropdownMenuRow}>
                      <Puzzle size={15} /> {t("chat.composer.skills.menu")}
                      {selectedSkillIds.length > 0 && (
                        <span className="ml-auto rounded bg-(--ui-row-active) px-1.5 py-0.5 text-[10px] tabular-nums text-secondary">
                          {selectedSkillIds.length}
                        </span>
                      )}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-72">
                      {!skillsSelectable ? (
                        <div className="px-2 py-1.5 text-[12px] leading-snug text-muted">
                          {t("chat.composer.skills.teamManaged")}
                        </div>
                      ) : enabledSkills.length === 0 ? (
                        <div className="px-2 py-1.5 text-[12px] leading-snug text-muted">
                          {t("chat.composer.skills.empty")}
                        </div>
                      ) : (
                        enabledSkills.map((skill) => {
                          const selected = selectedSkillIds.includes(skill.id);
                          return (
                            <DropdownMenuItem
                              key={skill.id}
                              className={dropdownMenuRow}
                              disabled={!selected && selectedSkillIds.length >= MAX_SELECTED_SKILLS}
                              onSelect={(event) => { event.preventDefault(); toggleSkill(skill.id); }}
                            >
                              <Check size={14} className={cn("shrink-0", selected ? "opacity-100 text-primary" : "opacity-0")} />
                              <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                              {skill.description && <span className="max-w-28 truncate text-[10px] text-muted">{skill.description}</span>}
                            </DropdownMenuItem>
                          );
                        })
                      )}
                      {skillsSelectable && enabledSkills.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <div className="px-2 py-1.5 text-[11px] leading-snug text-muted">
                            {t("chat.composer.skills.hint")}
                          </div>
                        </>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {selectedSkillIds.length > 0 && (
                    <DropdownMenuItem className={cn(dropdownMenuRow, "text-muted")} onSelect={() => setSelectedSkillIds([])}>
                      <X size={14} /> {t("chat.composer.skills.clear")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-[11px] leading-snug text-muted">
                    {t("chat.composer.contextHint")}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
              {selectedSkillIds.length > 0 && (
                <button
                  onClick={() => setSelectedSkillIds([])}
                  className="flex h-7 items-center gap-1 rounded-md bg-(--ui-row-active) px-1.5 text-[11px] text-secondary transition-colors hover:text-foreground"
                  title={t("chat.composer.skills.clear")}
                  aria-label={t("chat.composer.skills.clear")}
                >
                  <Puzzle size={13} /> <span className="tabular-nums">{selectedSkillIds.length}</span>
                </button>
              )}
              <ModelPill disabled={disabled} model={model} provider={provider} providers={providers} onModelChange={onModelChange} />
              {onCodingModeChange && (
                <ModePill
                  mode={codingMode}
                  disabled={disabled}
                  onChange={onCodingModeChange}
                />
              )}
              {onExecutionModeChange && (
                <button
                  type="button"
                  onClick={() => onExecutionModeChange(executionMode === "autopilot" ? "supervised" : "autopilot")}
                  className={cn(
                    "grid size-7 place-items-center rounded-md transition-colors",
                    executionMode === "autopilot"
                      ? "bg-primary/15 text-primary"
                      : "bg-(--ui-row-active) text-foreground",
                  )}
                  title={
                    executionMode === "autopilot"
                      ? t("chat.composer.autopilotOn")
                      : t("chat.composer.supervisedOn")
                  }
                  aria-label={
                    executionMode === "autopilot"
                      ? t("chat.composer.autopilotOn")
                      : t("chat.composer.supervisedOn")
                  }
                  aria-pressed={executionMode === "autopilot"}
                >
                  {executionMode === "autopilot" ? <Bot size={14} /> : <ShieldCheck size={14} />}
                </button>
              )}
              {onViewChanges && (
                <button
                  type="button"
                  onClick={onViewChanges}
                  disabled={disabled}
                  className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-(--ui-row-hover) hover:text-foreground disabled:opacity-40"
                  title={t("chat.composer.viewChanges")}
                  aria-label={t("chat.composer.viewChanges")}
                >
                  <History size={14} />
                </button>
              )}
              <button
                onClick={() => setExpanded((v) => !v)}
                className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-(--ui-row-hover) hover:text-foreground"
                title={expanded ? t("chat.composer.collapse") : t("chat.composer.expand")}
                aria-label={expanded ? t("chat.composer.collapse") : t("chat.composer.expand")}
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
            <div className="composer-footer-actions">
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
              {sendControls}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
