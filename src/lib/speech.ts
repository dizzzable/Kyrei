/**
 * Voice (Wave 5.3) — thin wrappers over the renderer-provided Web Speech API.
 *
 * Dictation uses SpeechRecognition (webkit-prefixed in Chromium/Electron);
 * Auto-speak uses speechSynthesis. Text is cleaned via `sanitizeTextForSpeech`
 * before TTS so markdown/code/emoji aren't read aloud. Both features degrade to
 * no-ops when the platform lacks support (checked by the `*Supported` guards).
 */

import { sanitizeTextForSpeech } from "@/lib/speech-text";

// ── Minimal Web Speech typings (not in the default DOM lib) ───────────────
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return recognitionCtor() !== null;
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export interface Recognizer {
  start(): void;
  stop(): void;
}

/**
 * Build a dictation session. `onResult` fires with the accumulated transcript
 * and whether the current chunk is final. `onEnd` fires when recognition stops
 * (manually or by silence). Returns null when unsupported.
 */
export function createRecognizer(opts: {
  lang?: string;
  onResult: (transcript: string, isFinal: boolean) => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}): Recognizer | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = opts.lang || (typeof navigator !== "undefined" ? navigator.language : "en-US") || "en-US";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e) => {
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0]?.transcript ?? "";
      if (res.isFinal) final += text;
      else interim += text;
    }
    if (final) opts.onResult(final, true);
    else if (interim) opts.onResult(interim, false);
  };
  rec.onerror = (e) => opts.onError?.(e.error ?? "speech-error");
  rec.onend = () => opts.onEnd?.();

  let running = false;
  return {
    start() {
      if (running) return;
      running = true;
      try {
        rec.start();
      } catch {
        running = false;
        opts.onError?.("start-failed");
      }
    },
    stop() {
      if (!running) return;
      running = false;
      try { rec.stop(); } catch { /* already stopped */ }
    },
  };
}

/** Speak text aloud (markdown/code stripped first). Cancels any prior speech. */
export function speak(text: string, opts: { lang?: string; rate?: number; pitch?: number } = {}): void {
  if (!isSpeechSynthesisSupported()) return;
  const clean = sanitizeTextForSpeech(text);
  if (!clean) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  if (opts.lang) u.lang = opts.lang;
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;
  synth.speak(u);
}

export function cancelSpeech(): void {
  if (isSpeechSynthesisSupported()) window.speechSynthesis.cancel();
}
