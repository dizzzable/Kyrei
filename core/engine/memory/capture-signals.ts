/**
 * Wave H — MemoHood-inspired cheap capture signals (offline, no LLM).
 *
 * Explicit remember / decision / preference / correction lines score high and
 * can be stored without an LLM call. Borderline lines stay for the curator
 * LLM pass. Pin triggers mark facts that must not decay in LTM ranking.
 */

export type CaptureKind =
  | "persona"
  | "event"
  | "preference"
  | "decision"
  | "correction"
  | "fact"
  | "instruction"
  | "summary";

export interface CaptureSignal {
  line: string;
  score: number;
  kind: CaptureKind;
  pinned: boolean;
  /** Which rule families fired (debug / tests). */
  reasons: string[];
}

/** Default threshold: at or above → durable capture without LLM. */
export const DEFAULT_CAPTURE_THRESHOLD = 4.0;

/**
 * JS `\b` is ASCII-only; use unicode letter boundaries for RU/EN.
 * `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` ≈ word boundary for letters.
 */
const WB = String.raw`(?<![\p{L}\p{N}_])`;
const WE = String.raw`(?![\p{L}\p{N}_])`;

const PIN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: new RegExp(`${WB}(?:allerg(?:y|ic|ies)|аллерг[\\p{L}]*)` + WE, "iu"), reason: "allergy" },
  { re: new RegExp(`${WB}(?:diagnos(?:is|ed)|диагноз[\\p{L}]*)` + WE, "iu"), reason: "diagnosis" },
  { re: new RegExp(`${WB}(?:date of birth|birthday|д\\.?\\s*р\\.?|день рождения|дата рождения)` + WE, "iu"), reason: "dob" },
  { re: new RegExp(`${WB}(?:remember forever|запомни навсегда|never forget|никогда не забывай|pinned?)` + WE, "iu"), reason: "forever" },
  { re: new RegExp(`${WB}(?:my name is|меня зовут)|(?:^|[\\s,.:;])я\\s*[-—]\\s*[\\p{L}]`, "iu"), reason: "name" },
];

const SIGNAL_RULES: Array<{ re: RegExp; weight: number; kind: CaptureKind; reason: string }> = [
  // Explicit remember
  {
    re: new RegExp(`${WB}(?:remember|запомни|запомнить|don't forget|не забудь)` + WE, "iu"),
    weight: 5,
    kind: "fact",
    reason: "remember",
  },
  // Decisions
  {
    re: new RegExp(
      `${WB}(?:we (?:will|chose|pick|decided)|going with|decided|decision|выбрали|решили|решение|договорились)` + WE,
      "iu",
    ),
    weight: 4.5,
    kind: "decision",
    reason: "decision",
  },
  // Corrections / supersede intent
  {
    re: new RegExp(
      `${WB}(?:actually|on second thought|correction|rather|instead|на самом деле|наоборот|исправлен|не\\s+так|ошибс?я)` + WE,
      "iu",
    ),
    weight: 4.2,
    kind: "correction",
    reason: "correction",
  },
  // Preferences
  {
    re: new RegExp(
      `${WB}(?:prefer|always|never|please use|предпочит[\\p{L}]*|всегда|никогда|по умолчанию|default to)` + WE,
      "iu",
    ),
    weight: 3.5,
    kind: "preference",
    reason: "preference",
  },
  // Instructions
  {
    re: new RegExp(`${WB}(?:from now on|going forward|must always|отныне|впредь|обязательно)` + WE, "iu"),
    weight: 4,
    kind: "instruction",
    reason: "instruction",
  },
  // Project facts
  {
    re: new RegExp(`${WB}(?:uses?|stack|convention|we use|проект|стек|конвенци[\\p{L}]*|архитектур[\\p{L}]*)` + WE, "iu"),
    weight: 2.5,
    kind: "fact",
    reason: "project_fact",
  },
  // Events / done
  {
    re: new RegExp(
      `${WB}(?:done|fixed|implemented|merged|shipped|сделано|готово|исправлено|замержили)` + WE,
      "iu",
    ),
    weight: 2,
    kind: "event",
    reason: "done",
  },
  // Next / todo (lower — often ephemeral)
  {
    re: new RegExp(`${WB}(?:todo|next|need to|should|далее|нужно|следующ[\\p{L}]*|FIXME)` + WE, "iu"),
    weight: 1.5,
    kind: "event",
    reason: "next",
  },
];

export function detectPinned(text: string): { pinned: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const p of PIN_PATTERNS) {
    if (p.re.test(text)) reasons.push(p.reason);
  }
  return { pinned: reasons.length > 0, reasons };
}

/**
 * Score one transcript line for durable capture.
 * Score ≥ threshold → cheap auto-capture candidate.
 */
