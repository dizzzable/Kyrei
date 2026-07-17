/**
 * Key pool: round-robin + session-affinity + per-key cooldown/circuit-breaker.
 * Requirements §7.4. For a single key this is a no-op passthrough.
 */

interface KeyState {
  key: string;
  cooldownUntil: number;
  failures: number;
}

export class KeyPool {
  private states: KeyState[];
  private rr = 0;
  private affinity: number | null = null;
  private sessionId?: string;

  constructor(opts: { keys: string[]; sessionId?: string }) {
    this.states = opts.keys.filter(Boolean).map((key) => ({ key, cooldownUntil: 0, failures: 0 }));
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
  }

  get size(): number {
    return this.states.length;
  }
  isMulti(): boolean {
    return this.states.length > 1;
  }
  staticKey(): string | undefined {
    return this.states.length === 1 ? this.states[0]!.key : this.states[0]?.key;
  }

  private pick(): KeyState | undefined {
    const now = Date.now();
    const avail = this.states.filter((s) => s.cooldownUntil <= now);
    const pool = avail.length ? avail : this.states;
    if (pool.length === 0) return undefined;
    // Session-affinity: stick to one key for prompt-cache locality.
    if (this.sessionId !== undefined) {
      if (this.affinity !== null && pool.includes(this.states[this.affinity]!)) return this.states[this.affinity]!;
      const chosen = pool[this.rr++ % pool.length]!;
      this.affinity = this.states.indexOf(chosen);
      return chosen;
    }
    return pool[this.rr++ % pool.length]!;
  }

  private penalize(key: string, status?: number): void {
    const s = this.states.find((x) => x.key === key);
    if (!s) return;
    s.failures += 1;
    if (status === 429 || (status && status >= 500)) {
      s.cooldownUntil = Date.now() + Math.min(60_000, 1_000 * 2 ** s.failures);
    }
  }
  private reward(key: string): void {
    const s = this.states.find((x) => x.key === key);
    if (s) s.failures = 0;
  }

  /**
   * fetch middleware for @ai-sdk/openai-compatible: injects Authorization, tracks cooldown.
   * Optional baseFetch lets subscription-shield wrap the underlying transport.
   */
  fetchMiddleware(baseFetch: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
    return (async (input: any, init: any = {}) => {
      const state = this.pick();
      const headers = new Headers(init.headers ?? {});
      if (state?.key) headers.set("Authorization", `Bearer ${state.key}`);
      const res = await baseFetch(input, { ...init, headers });
      if (state) {
        if (res.ok) this.reward(state.key);
        else this.penalize(state.key, res.status);
      }
      return res;
    }) as typeof fetch;
  }
}
