/**
 * Line-diff hunks for supervised review (Kiro-style).
 * Diff format matches engine computeDiff: lines prefixed with " ", "+", "-".
 */

/**
 * @typedef {{ kind: " " | "+" | "-"; text: string }} DiffOp
 * @typedef {{ id: string; status: "pending" | "accepted" | "rejected"; start: number; end: number; preview: string }} DiffHunk
 */

/**
 * @param {string} diffText
 * @returns {DiffOp[]}
 */
export function parseDiffOps(diffText) {
  if (typeof diffText !== "string" || !diffText.length) return [];
  return diffText.split("\n").map((line) => {
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      return { kind: /** @type {" "|"+"|"-"} */ (line[0]), text: line.slice(1) };
    }
    return { kind: /** @type {" "} */ (" "), text: line };
  });
}

/**
 * Group consecutive change ops (+/-) into hunks. Context lines are not stored
 * in hunks; full `ops` is kept separately for apply.
 *
 * @param {DiffOp[]} ops
 * @returns {DiffHunk[]}
 */
export function groupOpsIntoHunks(ops) {
  /** @type {DiffHunk[]} */
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === " ") i += 1;
    if (i >= ops.length) break;
    const start = i;
    while (i < ops.length && ops[i].kind !== " ") i += 1;
    const end = i; // exclusive
    const slice = ops.slice(start, end);
    const preview = slice.map((op) => `${op.kind}${op.text}`).join("\n").slice(0, 1_200);
    hunks.push({
      id: `h${hunks.length}`,
      status: "pending",
      start,
      end,
      preview,
    });
  }
  return hunks;
}

/**
 * @param {string} diffText
 * @returns {{ ops: DiffOp[]; hunks: DiffHunk[] }}
 */
export function parseLineDiffHunks(diffText) {
  const ops = parseDiffOps(diffText);
  return { ops, hunks: groupOpsIntoHunks(ops) };
}

/**
 * Rebuild file content from pre-edit text + full ops, applying only accepted hunks.
 * Rejected hunks keep the old side; accepted hunks take the new side.
 *
 * @param {string} oldText
 * @param {DiffOp[]} ops
 * @param {DiffHunk[]} hunks
 * @returns {string}
 */
export function applyHunksToOldText(oldText, ops, hunks) {
  const accepted = new Set(
    (Array.isArray(hunks) ? hunks : [])
      .filter((h) => h.status === "accepted")
      .flatMap((h) => {
        const range = [];
        for (let i = h.start; i < h.end; i++) range.push(i);
        return range;
      }),
  );
  // Also treat "pending" as not accepted (fail-closed for partial apply)
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  /** @type {string[]} */
  const out = [];
  let oi = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === " ") {
      out.push(op.text);
      oi += 1;
      continue;
    }
    const takeNew = accepted.has(i);
    if (op.kind === "-") {
      if (!takeNew) out.push(op.text);
      oi += 1;
    } else if (op.kind === "+") {
      if (takeNew) out.push(op.text);
    }
  }
  // If diff did not cover the whole file (truncated), append remaining old lines.
  // Our engine diffs are full-file LCS, so oi should match; keep safety net.
  if (oi < oldLines.length && ops.length === 0) {
    return oldText;
  }
  return out.join("\n");
}

/**
 * Apply hunk decisions in-place on a hunk list.
 * @param {DiffHunk[]} hunks
 * @param {Array<{ id: string; accept: boolean }>} decisions
 */
export function applyHunkDecisions(hunks, decisions) {
  const map = new Map(
    (Array.isArray(decisions) ? decisions : []).map((d) => [String(d.id), d.accept === true]),
  );
  return (Array.isArray(hunks) ? hunks : []).map((h) => {
    if (!map.has(h.id) || h.status !== "pending") return { ...h };
    return { ...h, status: map.get(h.id) ? "accepted" : "rejected" };
  });
}

export function allHunksDecided(hunks) {
  return Array.isArray(hunks) && hunks.length > 0 && hunks.every((h) => h.status !== "pending");
}

export function aggregateHunkStatus(hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) return "accepted";
  if (hunks.some((h) => h.status === "pending")) return "pending";
  if (hunks.every((h) => h.status === "accepted")) return "accepted";
  if (hunks.every((h) => h.status === "rejected")) return "rejected";
  return "partial";
}
