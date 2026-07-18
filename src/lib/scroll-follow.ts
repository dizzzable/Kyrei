export const FOLLOW_OUTPUT_EPSILON_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function isNearBottom(
  metrics: ScrollMetrics,
  epsilonPx: number = FOLLOW_OUTPUT_EPSILON_PX,
): boolean {
  const remaining = metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight);
  return remaining <= epsilonPx;
}
