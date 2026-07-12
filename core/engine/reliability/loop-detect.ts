/**
 * Loop / no-progress detection (Phase 4). Requirements §9.1, §9.7.
 * Signals a loop when the last `threshold` tool calls are identical
 * (same name+args), i.e. the agent repeats itself without progress.
 */

export function toolSignature(name: string, args: unknown): string {
  let a: string;
  try {
    a = JSON.stringify(args ?? {});
  } catch {
    a = String(args);
  }
  return `${name}::${a}`;
}

export function detectLoop(signatures: string[], threshold = 3): boolean {
  if (signatures.length < threshold) return false;
  const tail = signatures.slice(-threshold);
  return tail.every((s) => s === tail[0]);
}
