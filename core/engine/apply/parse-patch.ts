/**
 * Context-anchored patch parser (codex-style) + lenient pre-processor.
 * Format: `*** Begin/Update/Add/Delete/Move File`, `@@` anchors, ` `/`-`/`+` lines.
 * Requirements §3.1, §3.6, §3.11.
 */

export interface HunkLine {
  kind: " " | "-" | "+";
  text: string;
}

export interface PatchHunk {
  anchor?: string;
  ops: HunkLine[];
  /** context+remove lines (what must exist in the old file), in order. */
  needle: string[];
}

export interface FilePatch {
  op: "update" | "add" | "delete" | "move";
  file: string;
  dest?: string;
  hunks: PatchHunk[];
  addBody?: string[];
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/** Strip markdown fences, heredoc wrappers, shell prompts, trailing junk. */
export function sanitizePatch(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "");
  s = s.replace(/^\s*```[\w-]*\r?\n/, "").replace(/\r?\n```[ \t]*$/s, "");
  const hd = s.match(/^[^\n]*<<-?['"]?(\w+)['"]?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/);
  if (hd && hd[2] !== undefined) s = hd[2];
  s = s.replace(/^(?:\$ |PS[^>]*> |> )(\*\*\* )/gm, "$1");
  const end = s.indexOf("*** End Patch");
  if (end >= 0) s = s.slice(0, end + "*** End Patch".length);
  s = s.replace(/^[\uFEFF\u200B]+(\*\*\* )/gm, "$1");
  return s;
}

function mkHunk(anchor?: string): PatchHunk {
  return { anchor, ops: [], needle: [] };
}

function parseHunks(lines: string[], start: number): [PatchHunk[], number] {
  const hunks: PatchHunk[] = [];
  let i = start;
  let cur: PatchHunk | null = null;
  // A wholly empty line is ambiguous. The format wants " " for a blank context
  // line, but models — and any trailing-whitespace stripper between the model
  // and us — routinely emit "". Bailing out on it silently dropped every later
  // hunk in the file (the outer loop then ate them as "junk") and still
  // reported success. Blank lines also legitimately pad the end of a block, so
  // buffer them and commit them as context only once a real hunk line follows.
  let pendingBlanks = 0;
  const flush = () => {
    if (cur && cur.ops.length) hunks.push(cur);
    cur = null;
  };
  const commitBlanks = () => {
    // Only blanks *between* real hunk lines are content; leading ones are
    // formatting between the directive and the body.
    if (cur && cur.ops.length) {
      for (let n = 0; n < pendingBlanks; n++) {
        cur.ops.push({ kind: " ", text: "" });
        cur.needle.push("");
      }
    }
    pendingBlanks = 0;
  };
  const isDirective = (l: string) => /^\*\*\* /.test(l);
  while (i < lines.length && !isDirective(lines[i]!)) {
    const l = lines[i]!;
    if (l === "") {
      pendingBlanks++;
      i++;
      continue;
    }
    if (l.startsWith("@@")) {
      pendingBlanks = 0; // blanks before a new hunk header are separators
      flush();
      cur = mkHunk(l.slice(2).trim() || undefined);
      i++;
      continue;
    }
    const k = l[0];
    if (k === " " || k === "-" || k === "+") {
      commitBlanks();
      cur ??= mkHunk();
      const text = l.slice(1);
      cur.ops.push({ kind: k, text });
      if (k !== "+") cur.needle.push(text);
      i++;
    } else {
      break; // unknown marker → end of hunk block
    }
  }
  flush(); // trailing blanks are never committed — they are padding
  return [hunks, i];
}

export function parsePatch(raw: string): FilePatch[] {
  const src = sanitizePatch(raw);
  const lines = src.split(/\r?\n/);
  const out: FilePatch[] = [];
  let i = 0;
  const isDirective = (l: string) =>
    /^\*\*\* (Begin|End) Patch$/.test(l) || /^\*\*\* (Update|Add|Delete|Move) File: /.test(l);

  while (i < lines.length) {
    const l = lines[i]!;
    if (l === "*** Begin Patch" || l === "*** End Patch" || l.trim() === "") {
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\*\*\* Add File: (.+)$/))) {
      const body: string[] = [];
      // Same blank-line ambiguity as parseHunks: "" instead of "+" for an empty
      // line used to truncate the new file to whatever preceded it.
      let blanks = 0;
      i++;
      while (i < lines.length && !isDirective(lines[i]!)) {
        const b = lines[i]!;
        if (b === "") {
          blanks++;
          i++;
          continue;
        }
        if (!b.startsWith("+")) break; // unknown marker → end of add body
        if (body.length) for (let n = 0; n < blanks; n++) body.push("");
        blanks = 0;
        body.push(b.slice(1));
        i++;
      }
      out.push({ op: "add", file: normPath(m[1]!), hunks: [], addBody: body });
    } else if ((m = l.match(/^\*\*\* Delete File: (.+)$/))) {
      out.push({ op: "delete", file: normPath(m[1]!), hunks: [] });
      i++;
    } else if ((m = l.match(/^\*\*\* Move File: (.+?) -> (.+)$/))) {
      i++;
      const [hunks, next] = parseHunks(lines, i);
      i = next;
      out.push({ op: "move", file: normPath(m[1]!), dest: normPath(m[2]!), hunks });
    } else if ((m = l.match(/^\*\*\* Update File: (.+)$/))) {
      i++;
      const [hunks, next] = parseHunks(lines, i);
      i = next;
      out.push({ op: "update", file: normPath(m[1]!), hunks });
    } else {
      i++; // junk between sections (lenient)
    }
  }
  return out;
}
