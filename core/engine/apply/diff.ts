/**
 * LCS line diff + counters + per-file rendering. Requirements §3.4.
 */

const MAX_DIFF_LINES = 2000;

export interface DiffResult {
  text: string;
  added: number;
  removed: number;
}

export function computeDiff(oldStr: string, newStr: string): DiffResult {
  const a = oldStr === "" ? [] : oldStr.split("\n");
  const b = newStr === "" ? [] : newStr.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { text: "", added: 0, removed: 0 };
  }
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push("-" + a[i]);
      removed++;
      i++;
    } else {
      out.push("+" + b[j]);
      added++;
      j++;
    }
  }
  while (i < m) {
    out.push("-" + a[i++]);
    removed++;
  }
  while (j < n) {
    out.push("+" + b[j++]);
    added++;
  }
  return { text: out.join("\n"), added, removed };
}

export function renderCounter(d: DiffResult): string {
  return `+${d.added} −${d.removed}`;
}

export function renderFileDiff(
  kind: "add" | "modify" | "delete",
  rel: string,
  oldStr: string,
  newStr: string,
): { header: string; body: string; counter: string } {
  const d = kind === "add" ? computeDiff("", newStr) : kind === "delete" ? computeDiff(oldStr, "") : computeDiff(oldStr, newStr);
  const tag = kind === "add" ? "A" : kind === "delete" ? "D" : "M";
  return { header: `${tag}  ${rel}`, body: d.text, counter: renderCounter(d) };
}
