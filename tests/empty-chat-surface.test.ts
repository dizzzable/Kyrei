import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("empty conversation surface", () => {
  it("renders the timeline without onboarding content", async () => {
    const source = await readFile(resolve(process.cwd(), "src", "App.tsx"), "utf8");

    expect(source).toContain('className="conversation-scroll min-h-0 flex-1 overflow-y-auto"');
    expect(source).not.toContain("shell.empty.");
    expect(source).not.toContain("StarterPrompt");
  });

  it("keeps the floral background behind tinted glass layers", async () => {
    const stylesheet = await readFile(resolve(process.cwd(), "src", "index.css"), "utf8");

    expect(stylesheet).toContain('url("../assets/chat-peonies.webp")');
    expect(stylesheet).toContain("backdrop-filter: blur(0.625rem)");
    expect(stylesheet).toContain('[data-theme="light"] .conversation-shell::before');
  });
});
