import { describe, expect, it, vi } from "vitest";
import {
  MIN_EVIDENCE_OCCURRENCES,
  PROMOTABLE_TARGET_KINDS,
  admitCandidate,
  decideCandidate,
  evidenceStrength,
} from "../core/evolution-admit.js";
import { evaluatePendingCandidates } from "../core/evolution-eval.js";

/** A candidate that should pass every deterministic check. */
function goodCandidate(over: Record<string, unknown> = {}) {
  return {
    id: "cand-1",
    revision: 1,
    status: "pending",
    target: { kind: "skill", id: "skill_abc" },
    title: "Repeated read_file failures",
    summary: "read_file failed twice in one session.",
    risk: "low",
    proposal: {
      kind: "tool-failure-pattern",
      tool: "read_file",
      occurrences: 3,
      samples: ["ENOENT missing.ts", "ENOENT other.ts"],
    },
    ...over,
  };
}

describe("evidenceStrength", () => {
  it("counts occurrences only when samples back them", () => {
    // A count with no samples is an assertion about evidence, not evidence.
    expect(evidenceStrength({ kind: "tool-failure-pattern", occurrences: 9, samples: [] })).toBe(0);
    expect(evidenceStrength({ kind: "tool-failure-pattern", occurrences: 9, samples: ["x"] })).toBe(9);
  });

  it("treats a heal-handoff as evidenced only when it names the tools", () => {
    expect(evidenceStrength({ kind: "heal-handoff", tools: [] })).toBe(0);
    expect(evidenceStrength({ kind: "heal-handoff", tools: ["run_command"] })).toBe(MIN_EVIDENCE_OCCURRENCES);
  });

  it("scores an unrecognised proposal shape at zero", () => {
    // New evidence shapes must be added consciously rather than inheriting
    // admissibility by default.
    expect(evidenceStrength({ kind: "something-new", occurrences: 100 })).toBe(0);
    expect(evidenceStrength(null)).toBe(0);
  });
});

