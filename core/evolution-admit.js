/**
 * Evolution admissibility — the deterministic half of the acceptor.
 *
 * WHY THIS EXISTS
 *
 * Promotion rewrites a real artifact on disk. Until now the only thing standing
 * between a harvested candidate and that write was a single model call scoring
 * its OWN confidence, admitted at 0.5 — a design the module's own comment
 * described as "no baseline and no replay, so the score is the only signal".
 *
 * That design is refuted rather than merely thin. Measured on a memory-poisoning
 * benchmark, an LLM trust-scorer admitted 82 entries of which 54 were malicious
 * and scored a perfect 1.0. Judges have a false-PASS bias, and a false pass here
 * is a self-modification that ships.
 *
 * So the decision is inverted: **a model may veto, it may never approve.**
 * Approval comes from deterministic, checkable properties of the candidate
 * itself. That converts the failure mode from "bad candidates ship" to "good
 * candidates wait for a human", which is the correct direction for a system that
 * edits its own skills and prompts.
 *
 * What this module deliberately does NOT claim: it does not measure whether a
 * candidate IMPROVES anything. Kyrei's eval suite scripts the model's decisions,
 * so replaying a prompt-profile or skill change against it produces identical
 * output either way. Building a "replay gate" on top of it would look rigorous
 * and measure nothing. Admissibility is about whether a candidate is
 * well-formed, evidenced and reversible — not whether it helps.
 */

import { redactSensitiveText } from "./secret-redaction.js";

export const EVOLUTION_ADMIT_VERSION = 1;

/**
 * Does this text carry something that must not be written to disk?
 *
 * Deliberately the GATEWAY redactor's pattern list, not the engine's. The two
 * differ on purpose: the engine list is conservative because it backs
 * `containsSecret`, which DENIES `write_file` — a false positive there blocks
 * the user's own legitimate work. Here a false positive only means the
 * candidate waits for a human, which is the direction this whole gate is built
 * to fail in. So the broader list is the right one at this particular door.
 */
function carriesSecret(value) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return raw.length > 0 && redactSensitiveText(raw) !== raw;
}

/**
 * Target kinds the executor can actually write and reverse.
 *
 * `memory-ranking` and `reliability-hint` have no safe reversible write path
 * (see core/evolution-executor.js), so a candidate aimed at them is journal-only
 * and must never be marked promotable.
 */
export const PROMOTABLE_TARGET_KINDS = Object.freeze(["skill", "prompt-profile"]);

/**
 * Distinct occurrences a failure-pattern proposal must cite.
 *
 * The harvester already clusters at 2 before emitting anything; requiring it
 * again here is deliberate, not redundant. The harvester is add-only and its
 * output is model-authored narrative — this is the point where the *evidence*
 * is checked rather than the story about it.
 */
export const MIN_EVIDENCE_OCCURRENCES = 2;

/** Bounds that keep a malformed or hostile proposal from reaching the executor. */
const MAX_TITLE = 300;
const MAX_SUMMARY = 4_000;
const MAX_PROPOSAL_CHARS = 20_000;

function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Evidence strength of a proposal, or 0 when it cites none.
 *
 * Only shapes the harvester actually produces are recognised. An unrecognised
 * proposal kind scores 0 — new evidence shapes must be added here consciously,
 * rather than inheriting admissibility by default.
 */
export function evidenceStrength(proposal) {
  if (!proposal || typeof proposal !== "object") return 0;
  const kind = text(proposal.kind);
  if (kind === "tool-failure-pattern") {
    const occurrences = Number(proposal.occurrences) || 0;
    const samples = Array.isArray(proposal.samples) ? proposal.samples.filter((s) => text(s).trim()).length : 0;
    // Both are required: a count with no samples is an assertion, and samples
    // with no count cannot be checked against the cluster threshold.
    return samples > 0 ? occurrences : 0;
  }
  if (kind === "heal-handoff") {
    // A single escalation IS the event; there is no count to accumulate. It
    // still has to name the tools involved, or there is nothing to act on.
    return Array.isArray(proposal.tools) && proposal.tools.length > 0 ? MIN_EVIDENCE_OCCURRENCES : 0;
  }
  if (kind === "trajectory-playbook") {
    // A drafted skill body. Recognised so its rejection reason is the accurate
    // one — it is held back for review because of its risk, not because it
    // failed to cite anything.
    const samples = Array.isArray(proposal.samples) ? proposal.samples.filter((s) => text(s).trim()).length : 0;
    return text(proposal.content).trim() && samples > 0 ? samples : 0;
  }
  return 0;
}

