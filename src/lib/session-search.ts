import { normalize } from "@/lib/text";
import type { SessionInfo } from "@/lib/types";

/** Human-readable session title, falling back to a stable placeholder.
 *  Adapted from Hermes' `sessionTitle`, simplified to our fields. */
export function sessionTitle(session: SessionInfo): string {
  const title = session.title?.trim();
  return title ? title : "Untitled";
}

/**
 * True when `session` matches `query`.
 *
 * Matching is case-insensitive and word-based (AND): every whitespace-separated
 * word in the query must appear in at least one of the searchable fields
 * (session id or title). An empty/whitespace-only query matches everything.
 *
 * Adapted from Hermes' `sessionMatchesSearch`, reduced to our `SessionInfo`.
 */
export function sessionMatchesSearch(session: SessionInfo, query: string): boolean {
  const needle = normalize(query);
  if (!needle) {
    return true;
  }

  const haystack = [session.id, sessionTitle(session)]
    .map(value => value.toLowerCase())
    .join("\n");

  const words = needle.split(/\s+/).filter(Boolean);
  return words.every(word => haystack.includes(word));
}
