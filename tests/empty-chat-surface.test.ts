import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("empty conversation surface", () => {
  it("renders the timeline without onboarding content", async () => {
    const source = await readFile(resolve(process.cwd(), "src", "App.tsx"), "utf8");

    expect(source).toContain('className="conversation-scroll min-h-0 flex-1 overflow-y-auto"');
    expect(source).toContain('data-chat-surface={ui.chatBackground}');
    expect(source).toContain('data-message-id={message.id}');
    expect(source).not.toContain("shell.empty.");
    expect(source).not.toContain("StarterPrompt");
  });

  it("supports follow-theme by default and keeps peonies as an opt-in surface", async () => {
    const stylesheet = await readFile(resolve(process.cwd(), "src", "index.css"), "utf8");

    expect(stylesheet).toContain('.conversation-shell[data-chat-surface="peonies"]::before');
    expect(stylesheet).toContain("color-mix(in srgb, var(--k-bg) 90%, #050608)");
    expect(stylesheet).toContain("backdrop-filter: blur(0.625rem)");
    expect(stylesheet).toContain(".conversation-jump-latest-button");
    expect(stylesheet).toContain('[data-theme="light"] .conversation-shell[data-chat-surface="peonies"]::before');
  });
});
