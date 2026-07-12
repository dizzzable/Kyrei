/**
 * Prompt snippets — small reusable prompt texts the user can insert into the
 * composer. Local-first (localStorage), no backend. Mirrors the Hermes
 * composer "Prompt snippets…" attach entry.
 */

import { persistentJsonAtom, useAtom } from "@/store/atom";

export interface PromptSnippet {
  id: string;
  title: string;
  text: string;
}

const STORAGE_KEY = "kyrei.prompt-snippets.v1";

const SEED: PromptSnippet[] = [
  { id: "explain", title: "Объяснить код", text: "Объясни, что делает этот код и как он работает: " },
  { id: "review", title: "Ревью изменений", text: "Проверь мои последние изменения на баги, стиль и безопасность." },
  { id: "tests", title: "Написать тесты", text: "Напиши модульные тесты для " },
  { id: "refactor", title: "Рефакторинг", text: "Отрефактори этот код, сохранив поведение: " },
];

export const $snippets = persistentJsonAtom<PromptSnippet[]>(STORAGE_KEY, SEED);

export function useSnippets(): PromptSnippet[] {
  return useAtom($snippets);
}

export function addSnippet(title: string, text: string): void {
  const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  $snippets.set([...$snippets.get(), { id, title: title.trim() || text.slice(0, 24), text }]);
}

export function removeSnippet(id: string): void {
  $snippets.set($snippets.get().filter((s) => s.id !== id));
}
