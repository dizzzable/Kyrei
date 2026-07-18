import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/speech", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/speech")>()),
  isSpeechRecognitionSupported: () => true,
  isSpeechSynthesisSupported: () => true,
}));

import { Composer } from "@/components/Composer";
import { I18nProvider, setLang } from "@/i18n";
import { clearQueuedPrompts, enqueueQueuedPrompt } from "@/store/composer-queue";
import { resetUiSettings, setUiSetting } from "@/store/settings";

function renderComposer(options: { sessionId?: string; streaming?: boolean; stopping?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(Composer, {
        streaming: options.streaming ?? false,
        stopping: options.stopping ?? false,
        sessionId: options.sessionId,
        model: "openai/gpt-5",
        provider: "openai",
        onSend: vi.fn(),
        onStop: vi.fn(),
        onCommand: vi.fn(),
        onModelChange: vi.fn(),
        onCodingModeChange: vi.fn(),
        onExecutionModeChange: vi.fn(),
        onViewChanges: vi.fn(),
      }),
    ),
  );
}

describe("Composer localized interaction chrome", () => {
  it("keeps tool controls before a fixed right-side speech/send action cluster", () => {
    setLang("en");
    resetUiSettings();
    setUiSetting("voiceInput", true);
    setUiSetting("autoSpeak", false);
    const html = renderComposer();

    expect(html).toContain("composer-footer");
    expect(html).toContain("composer-footer-tools");
    expect(html).toContain("composer-footer-actions");
    expect(html.indexOf("composer-footer-tools")).toBeLessThan(html.indexOf("composer-footer-actions"));
    expect(html).toMatch(/composer-footer-actions[^>]*>[\s\S]*title="Start voice dictation"[\s\S]*title="Send"/);
    expect(html).toContain('aria-label="Add context"');
    expect(html).toContain('title="Enable spoken replies"');
    expect(html).toContain('title="Start voice dictation"');
    expect(html).toContain('title="Autopilot on — file edits apply immediately (click for Supervised)"');
    expect(html).toContain('title="View all changes / Revert all"');
    expect(html).toContain('title="Expand editor"');
    expect(html).toContain('title="Send"');
    expect(html).toContain("GPT-5");
    expect(html).toContain(">Auto<");
  });

  it("switches every visible control to Russian", () => {
    setLang("ru");
    resetUiSettings();
    setUiSetting("voiceInput", true);

    const html = renderComposer();

    expect(html).toContain('aria-label="Добавить контекст"');
    expect(html).toContain('title="Начать голосовой ввод"');
    expect(html).toContain('title="Включить озвучивание ответов"');
    expect(html).toContain('title="Отправить"');
    expect(html).not.toContain('title="Send"');
  });

  it("bounds a large queued-prompt list inside the composer", () => {
    const sessionId = "queue-viewport-test";
    clearQueuedPrompts(sessionId);
    for (let index = 0; index < 12; index += 1) {
      enqueueQueuedPrompt(sessionId, { text: `queued-${index}`, attachments: [] });
    }

    const html = renderComposer({ sessionId, streaming: true });

    expect(html).toContain("composer-queue-list");
    expect(html).toContain("max-h-[min(14rem,30vh)]");
    expect(html).toContain("queued-11");
    clearQueuedPrompts(sessionId);
  });

  it("keeps the stop control visible and disabled while cancellation is pending", () => {
    setLang("en");
    const html = renderComposer({ streaming: true, stopping: true });

    expect(html).toContain('aria-label="Stopping…"');
    expect(html).toContain("disabled");
    expect(html).not.toContain('title="Send"');
  });
});
