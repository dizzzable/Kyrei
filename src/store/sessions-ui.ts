/** Client-side session UI state: pinned session ids (persisted). */

import { persistentJsonAtom, useAtom } from "@/store/atom";

const STORAGE_KEY = "kyrei.pinned-sessions.v1";

export const $pinnedIds = persistentJsonAtom<string[]>(STORAGE_KEY, []);

export function isPinned(id: string): boolean {
  return $pinnedIds.get().includes(id);
}

export function togglePinned(id: string): void {
  const cur = $pinnedIds.get();
  $pinnedIds.set(cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur]);
}

export function unpin(id: string): void {
  $pinnedIds.set($pinnedIds.get().filter((x) => x !== id));
}

/** Reactive pinned-id set for components. */
export function usePinnedIds(): string[] {
  return useAtom($pinnedIds);
}
