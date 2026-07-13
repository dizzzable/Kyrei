/** Budget contract shared with Pipeline v1 configuration and durable runs. */
export interface PipelineBudgetLimits {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxCalls?: number;
  readonly maxCostUsd?: number;
  readonly maxWallTimeMs?: number;
  readonly maxRepairCycles?: number;
  readonly maxAssistanceRequests?: number;
  readonly maxConcurrency?: number;
}

export interface PipelineBudgetAmounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly calls: number;
  readonly costUsd: number;
  readonly wallTimeMs: number;
  readonly repairCycles: number;
  readonly assistanceRequests: number;
}

export interface PipelineBudgetRequest extends Partial<PipelineBudgetAmounts> {
  readonly concurrency?: number;
}

export interface BudgetLedgerOptions {
  /** Conservative charge used when a provider omits a usage dimension. */
  readonly conservativeUnmeteredCharge?: PipelineBudgetRequest;
  readonly reservationIdPrefix?: string;
}

export interface BudgetReservation {
  readonly id: string;
  readonly reserved: PipelineBudgetAmounts;
  readonly concurrency: number;
}

export interface BudgetAvailability extends Partial<PipelineBudgetAmounts> {
  readonly concurrency?: number;
}

export interface BudgetLedgerSnapshot {
  readonly limits: PipelineBudgetLimits;
  readonly spent: PipelineBudgetAmounts;
  readonly reserved: PipelineBudgetAmounts;
  readonly available: BudgetAvailability;
  readonly activeReservations: number;
  readonly reservedConcurrency: number;
  readonly unmeteredCalls: number;
  readonly exhausted: boolean;
  readonly overdrawn: boolean;
}

export type BudgetMetering = "metered" | "partial" | "unmetered";

export interface BudgetReconciliation {
  readonly reservationId: string;
  readonly charged: PipelineBudgetAmounts;
  readonly metering: BudgetMetering;
  readonly snapshot: BudgetLedgerSnapshot;
}

type BudgetDimension = keyof PipelineBudgetAmounts;

const DIMENSIONS: readonly BudgetDimension[] = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "calls",
  "costUsd",
  "wallTimeMs",
  "repairCycles",
  "assistanceRequests",
];

const LIMIT_KEYS: Readonly<Record<BudgetDimension, keyof PipelineBudgetLimits>> = {
  inputTokens: "maxInputTokens",
  outputTokens: "maxOutputTokens",
  totalTokens: "maxTotalTokens",
  calls: "maxCalls",
  costUsd: "maxCostUsd",
  wallTimeMs: "maxWallTimeMs",
  repairCycles: "maxRepairCycles",
  assistanceRequests: "maxAssistanceRequests",
};

const ZERO: PipelineBudgetAmounts = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  calls: 0,
  costUsd: 0,
  wallTimeMs: 0,
  repairCycles: 0,
  assistanceRequests: 0,
};

function cloneAmounts(value: PipelineBudgetAmounts): PipelineBudgetAmounts {
  return { ...value };
}

function assertAmount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || (name !== "costUsd" && !Number.isSafeInteger(value))) {
    throw new RangeError(`${name} must be a finite non-negative${name === "costUsd" ? "" : " safe integer"}`);
  }
}

function normalizeAmounts(input: PipelineBudgetRequest | undefined, defaultCalls = 0): PipelineBudgetAmounts {
  const inputTokens = input?.inputTokens ?? 0;
  const outputTokens = input?.outputTokens ?? 0;
  const derivedTotal = inputTokens + outputTokens;
  const totalTokens = input?.totalTokens ?? derivedTotal;
  const value: PipelineBudgetAmounts = {
    inputTokens,
    outputTokens,
    totalTokens,
    calls: input?.calls ?? defaultCalls,
    costUsd: input?.costUsd ?? 0,
    wallTimeMs: input?.wallTimeMs ?? 0,
    repairCycles: input?.repairCycles ?? 0,
    assistanceRequests: input?.assistanceRequests ?? 0,
  };
  for (const dimension of DIMENSIONS) assertAmount(dimension, value[dimension]);
  if (value.totalTokens < derivedTotal) {
    throw new RangeError("totalTokens must cover inputTokens + outputTokens");
  }
  return value;
}

function combine(
  left: PipelineBudgetAmounts,
  right: PipelineBudgetAmounts,
  operation: (a: number, b: number) => number,
): PipelineBudgetAmounts {
  return Object.fromEntries(DIMENSIONS.map((key) => [key, operation(left[key], right[key])])) as unknown as PipelineBudgetAmounts;
}

function maximum(left: PipelineBudgetAmounts, right: PipelineBudgetAmounts): PipelineBudgetAmounts {
  const result = combine(left, right, Math.max);
  return { ...result, totalTokens: Math.max(result.totalTokens, result.inputTokens + result.outputTokens) };
}

function limitFor(limits: PipelineBudgetLimits, dimension: BudgetDimension): number | undefined {
  return limits[LIMIT_KEYS[dimension]];
}