describe("admitCandidate", () => {
  it("admits a well-formed, evidenced, low-risk candidate", () => {
    const admission = admitCandidate(goodCandidate());
    expect(admission.reasons).toEqual([]);
    expect(admission.admissible).toBe(true);
    expect(admission.promotable).toBe(true);
  });

  it("refuses a candidate that cites no evidence", () => {
    const admission = admitCandidate(goodCandidate({ proposal: { kind: "tool-failure-pattern", tool: "x" } }));
    expect(admission.admissible).toBe(false);
    expect(admission.reasons.join(" ")).toContain("evidence_insufficient");
  });

  it("sends anything above low risk to a human", () => {
    // Auto-admitting a medium-risk self-modification would make
    // "proposal-first" a formality.
    for (const risk of ["medium", "high"]) {
      const admission = admitCandidate(goodCandidate({ risk }));
      expect(admission.admissible, risk).toBe(false);
      expect(admission.reasons.join(" ")).toContain("risk_requires_review");
    }
  });

  it("refuses a proposal carrying a secret", () => {
    // The proposal is harvested from a transcript and the executor writes it to
    // disk; this is the last gate before that write.
    const admission = admitCandidate(goodCandidate({
      proposal: {
        kind: "tool-failure-pattern",
        tool: "run_command",
        occurrences: 2,
        samples: ["failed with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      },
    }));
    expect(admission.admissible).toBe(false);
    expect(admission.reasons).toContain("proposal_contains_secret");
  });

  it("admits a journal-only target but refuses to call it promotable", () => {
    // `reliability-hint` has no reversible write path in the executor.
    const admission = admitCandidate(goodCandidate({ target: { kind: "reliability-hint", id: "tool:read_file" } }));
    expect(admission.admissible).toBe(true);
    expect(admission.promotable).toBe(false);
    expect(PROMOTABLE_TARGET_KINDS).not.toContain("reliability-hint");
  });

  it("refuses a duplicate of something already journaled", () => {
    const admission = admitCandidate(goodCandidate({ digest: "d1" }), { knownDigests: new Set(["d1"]) });
    expect(admission.admissible).toBe(false);
    expect(admission.reasons).toContain("duplicate_digest");
  });

  it("collects every reason rather than stopping at the first", () => {
    // The rejection reason is the audit trail; truncating it to the first
    // failure hides the rest of what is wrong with the candidate.
    const admission = admitCandidate({ target: {}, risk: "high", proposal: {} });
    expect(admission.reasons.length).toBeGreaterThan(3);
  });
});

describe("decideCandidate", () => {
  const admissible = { admissible: true, reasons: [], strength: 3, promotable: true };
  const approve = { verdict: "approve" as const, score: 0.9, rationale: "looks fine" };

  it("approves only when both the checks and the model agree", () => {
    expect(decideCandidate(admissible, approve).decision).toBe("approved");
  });

  it("lets the model veto however strong the evidence", () => {
    expect(decideCandidate(admissible, { verdict: "reject", score: 0.9, rationale: "unsafe" }).decision).toBe("rejected");
  });

  it("never lets the model approve an inadmissible candidate", () => {
    // The inversion this whole module exists for: an LLM trust-scorer admitted
    // 82 entries of which 54 were malicious and scored a perfect 1.0. Judges
    // have a false-PASS bias, so a judge may subtract confidence, never supply
    // it.
    const inadmissible = { admissible: false, reasons: ["evidence_insufficient:0<2"], strength: 0, promotable: false };
    const decision = decideCandidate(inadmissible, { verdict: "approve", score: 1, rationale: "certain" });
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("evidence_insufficient");
  });

  it("fails closed when the model could not be read", () => {
    // A model that cannot be reached must block self-modification, not wave it
    // through — the same reasoning as verify-before-done being fail-closed.
    expect(decideCandidate(admissible, null).decision).toBe("rejected");
  });
});

/** Minimal store: `evaluatePendingCandidates` needs only these two calls. */
function fakeStore(candidates: Array<Record<string, unknown>>) {
  const transitions: Array<Record<string, unknown>> = [];
  return {
    transitions,
    list: async () => candidates,
    transition: async (id: string, patch: Record<string, unknown>) => {
      transitions.push({ id, ...patch });
      return { id, revision: (Number(patch.expectedRevision) || 0) + 1 };
    },
  };
}

const approveReply = { text: '{"verdict":"approve","score":0.95,"rationale":"ok"}', usage: { inputTokens: 1, outputTokens: 1 } };

describe("evaluatePendingCandidates — the decision that gates a self-modification", () => {
  it("approves an evidenced candidate the model also approves", async () => {
    const store = fakeStore([goodCandidate()]);
    const result = await evaluatePendingCandidates(store, {
      generateText: async () => approveReply,
      abortMs: 0,
    });
    expect(result.approved).toBe(1);
    expect(store.transitions.at(-1)?.status).toBe("approved");
  });

  it("rejects an unevidenced candidate WITHOUT asking the model", async () => {
    // Asking is both pointless — it cannot change the outcome — and paid for,
    // and it would put a malformed proposal into a prompt for no reason.
    const generateText = vi.fn(async () => approveReply);
    const store = fakeStore([goodCandidate({ proposal: { kind: "tool-failure-pattern", tool: "x" } })]);
    const result = await evaluatePendingCandidates(store, { generateText, abortMs: 0 });

    expect(generateText).not.toHaveBeenCalled();
    expect(result.rejected).toBe(1);
    expect(String(store.transitions.at(-1)?.reason)).toContain("evidence_insufficient");
  });

  it("treats a half-hearted approval as a veto", async () => {
    const store = fakeStore([goodCandidate()]);
    const result = await evaluatePendingCandidates(store, {
      generateText: async () => ({ text: '{"verdict":"approve","score":0.1,"rationale":"shrug"}', usage: {} }),
      abortMs: 0,
    });
    expect(result.approved).toBe(0);
    expect(String(store.transitions.at(-1)?.reason)).toContain("eval_low_score");
  });

  it("fails closed when the model reply is unusable", async () => {
    const store = fakeStore([goodCandidate()]);
    const result = await evaluatePendingCandidates(store, {
      generateText: async () => ({ text: "I could not decide.", usage: {} }),
      abortMs: 0,
    });
    expect(result.approved).toBe(0);
    expect(store.transitions.at(-1)?.reason).toBe("eval_unparseable");
  });

  it("records the evidence count, not just the model's opinion", async () => {
    const store = fakeStore([goodCandidate()]);
    await evaluatePendingCandidates(store, { generateText: async () => approveReply, abortMs: 0 });
    const evidence = store.transitions.at(-1)?.evidence as { receipts: string[]; metrics: Record<string, unknown> };
    expect(evidence.receipts[0]).toContain("evidence:3");
    expect(evidence.metrics.evidenceStrength).toBe(3);
    expect(evidence.metrics.promotable).toBe(true);
  });
});
