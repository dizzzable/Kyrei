/**
 * Prompt snippets — small reusable prompt texts the user can insert into the
 * composer. Local-first (localStorage), no backend. Mirrors the Hermes
 * composer "Prompt snippets…" attach entry.
 */

import { persistentJsonAtom, useAtom } from "@/store/atom";
import type { ChatTranslator } from "@/lib/slash-commands";

export interface PromptSnippet {
  id: string;
  title: string;
  text: string;
  builtIn?: boolean;
}

const STORAGE_KEY = "kyrei.prompt-snippets.v1";

const BUILT_INS = [
  { id: "explain", titleKey: "chat.snippets.explain.title", textKey: "chat.snippets.explain.text" },
  { id: "review", titleKey: "chat.snippets.review.title", textKey: "chat.snippets.review.text" },
  { id: "tests", titleKey: "chat.snippets.tests.title", textKey: "chat.snippets.tests.text" },
  { id: "refactor", titleKey: "chat.snippets.refactor.title", textKey: "chat.snippets.refactor.text" },
] as const;

const LEGACY_BUILT_IN_IDS = new Set<string>(BUILT_INS.map((snippet) => snippet.id));

export function getBuiltInSnippets(t: ChatTranslator): PromptSnippet[] {
  return BUILT_INS.map((snippet) => ({
    id: `builtin:${snippet.id}`,
    title: t(snippet.titleKey),
    text: t(snippet.textKey),
    builtIn: true,
  }));
}

export function resolveSnippets(userSnippets: readonly PromptSnippet[], t: ChatTranslator): PromptSnippet[] {
  return [...getBuiltInSnippets(t), ...userSnippets];
}

export const $snippets = persistentJsonAtom<PromptSnippet[]>(STORAGE_KEY, []);

// v1 seeded Russian built-ins into storage. Drop only those known ids; custom
// `s-*` entries stay byte-for-byte unchanged and built-ins now follow locale.
const stored = $snippets.get();
const migrated = stored.filter((snippet) => !LEGACY_BUILT_IN_IDS.has(snippet.id));
if (migrated.length !== stored.length) $snippets.set(migrated);

export function useSnippets(t: ChatTranslator): PromptSnippet[] {
  const userSnippets = useAtom($snippets);
  return resolveSnippets(userSnippets, t);
}

export function addSnippet(title: string, text: string): void {
  const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  $snippets.set([...$snippets.get(), { id, title: title.trim() || text.slice(0, 24), text }]);
}

export function removeSnippet(id: string): void {
  $snippets.set($snippets.get().filter((s) => s.id !== id));
}