export class BudgetExceededError extends Error {
  constructor(
    readonly dimension: BudgetDimension | "concurrency",
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Cannot reserve ${requested} ${dimension}; only ${Math.max(0, available)} available`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetReservationError";
  }
}

export class BudgetLedger {
  readonly #limits: PipelineBudgetLimits;
  readonly #unmeteredFloor: PipelineBudgetAmounts;
  readonly #reservationIdPrefix: string;
  #spent: PipelineBudgetAmounts = { ...ZERO };
  #reserved: PipelineBudgetAmounts = { ...ZERO };
  #reservedConcurrency = 0;
  #unmeteredCalls = 0;
  #nextReservationId = 1;
  readonly #active = new Map<string, BudgetReservation>();
  readonly #settled = new Set<string>();

  constructor(limits: PipelineBudgetLimits, options: BudgetLedgerOptions = {}) {
    for (const dimension of DIMENSIONS) {
      const limit = limitFor(limits, dimension);
      if (limit != null) assertAmount(dimension, limit);
    }
    if (limits.maxConcurrency != null) {
      assertAmount("maxConcurrency", limits.maxConcurrency);
      if (limits.maxConcurrency === 0) throw new RangeError("maxConcurrency must be positive");
    }
    this.#limits = { ...limits };
    this.#unmeteredFloor = normalizeAmounts(options.conservativeUnmeteredCharge);
    this.#reservationIdPrefix = options.reservationIdPrefix?.trim() || "reservation";
  }

  snapshot(): BudgetLedgerSnapshot {
    const available: Record<string, number> = {};
    let exhausted = false;
    let overdrawn = false;
    for (const dimension of DIMENSIONS) {
      const limit = limitFor(this.#limits, dimension);
      if (limit == null) continue;
      const committed = this.#spent[dimension] + this.#reserved[dimension];
      available[dimension] = Math.max(0, limit - committed);
      exhausted ||= committed >= limit;
      overdrawn ||= this.#spent[dimension] > limit;
    }
    if (this.#limits.maxConcurrency != null) {
      available.concurrency = Math.max(0, this.#limits.maxConcurrency - this.#reservedConcurrency);
      exhausted ||= this.#reservedConcurrency >= this.#limits.maxConcurrency;
    }
    return {
      limits: { ...this.#limits },
      spent: cloneAmounts(this.#spent),
      reserved: cloneAmounts(this.#reserved),
      available,
      activeReservations: this.#active.size,
      reservedConcurrency: this.#reservedConcurrency,
      unmeteredCalls: this.#unmeteredCalls,
      exhausted,
      overdrawn,
    };
  }

  reserve(request: PipelineBudgetRequest): BudgetReservation {
    const requested = normalizeAmounts(request, 1);
    const reserved = maximum(requested, this.#unmeteredFloor);
    const concurrency = request.concurrency ?? 1;
    assertAmount("concurrency", concurrency);
    if (concurrency === 0) throw new BudgetReservationError("concurrency must be positive");
    for (const dimension of DIMENSIONS) {
      const limit = limitFor(this.#limits, dimension);
      if (limit == null) continue;
      const available = limit - this.#spent[dimension] - this.#reserved[dimension];
      if (reserved[dimension] > available) {
        throw new BudgetExceededError(dimension, reserved[dimension], available);
      }
    }
    if (this.#limits.maxConcurrency != null) {
      const available = this.#limits.maxConcurrency - this.#reservedConcurrency;
      if (concurrency > available) throw new BudgetExceededError("concurrency", concurrency, available);
    }
    const reservation: BudgetReservation = {
      id: `${this.#reservationIdPrefix}-${this.#nextReservationId++}`,
      reserved,
      concurrency,
    };
    this.#active.set(reservation.id, reservation);
    this.#reserved = combine(this.#reserved, reserved, (a, b) => a + b);
    this.#reservedConcurrency += concurrency;
    return { ...reservation, reserved: cloneAmounts(reserved) };
  }

  reconcile(reservationId: string, actualUsage?: PipelineBudgetRequest): BudgetReconciliation {
    const reservation = this.#getActive(reservationId);
    const actual = normalizeAmounts(actualUsage, reservation.reserved.calls);
    const supplied = new Set(DIMENSIONS.filter((key) => actualUsage?.[key] != null));
    let charged = Object.fromEntries(DIMENSIONS.map((key) => [
      key,
      supplied.has(key) ? actual[key] : reservation.reserved[key],
    ])) as unknown as PipelineBudgetAmounts;
    if (!supplied.has("totalTokens")) {
      charged = {
        ...charged,
        totalTokens: Math.max(charged.totalTokens, charged.inputTokens + charged.outputTokens),
      };
    }
    const metering: BudgetMetering = supplied.size === 0
      ? "unmetered"
      : supplied.size === DIMENSIONS.length
        ? "metered"
        : "partial";
    this.#reserved = combine(this.#reserved, reservation.reserved, (a, b) => a - b);
    this.#reservedConcurrency -= reservation.concurrency;
    this.#spent = combine(this.#spent, charged, (a, b) => a + b);
    if (metering === "unmetered") this.#unmeteredCalls += charged.calls;
    this.#active.delete(reservationId);
    this.#settled.add(reservationId);
    return { reservationId, charged, metering, snapshot: this.snapshot() };
  }

  release(reservationId: string): BudgetLedgerSnapshot {
    const reservation = this.#getActive(reservationId);
    this.#reserved = combine(this.#reserved, reservation.reserved, (a, b) => a - b);
    this.#reservedConcurrency -= reservation.concurrency;
    this.#active.delete(reservationId);
    this.#settled.add(reservationId);
    return this.snapshot();
  }

  #getActive(reservationId: string): BudgetReservation {
    const reservation = this.#active.get(reservationId);
    if (reservation) return reservation;
    if (this.#settled.has(reservationId)) {
      throw new BudgetReservationError(`Reservation ${reservationId} is already settled`);
    }
    throw new BudgetReservationError(`Unknown reservation ${reservationId}`);
  }
}
