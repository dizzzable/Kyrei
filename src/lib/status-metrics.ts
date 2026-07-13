export interface ContextMetric {
  used: number;
  limit: number;
  percent: number;
  filledCells: number;
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatCompactTokens(value: number): string {
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    const scaled = safe / 1_000_000;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}M`;
  }
  if (safe >= 1_000) {
    const scaled = safe / 1_000;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
  }
  return String(Math.round(safe));
}

export function contextMetric(used: number, limit: number): ContextMetric | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const ratio = Math.min(1, safeUsed / limit);
  return {
    used: safeUsed,
    limit,
    percent: Math.round(ratio * 100),
    filledCells: safeUsed > 0 ? Math.max(1, Math.ceil(ratio * 10)) : 0,
  };
}
