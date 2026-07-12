/**
 * Tolerant 4-level anchor matcher. Requirements §3.2, §3.10.
 * Rule: normalize for COMPARE only — never for the bytes written back.
 */

const UNICODE_MAP: Record<string, string> = {
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2012": "-", "\u2015": "-",
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'", "\u2032": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"', "\u2033": '"',
  "\u00A0": " ", "\u202F": " ", "\u2007": " ", "\u2009": " ", "\u2002": " ", "\u2003": " ", "\u3000": " ",
  "\u200B": "", "\u200C": "", "\u200D": "", "\uFEFF": "", "\u2060": "",
  "\u2028": "", "\u2029": "", "\u2026": "...",
};

const UNICODE_RE =
  /[\u2013\u2014\u2212\u2012\u2015\u2018\u2019\u201A\u201B\u2032\u201C\u201D\u201E\u201F\u2033\u00A0\u202F\u2007\u2009\u2002\u2003\u3000\u200B\u200C\u200D\uFEFF\u2060\u2028\u2029\u2026]/g;

export function normalizeUnicode(s: string): string {
  return s.replace(UNICODE_RE, (c) => UNICODE_MAP[c] ?? c).normalize("NFC");
}

export function normLine(level: 0 | 1 | 2 | 3, s: string): string {
  if (level === 0) return s;
  if (level === 1) return s.replace(/[ \t\f\v]+$/, "");
  const collapsed = s.trim().replace(/[ \t]+/g, " ");
  if (level === 2) return collapsed;
  return normalizeUnicode(collapsed);
}

export interface SeekResult {
  found: boolean; // exactly one match
  index: number;
  level: 0 | 1 | 2 | 3;
  matches: number[];
}

/** Search needle (line sequence) in haystack, escalating leniency until a level matches. */
export function seekSequence(haystack: string[], needle: string[], fromLevel: 0 | 1 | 2 | 3 = 0): SeekResult {
  if (needle.length === 0) return { found: false, index: -1, level: 0, matches: [] };
  for (let level = fromLevel; level <= 3; level = (level + 1) as 0 | 1 | 2 | 3) {
    const lv = level as 0 | 1 | 2 | 3;
    const H = haystack.map((s) => normLine(lv, s));
    const N = needle.map((s) => normLine(lv, s));
    const matches: number[] = [];
    for (let i = 0; i + N.length <= H.length; i++) {
      let ok = true;
      for (let j = 0; j < N.length; j++) {
        if (H[i + j] !== N[j]) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push(i);
    }
    if (matches.length >= 1) return { found: matches.length === 1, index: matches[0]!, level: lv, matches };
    if (level === 3) break;
  }
  return { found: false, index: -1, level: 3, matches: [] };
}
