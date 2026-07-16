import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { detectImportFormat } from "./detect.js";
import { contentDigest } from "./digest.js";
import { ImportError } from "./errors.js";
import { orchestrateImport } from "./orchestrate.js";
import { redactImportedText, redactTranscript } from "./redact.js";
import { IMPORT_ADAPTERS, getAdapterById } from "./adapters/registry.js";
import type { ImportRawInput } from "./types.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/fixtures/session-import",
);

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fixture(name: string): ImportRawInput {
  const path = join(fixtureRoot, name);
  const buf = readFileSync(path);
  return {
    fileName: name,
    bytes: new Uint8Array(buf),
    text: buf.toString("utf8"),
  };
}

describe("session import pipeline", () => {
  it("redacts secrets and counts replacements", () => {
    const { text, replacementCount } = redactImportedText(
      "token sk-thisisafakesecretkey1234567890 and Bearer abcdefghijklmnop",
    );
    expect(text).toContain("[REDACTED]");
    expect(replacementCount).toBeGreaterThanOrEqual(2);
  });

  it("detects each Phase B fixture", () => {
    expect(detectImportFormat(fixture("kyrei-export.min.json")).adapterId).toBe("kyrei-export");
    expect(detectImportFormat(fixture("opencode-export.min.json")).adapterId).toBe("opencode-json");
    expect(detectImportFormat(fixture("claude-code.sample.jsonl")).adapterId).toBe("claude-code-jsonl");
    const md = detectImportFormat(fixture("claude-code.export.md"));
    expect(["claude-code-md", "generic-md"]).toContain(md.adapterId);
    expect(detectImportFormat(fixture("generic.sample.md")).adapterId).toMatch(/md$/);
  });

  it("parses all adapters into non-empty transcripts", () => {
    const cases: Array<[string, string]> = [
      ["kyrei-export", "kyrei-export.min.json"],
      ["opencode-json", "opencode-export.min.json"],
      ["claude-code-jsonl", "claude-code.sample.jsonl"],
      ["claude-code-md", "claude-code.export.md"],
      ["generic-md", "generic.sample.md"],
    ];
    for (const [adapterId, name] of cases) {
      const raw = fixture(name);
      const adapter = getAdapterById(adapterId)!;
      const transcript = adapter.parse(raw);
      expect(transcript.messages.length).toBeGreaterThan(0);
      expect(transcript.schemaVersion).toBe(1);
    }
  });

  it("redacts sk- keys in claude md fixture before digest", () => {
    const adapter = getAdapterById("claude-code-md")!;
    const raw = fixture("claude-code.export.md");
    const transcript = adapter.parse(raw);
    const { transcript: redacted, redactionCount } = redactTranscript(transcript);
    expect(redactionCount).toBeGreaterThan(0);
    expect(redacted.messages.some((m) => m.text.includes("sk-"))).toBe(false);
    expect(contentDigest(redacted)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("orchestrates handoff write and dedupe", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-import-"));
    workspaces.push(workspace);
    await mkdir(join(workspace, ".kyrei"), { recursive: true });

    const raw = fixture("kyrei-export.min.json");
    const first = await orchestrateImport(raw, {
      workspace,
      createSession: false,
      writeLtm: false,
    });
    expect(first.report.handoffPath).toBeTruthy();
    const handoffBody = await readFile(first.report.handoffPath!, "utf8");
    expect(handoffBody).toContain("auth");
    expect(first.report.deduped).toBe(false);

    const second = await orchestrateImport(raw, {
      workspace,
      createSession: false,
      writeLtm: false,
      dedupe: true,
      dedupeMode: "skip",
    });
    expect(second.report.deduped).toBe(true);
    expect(second.report.contentDigest).toBe(first.report.contentDigest);
  });

  it("rejects empty transcripts", () => {
    const adapter = getAdapterById("kyrei-export")!;
    expect(() => adapter.parse({
      fileName: "empty.json",
      bytes: new TextEncoder().encode(JSON.stringify({
        exported_at: "2026-01-01T00:00:00.000Z",
        session_id: "x",
        messages: [],
      })),
    })).toThrow(ImportError);
  });

  it("lists registered adapters", () => {
    expect(IMPORT_ADAPTERS.map((a) => a.id)).toEqual([
      "kyrei-export",
      "opencode-json",
      "claude-code-jsonl",
      "claude-code-md",
      "generic-md",
    ]);
  });
});