/**
 * Deterministic admissibility. No model, no network, no clock.
 *
 * `admissible` means: well-formed, evidenced, in-scope, reversible, and free of
 * anything that must not be written to disk. It is a NECESSARY condition for
 * approval, never a sufficient one — the caller still applies the model's veto.
 *
 * @param {Partial<{
 *   target: Partial<{ kind: string, id: string }>,
 *   title: string,
 *   summary: string,
 *   risk: string,
 *   digest: string,
 *   proposal: Record<string, unknown>,
 * }> | null | undefined} candidate
 * @param {{ knownDigests?: Set<string> }} [options]
 * @returns {{ admissible: boolean, reasons: string[], strength: number, promotable: boolean }}
 */
export function admitCandidate(candidate, options = {}) {
  const { knownDigests } = options;
  const reasons = [];
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const target = c.target && typeof c.target === "object" ? c.target : {};
  const kind = text(target.kind);
  const proposal = c.proposal && typeof c.proposal === "object" ? c.proposal : null;

  if (!kind) reasons.push("target_kind_missing");
  if (!text(target.id).trim()) reasons.push("target_id_missing");
  if (!text(c.title).trim()) reasons.push("title_missing");
  if (text(c.title).length > MAX_TITLE) reasons.push("title_too_long");
  if (text(c.summary).length > MAX_SUMMARY) reasons.push("summary_too_long");
  if (!proposal) reasons.push("proposal_missing");

  const risk = text(c.risk);
  if (!["low", "medium", "high"].includes(risk)) reasons.push("risk_unknown");
  // Anything above `low` is a human decision. Auto-admitting a medium-risk
  // self-modification would make "proposal-first" a formality.
  if (risk && risk !== "low") reasons.push(`risk_requires_review:${risk}`);

  const strength = evidenceStrength(proposal);
  if (strength < MIN_EVIDENCE_OCCURRENCES) reasons.push(`evidence_insufficient:${strength}<${MIN_EVIDENCE_OCCURRENCES}`);

  let serialized = "";
  try {
    serialized = JSON.stringify(proposal ?? {});
  } catch {
    reasons.push("proposal_unserializable");
  }
  if (serialized.length > MAX_PROPOSAL_CHARS) reasons.push("proposal_too_large");
  // The proposal is harvested from a session transcript and is redacted on
  // write, but the executor writes it to disk — so this is checked again at the
  // last gate before that write rather than trusted from upstream.
  if (serialized && carriesSecret(serialized)) reasons.push("proposal_contains_secret");
  if (text(c.title) && carriesSecret(text(c.title))) reasons.push("title_contains_secret");

  if (knownDigests instanceof Set && text(c.digest) && knownDigests.has(c.digest)) {
    reasons.push("duplicate_digest");
  }

  return {
    admissible: reasons.length === 0,
    reasons,
    strength,
    // Journal-only kinds are admissible but must never be promoted: the
    // executor has no reversible write path for them.
    promotable: reasons.length === 0 && PROMOTABLE_TARGET_KINDS.includes(kind),
  };
}

/**
 * Combine deterministic admissibility with the model's advisory verdict.
 *
 * The asymmetry is the whole point:
 *  - inadmissible  → rejected, whatever the model said;
 *  - model vetoes  → rejected, however strong the evidence;
 *  - model approves → still only approved if admissible;
 *  - model unusable (unparseable, timed out) → rejected, not approved.
 *
 * A model that cannot be reached therefore blocks self-modification rather than
 * waving it through. That is the safe failure for this decision — the same
 * reasoning as `verify-before-done` being fail-closed.
 *
 * @param {{admissible:boolean,reasons:string[],strength:number,promotable:boolean}} admission
 * @param {{verdict:"approve"|"reject",score:number,rationale:string}|null} verdict
 * @returns {{ decision: "approved"|"rejected", reason: string }}
 */
export function decideCandidate(admission, verdict) {
  if (!admission.admissible) {
    return { decision: "rejected", reason: `inadmissible:${admission.reasons.join(",")}`.slice(0, 2_000) };
  }
  if (!verdict) return { decision: "rejected", reason: "eval_unparseable" };
  if (verdict.verdict !== "approve") {
    return { decision: "rejected", reason: (verdict.rationale || "eval_vetoed").slice(0, 2_000) };
  }
  return { decision: "approved", reason: "" };
}
