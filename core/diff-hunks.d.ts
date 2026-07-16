export type DiffOp = { kind: " " | "+" | "-"; text: string };
export type DiffHunk = {
  id: string;
  status: "pending" | "accepted" | "rejected";
  start: number;
  end: number;
  preview: string;
};

export function parseDiffOps(diffText: string): DiffOp[];
export function groupOpsIntoHunks(ops: DiffOp[]): DiffHunk[];
export function parseLineDiffHunks(diffText: string): { ops: DiffOp[]; hunks: DiffHunk[] };
export function applyHunksToOldText(oldText: string, ops: DiffOp[], hunks: DiffHunk[]): string;
export function applyHunkDecisions(
  hunks: DiffHunk[],
  decisions: Array<{ id: string; accept: boolean }>,
): DiffHunk[];
export function allHunksDecided(hunks: DiffHunk[]): boolean;
export function aggregateHunkStatus(
  hunks: DiffHunk[],
): "pending" | "accepted" | "rejected" | "partial";
