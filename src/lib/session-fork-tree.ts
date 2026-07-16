/**
 * Light fork tree ordering for the sidebar.
 * Nests `lineageKind: "branch"` children under a parent when the parent is
 * also present in the list; orphans stay roots.
 */

import type { SessionInfo } from "@/lib/types";

export interface SessionTreeRow {
  session: SessionInfo;
  /** 0 = root / orphan, 1+ = nested under a visible parent. */
  depth: number;
}

function updatedMs(session: SessionInfo): number {
  const raw = session.updatedAt || session.createdAt || "";
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : 0;
}

function sortByRecency(a: SessionInfo, b: SessionInfo): number {
  return updatedMs(b) - updatedMs(a) || a.id.localeCompare(b.id);
}

/**
 * Order sessions so forks appear under their parent (depth 1+), roots by recency.
 * Does not invent parents missing from `sessions`.
 */
export function orderSessionsWithForkTree(sessions: readonly SessionInfo[]): SessionTreeRow[] {
  const list = Array.isArray(sessions) ? [...sessions] : [];
  if (list.length === 0) return [];

  const byId = new Map(list.map((s) => [s.id, s]));
  /** parentId → children that are branches and whose parent is in the list */
  const children = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  const nestedIds = new Set<string>();

  for (const s of list) {
    const parentId = typeof s.parentSessionId === "string" ? s.parentSessionId : "";
    const isBranch = s.lineageKind === "branch" || Boolean(parentId);
    if (isBranch && parentId && byId.has(parentId) && parentId !== s.id) {
      const bucket = children.get(parentId) ?? [];
      bucket.push(s);
      children.set(parentId, bucket);
      nestedIds.add(s.id);
    } else {
      roots.push(s);
    }
  }

  // A session that is both a child and a root (shouldn't happen) — prefer nested only.
  const rootList = roots.filter((s) => !nestedIds.has(s.id));
  rootList.sort(sortByRecency);
  for (const [, kids] of children) kids.sort(sortByRecency);

  const out: SessionTreeRow[] = [];
  const visited = new Set<string>();

  const visit = (session: SessionInfo, depth: number) => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    out.push({ session, depth: Math.min(depth, 4) });
    const kids = children.get(session.id) ?? [];
    for (const child of kids) visit(child, depth + 1);
  };

  for (const root of rootList) visit(root, 0);

  // Any leftover (cycles / missed) append flat.
  for (const s of list) {
    if (!visited.has(s.id)) out.push({ session: s, depth: 0 });
  }
  return out;
}
