/**
 * Durable project memory writers with role-gated paths (Requirements §6.3).
 * Notes = scratch (main). MEMORY.md / GLOBAL.md = durable canon (writer role).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeMemory } from "../memory/writer.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

export interface MemoryWriteToolOptions {
  workspace: string;
  /** User-global memory dir (…/kyrei/memory). Enables GLOBAL.md writes. */
  globalDir?: string;
  maxModelOutputChars?: number;
  onMemoryMutated?: () => void;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [обрезано]`;
}

async function readIf(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export function buildMemoryWriteTools(options: MemoryWriteToolOptions): ToolSet {
  const max = options.maxModelOutputChars ?? 12_000;
  const notesPath = join(options.workspace, ".kyrei", "memory", "notes.md");
  const memoryPath = join(options.workspace, ".kyrei", "memory", "MEMORY.md");
  const globalPath = options.globalDir ? join(options.globalDir, "GLOBAL.md") : null;

  return {
    memory_write_notes: tool({
      description: TOOL_DESCRIPTIONS.memory_write_notes,
      inputSchema: z.object({
        content: z.string().min(1).max(100_000).describe("Full replacement content for notes.md (scratch pad)."),
        mode: z.enum(["replace", "append"]).optional().describe("replace (default) or append with a blank line."),
      }),
      execute: async ({ content, mode }) => {
        try {
          let body = content;
          if (mode === "append") {
            const prev = await readIf(notesPath);
            body = prev.trim() ? `${prev.trimEnd()}\n\n${content}` : content;
          }
          await writeMemory("main", notesPath, body.endsWith("\n") ? body : `${body}\n`);
          options.onMemoryMutated?.();
          return `Wrote .kyrei/memory/notes.md (${body.length} chars). Scratch pad only — not project policy.`;
        } catch (error) {
          return `memory_write_notes failed: ${(error as Error).message}`;
        }
      },
    }),

    memory_write_project: tool({
      description: TOOL_DESCRIPTIONS.memory_write_project,
      inputSchema: z.object({
        content: z.string().min(1).max(100_000).describe("Full content for MEMORY.md (durable project facts)."),
        mode: z.enum(["replace", "append"]).optional().describe("replace (default) or append."),
      }),
      execute: async ({ content, mode }) => {
        try {
          let body = content;
          if (mode === "append") {
            const prev = await readIf(memoryPath);
            body = prev.trim() ? `${prev.trimEnd()}\n\n${content}` : content;
          }
          // Writer role owns structural MEMORY.md (single-writer durable canon).
          await writeMemory("writer", memoryPath, body.endsWith("\n") ? body : `${body}\n`);
          options.onMemoryMutated?.();
          return clip(
            `Wrote .kyrei/memory/MEMORY.md (${body.length} chars). Durable project memory — not system policy overrides.`,
            max,
          );
        } catch (error) {
          return `memory_write_project failed: ${(error as Error).message}`;
        }
      },
    }),

    ...(globalPath
      ? {
          memory_write_global: tool({
            description: TOOL_DESCRIPTIONS.memory_write_global,
            inputSchema: z.object({
              content: z.string().min(1).max(50_000),
              mode: z.enum(["replace", "append"]).optional(),
            }),
            execute: async ({ content, mode }) => {
              try {
                let body = content;
                if (mode === "append") {
                  const prev = await readIf(globalPath);
                  body = prev.trim() ? `${prev.trimEnd()}\n\n${content}` : content;
                }
                await writeMemory("writer", globalPath, body.endsWith("\n") ? body : `${body}\n`);
                options.onMemoryMutated?.();
                return `Wrote GLOBAL.md (${body.length} chars). Cross-project preferences only.`;
              } catch (error) {
                return `memory_write_global failed: ${(error as Error).message}`;
              }
            },
          }),
        }
      : {}),
  };
}
