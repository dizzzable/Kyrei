/**
 * Local-first UI preferences (Wave 7). Everything here is client-side and
 * mirrored to localStorage — no telemetry, no network. Engine-facing settings
 * (provider/model/workspace/engine tuning) live on the gateway config instead.
 */

import { persistentJsonAtom, useAtom } from "@/store/atom";

export type ToolViewMode = "compact" | "technical";
export type UiDensity = "comfortable" | "compact";
export type ChatBackgroundMode = "follow-theme" | "peonies";

export interface UiSettings {
  /** Root font scale (0.85–1.3). Applied to <html> as a CSS var. */
  scale: number;
  /** Default expansion detail for tool rows. */
  toolView: ToolViewMode;
  /** Layout density. */
  density: UiDensity;
  /** Conversation surface background treatment. */
  chatBackground: ChatBackgroundMode;
  /** Show/hide model reasoning blocks in assistant messages. */
  showReasoning: boolean;
  /** Master switch for all notifications. */
  notify: boolean;
  /** Play a sound when a turn finishes. */
  notifySound: boolean;
  /** Show a native OS notification when a turn finishes and window is hidden. */
  notifyNative: boolean;
  /** Send message on Enter (Shift+Enter for newline) vs. Cmd/Ctrl+Enter. */
  sendOnEnter: boolean;
  /** Render markdown/code with syntax highlighting. */
  richRendering: boolean;
  /** Enable the composer microphone (dictation via Web Speech API). */
  voiceInput: boolean;
  /** Read assistant replies aloud when a turn completes (TTS). */
  autoSpeak: boolean;
  /** BCP-47 language tag for speech (empty = system default). */
  voiceLang: string;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  scale: 1,
  toolView: "compact",
  density: "comfortable",
  chatBackground: "follow-theme",
  showReasoning: true,
  notify: true,
  notifySound: true,
  notifyNative: false,
  sendOnEnter: true,
  richRendering: true,
  voiceInput: false,
  autoSpeak: false,
  voiceLang: "",
};

const STORAGE_KEY = "kyrei.ui-settings.v1";

export const $uiSettings = persistentJsonAtom<UiSettings>(STORAGE_KEY, DEFAULT_UI_SETTINGS);

export function getUiSettings(): UiSettings {
  return { ...DEFAULT_UI_SETTINGS, ...$uiSettings.get() };
}

export function setUiSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void {
  $uiSettings.set({ ...getUiSettings(), [key]: value });
}

export function resetUiSettings(): void {
  $uiSettings.set({ ...DEFAULT_UI_SETTINGS });
}

/** React hook returning the fully-defaulted settings object. */
export function useUiSettings(): UiSettings {
  return useAtom($uiSettings, (v) => ({ ...DEFAULT_UI_SETTINGS, ...v }));
}

/** Push the root scale onto <html> (called on boot and on change). */
export function applyScale(scale: number): void {
  const clamped = Math.min(1.3, Math.max(0.85, scale || 1));
  document.documentElement.style.setProperty("--ui-scale", String(clamped));
  document.documentElement.style.fontSize = `${clamped * 100}%`;
}

/** Best-effort completion feedback honoring the notification prefs. */
export function notifyTurnComplete(title: string): void {
  const s = getUiSettings();
  if (!s.notify) return;
  if (s.notifySound) playChime();
  if (s.notifyNative && typeof Notification !== "undefined" && document.hidden) {
    try {
      if (Notification.permission === "granted") new Notification(title);
      else if (Notification.permission !== "denied") {
        void Notification.requestPermission().then((p) => {
          if (p === "granted") new Notification(title);
        });
      }
    } catch {
      /* notifications unavailable */
    }
  }
}

/** A short two-note chime synthesized locally via WebAudio (no asset file). */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    /* audio blocked */
  }
}
