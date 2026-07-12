/**
 * Composer draft state + per-session draft stash (ported from Hermes composer).
 *
 * Two concerns live here:
 *   1. The live composer atoms (`$composerDraft`, `$composerAttachments`) that
 *      the ChatBar binds to for the currently focused scope.
 *   2. A per-session draft stash so switching sessions parks the in-progress
 *      text/attachments and restores them on return. Text mirrors to
 *      localStorage (MRU 50); attachments are memory-only (blobs / preview
 *      URLs must not outlive the tab).
 *
 * Storage is best-effort via `@/lib/persist` helpers, which guard access so the
 * stash still works in-memory when localStorage is unavailable (tests, private
 * mode, quota).
 */

import { getStored, removeStored, setStored } from "@/lib/persist";
import { atom } from "@/store/atom";

/** A chip attached to a composer prompt (image/file/folder reference, url, …). */
export interface ComposerAttachment {
  id: string;
  kind: "image" | "file" | "folder" | "url" | "terminal";
  label: string;
  detail?: string;
  refText?: string;
  previewUrl?: string;
  path?: string;
}

/** A parked composer state for one session scope. */
export interface SessionDraft {
  attachments: ComposerAttachment[];
  text: string;
}

/** Live composer draft text for the focused scope. */
export const $composerDraft = atom("");

/** Live composer attachments for the focused scope. */
export const $composerAttachments = atom<ComposerAttachment[]>([]);

// Per-session draft stash. Session lifecycle never touches this — only the
// ChatBar's scope swap reads/writes it. Text mirrors to localStorage;
// attachments are memory-only (blobs, preview URLs).
export const SESSION_DRAFTS_STORAGE_KEY = "kyrei.composer.drafts.v3";

const NEW_SESSION_DRAFT_KEY = "__new__";
const MAX_PERSISTED_DRAFTS = 50;
const EMPTY_SESSION_DRAFT: SessionDraft = { attachments: [], text: "" };

const draftKey = (scope: string | null | undefined) => scope?.trim() || NEW_SESSION_DRAFT_KEY;

const cloneDraft = (draft: SessionDraft): SessionDraft => ({
  attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  text: draft.text,
});

function loadPersistedDraftTexts(): [string, SessionDraft][] {
  try {
    const raw = getStored(SESSION_DRAFTS_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    return Object.entries(JSON.parse(raw) as Record<string, string>).map(([key, text]) => [
      key,
      { attachments: [], text },
    ]);
  } catch {
    return [];
  }
}

const draftsBySession = new Map<string, SessionDraft>(loadPersistedDraftTexts());

function persistDraftTexts() {
  try {
    const entries = [...draftsBySession]
      .filter(([, draft]) => draft.text)
      .slice(-MAX_PERSISTED_DRAFTS)
      .map(([key, draft]) => [key, draft.text] as const);

    if (entries.length === 0) {
      removeStored(SESSION_DRAFTS_STORAGE_KEY);
    } else {
      setStored(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    }
  } catch {
    // Best-effort only — quota / private-mode must never break typing.
  }
}

/** Park the draft for a scope. Empty drafts are dropped so they don't linger. */
export function stashSessionDraft(
  scope: string | null | undefined,
  text: string,
  attachments: ComposerAttachment[],
) {
  const key = draftKey(scope);

  // Delete-then-set keeps MRU order for MAX_PERSISTED_DRAFTS eviction.
  draftsBySession.delete(key);

  if (text.trim() || attachments.length > 0) {
    draftsBySession.set(key, cloneDraft({ attachments, text }));
  }

  persistDraftTexts();
}

/** Restore a parked draft for a scope (empty draft when none is stashed). */
export function takeSessionDraft(scope: string | null | undefined): SessionDraft {
  const stashed = draftsBySession.get(draftKey(scope));

  return stashed ? cloneDraft(stashed) : EMPTY_SESSION_DRAFT;
}

/** Drop any parked draft for a scope. */
export const clearSessionDraft = (scope: string | null | undefined) => stashSessionDraft(scope, "", []);
