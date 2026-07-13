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
import { resetUiSettings, setUiSetting } from "@/store/settings";
import { clearQueuedPrompts, enqueueQueuedPrompt } from "@/store/composer-queue";

function renderComposer(options: { sessionId?: string; streaming?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(Composer, {
        streaming: options.streaming ?? false,
        sessionId: options.sessionId,
        model: "openai/gpt-5",
        provider: "openai",
        onSend: vi.fn(),
        onStop: vi.fn(),
        onCommand: vi.fn(),
        onModelChange: vi.fn(),
      }),
    ),
  );
}

describe("Composer localized interaction chrome", () => {
  it("renders translated controls in Hermes order", () => {
    setLang("en");
    resetUiSettings();
    setUiSetting("voiceInput", true);
    setUiSetting("autoSpeak", false);
    const html = renderComposer();

    expect(html).toContain('placeholder="Message Kyrei…"');
    expect(html).toContain('aria-label="Add context"');
    expect(html).toContain('title="Start voice dictation"');
    expect(html).toContain('title="Enable spoken replies"');
    expect(html).toContain('title="Send"');
    expect(html.indexOf('aria-label="Add context"')).toBeLessThan(html.indexOf("GPT-5"));
    expect(html.indexOf("GPT-5")).toBeLessThan(html.indexOf('title="Start voice dictation"'));
    expect(html.indexOf('title="Start voice dictation"')).toBeLessThan(html.indexOf('title="Enable spoken replies"'));
    expect(html.indexOf('title="Enable spoken replies"')).toBeLessThan(html.indexOf('title="Send"'));
  });

  it("switches every visible control to Russian", () => {
    setLang("ru");
    resetUiSettings();
    setUiSetting("voiceInput", true);

    const html = renderComposer();

    expect(html).toContain('placeholder="Сообщение для Kyrei…"');
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
});