export function scoreCaptureLine(rawLine: string): CaptureSignal {
  const line = rawLine
    .replace(/^(USER|ASSISTANT|SYSTEM):\s*/i, "")
    .replace(/^[-*•]\s*/, "")
    .trim();
  const reasons: string[] = [];
  let score = 0;
  let kind: CaptureKind = "fact";
  let bestWeight = 0;

  if (line.length < 8 || line.length > 500) {
    return { line, score: 0, kind: "fact", pinned: false, reasons: ["length"] };
  }

  for (const rule of SIGNAL_RULES) {
    if (rule.re.test(line)) {
      score += rule.weight;
      reasons.push(rule.reason);
      if (rule.weight > bestWeight) {
        bestWeight = rule.weight;
        kind = rule.kind;
      }
    }
  }

  const pin = detectPinned(line);
  if (pin.pinned) {
    score += 3;
    reasons.push(...pin.reasons.map((r) => `pin:${r}`));
    if (kind === "event") kind = "fact";
  }

  // Soft length bonus for substantial statements.
  if (line.length >= 40 && score > 0) score += 0.5;

  return {
    line,
    score,
    kind,
    pinned: pin.pinned,
    reasons,
  };
}

export interface CaptureExtractResult {
  signals: CaptureSignal[];
  /** Lines at/above threshold (cheap durable candidates). */
  durable: CaptureSignal[];
  pinned: CaptureSignal[];
}

/** Scan a multi-line transcript; return scored signals (deduped by text). */
export function extractCaptureSignals(
  transcript: string,
  threshold = DEFAULT_CAPTURE_THRESHOLD,
): CaptureExtractResult {
  const seen = new Set<string>();
  const signals: CaptureSignal[] = [];
  for (const raw of transcript.split(/\n+/)) {
    const s = scoreCaptureLine(raw);
    if (s.score <= 0) continue;
    const key = s.line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push(s);
  }
  signals.sort((a, b) => b.score - a.score);
  return {
    signals,
    durable: signals.filter((s) => s.score >= threshold),
    pinned: signals.filter((s) => s.pinned),
  };
}

/** Halflife days by kind for Ebbinghaus-style decay (MemoHood-aligned defaults). */
export const DEFAULT_DECAY_HALFLIFE_DAYS: Record<CaptureKind, number> = {
  event: 7,
  preference: 90,
  decision: 90,
  correction: 90,
  fact: 365,
  persona: 365,
  instruction: 365,
  summary: 365,
};

export interface DecayConfig {
  enabled: boolean;
  floor: number;
  halflifeDays: Record<CaptureKind, number>;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  enabled: true,
  floor: 0.05,
  halflifeDays: { ...DEFAULT_DECAY_HALFLIFE_DAYS },
};

export function normalizeDecayConfig(value: unknown): DecayConfig {
  const src = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const hlSrc =
    src.halflifeDays && typeof src.halflifeDays === "object" && !Array.isArray(src.halflifeDays)
      ? (src.halflifeDays as Record<string, unknown>)
      : {};
  const hl = { ...DEFAULT_DECAY_HALFLIFE_DAYS };
  for (const key of Object.keys(hl) as CaptureKind[]) {
    const n = Number(hlSrc[key]);
    if (Number.isFinite(n) && n >= 1 && n <= 3650) hl[key] = Math.floor(n);
  }
  const floor = Number(src.floor);
  return {
    enabled: src.enabled !== false,
    floor: Number.isFinite(floor) ? Math.min(0.5, Math.max(0.001, floor)) : DEFAULT_DECAY_CONFIG.floor,
    halflifeDays: hl,
  };
}

/**
 * Effective confidence after Ebbinghaus-style exponential decay.
 * Pinned items always return base confidence (no decay).
 */
export function effectiveConfidence(opts: {
  baseConfidence: number;
  kind: CaptureKind;
  pinned: boolean;
  lastAccessedAt: string | Date;
  now?: Date;
  config?: DecayConfig;
}): number {
  const cfg = opts.config ?? DEFAULT_DECAY_CONFIG;
  const base = Math.min(1, Math.max(0, opts.baseConfidence));
  if (!cfg.enabled || opts.pinned) return base;
  const last =
    opts.lastAccessedAt instanceof Date
      ? opts.lastAccessedAt
      : new Date(opts.lastAccessedAt);
  if (Number.isNaN(last.getTime())) return base;
  const now = opts.now ?? new Date();
  const days = Math.max(0, (now.getTime() - last.getTime()) / (86_400_000));
  const half = cfg.halflifeDays[opts.kind] ?? 90;
  const decayed = base * Math.pow(0.5, days / half);
  return Math.max(cfg.floor, decayed);
}
