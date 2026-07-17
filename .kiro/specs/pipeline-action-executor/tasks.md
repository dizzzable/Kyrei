# Implementation Plan: Pipeline Action Executor (v2.1)

## Overview

Подключение write/verify-половины pipeline **после** закрытия red-team showstopper’ов S1–S3 на уровне дизайна.

Каждая фаза заканчивается verification-gate (`npm run gate` зелёный), где применимо.  
Ссылки `_Требования: N.M_` → `requirements.md` v2.1.

**Порядок безопасный:** config/DAG → data contract → ingress → isolated executors → recovery → gateway activation → e2e.

**Не начинать Фазу 2 (активация write в gateway), пока Фазы 0–1 и S1/S2 unit-тесты не зелёные.**

---

## Tasks

### Фаза 0 — Config + data contract (ещё не активирует write path)

- [x] 0. Pipeline config: checks + multi-action forbid + approval strengthen
  - `pipeline-config.js`: schema/normalize for truth-gate `checks: [{ id, command, ecosystem?, testDigest }]` (`testDigest` frozen at normalize)
  - `definitionViolation`: truth-gate with >1 action ancestor → unsafe (R7)
  - `definitionViolation` / default rules: action must depend on approval that directly consumes a department (R9.2)
  - Update `createDefaultCodingPipeline`:  
    `implementation → approve-implementation → apply-changes → verification → acceptance`
  - Seed default `acceptance.checks` (e.g. detectEcosystem-equivalent explicit npm/tsc if markers assumed, or documented minimal check set)
  - _Требования: 6.3, 6.4, 6.6, 7.1, 9.1, 9.2_

- [x] 1. Types
  - `pipeline/types.ts`: `PatchEvidenceRef` in `EvidenceRef`; `ActionReceipt`; `TruthGateReceipt`
  - `core/engine/index.ts` exports
  - _Требования: 1.1, 3.4_

- [x] 2. Artifact validation for `kind:"patch"` (Вариант D)
  - `artifacts.ts`: `EVIDENCE_KEYS`, evidence-switch, `cloneEvidence`
  - Limits: 64 KB; digest; parsePatch ≥1 op; reject absolute/`..` paths
  - Codes: `pipeline_artifact_patch_invalid`, `pipeline_artifact_patch_too_large`
  - Redaction: reject-not-rewrite only (no new rewrite path)
  - _Требования: 1.2–1.6_

- [x] 2.1* Unit tests — patch evidence
  - valid accept; >64KB reject; digest mismatch; bad path; secret reject; round-trip `createArtifactEnvelope` keeps patch
  - _Требования: 1.2–1.5, 11.4a_

### Фаза 0b — Patch ingress (S1) — без этого action всегда empty

- [x] 2.2 Patch ingress in gateway department artifact builder
  - `gateway.js` `isStructuredPipelineTeamArtifact` / team schema: optional `applicablePatch: string`
  - `pipelineDepartmentArtifact`: map `applicablePatch` → single `PatchEvidenceRef` **without** `pipelineText` collapse
  - Fail stage on invalid patch; preserve legacy path when field absent
  - _Требования: 2.1–2.5_

- [x] 2.3* Unit/integration tests — ingress
  - applicablePatch → envelope has `kind:"patch"`; whitespace in patch preserved; oversized fails; missing field → no patch evidence
  - _Требования: 2.1–2.4, 11.4b_

### Фаза 1 — Executors (isolated; not wired to runner yet)

- [x] 3. `workspace.apply` executor
  - New `pipeline/action-executor.ts`: `executeWorkspaceApply`
  - Flow: baseline observe → extract one patch → verify → `createSnapshotStore` → `applyPatch` → post observe → receipt
  - Codes: `pipeline_action_baseline_mismatch`, `pipeline_action_payload_missing`, `pipeline_action_payload_digest_mismatch`
  - _Требования: 3.1–3.6_

- [x] 3.1* Unit tests — action-executor
  - happy path; baseline mismatch; apply failure rollback + throw (lease not released by executor); abort mid-apply; 0/>1 patch
  - _Требования: 3.1–3.4, 11.4c_

- [x] 4. Trusted test runner + synthetic artifact + policy (S2)
  - New `pipeline/truth-gate-policy.ts` (name flexible):
    - sandboxed command runner (NOT bare `runVerify`)
    - root scan helper for ecosystem markers when needed
    - `buildTruthGateArtifact(...)` synthetic envelope
    - `assembleTruthGatePolicy` from trusted evidence only
    - `executePipelineTruthGate` / `verifyTruthGate` implementation surface
  - `TestEvidenceRef` origin observed; seed digests via `canonicalEvidenceDigest`
  - _Требования: 5.1–5.6, 6.1–6.6, 12.1–12.2_

- [x] 4.1* Unit tests — truth-gate path
  - passed checks → accept; failed test → reject; synthetic inputDigests lineage; reject if someone passes department artifact without synthesis; tampered testDigest pin; stale workspace
  - _Требования: 5.2–5.5, 6.2, 6.4, 11.4d_

- [ ] 4.2* Contract test — `upstreamActionReceiptDigests`
  - Same fixture → runner helper vs store helper → identical sorted lower-case set
  - _Требования: 5.7_

### Фаза 1b — Applied recovery (S3)

- [x] 4.3 Unlock applied resolution with postcondition
  - `gateway.js` `verifyWriteResolutionMarker`: allow `applied` only if observe matches marker and digest ≠ `workspaceDigestBefore` (+ existing freshness/evidence rules)
  - Keep reject for unverifiable claims
  - _Требования: 10.1–10.4_

- [ ] 4.4* Tests — recovery
  - applied + matching digest + changed workspace → accept; applied + same as before → reject; applied + wrong digest → reject
  - _Требования: 10.1–10.2, 11.4g_

### Фаза 2 — Gateway activation (WRITE PATH ON)

- [x] 5. Receipt-trust registries
  - `gateway.js`: `actionReceiptRegistry`, `truthGateReceiptRegistry`
  - Pass `isVerifiedActionReceipt`, `isVerifiedTruthGate` into `PipelineRunStore`
  - _Требования: 4.1–4.2, 8.2_

- [x] 6. Gateway wrappers `executeAction` / `verifyTruthGate` + authorize*
  - Mirror department guards + `sanitizePipelineError`
  - authorize* registers WeakSet
  - Lease lifecycle owned by runner (document; don’t double-release)
  - Approval metadata: include `patchDigest` when requesting approve-implementation when available
  - _Требования: 3.5, 4.3–4.4, 8.3, 8.5, 9.3_

- [x] 7. Wire `PipelineMissionRunner` four callbacks
  - `gateway.js` `new PipelineMissionRunner({ ..., executeAction, verifyTruthGate, authorizeActionReceipt, authorizeTruthGateReceipt })`
  - _Требования: 8.1, 8.4_

### Фаза 3 — E2E + red-team implementation

- [x] 8. End-to-end mission test
  - Fixture: impl (with applicablePatch) → approve → action → verification dept → truth-gate
  - Assert: files changed in temp workspace; mission completes; unverified receipt rejected by store
  - Covered by `tests/pipeline-action-e2e.test.ts` (happy path) + gateway fail-closed without patch
  - _Требования: 11.4e, 11.4h_

- [ ] 8.1 Red-team review of implementation
  - Sub-agent focus: jail bypass via patch; secret leak in receipt; lease race; abort between apply and receipt; fake observed evidence; multi-action config; bare runVerify regression
  - _Требования: 11.1, 11.2, 11.5_

- [x] 9. Verification gate
  - `npm run gate` green (2026-07-16: typecheck engine+renderer, check:js, check:i18n, 1164 tests)
  - _Требования: 11.3_

---

## Implementation notes (do not skip)

1. **S1 before e2e:** types without ingress = dead feature.
2. **S2 synthesis is mandatory:** never `evaluateTruthGate(departmentArtifact, policy)` alone.
3. **Sandbox:** production test exec must go through jail+sandbox path; treat bare `runVerify` as non-compliant.
4. **Default DAG** must get `approve-implementation` or H1 remains open.
5. **LOC:** budget ~1200+ with tests (not 450).
6. Prefer searching symbols (`PipelineMissionRunner`, `pipelineDepartmentArtifact`) over brittle line numbers.

---

## Out of scope (explicit)

- Debate-between-teams (Variant B)
- Postgres mission store (Variant C)
- Multi-action truth-gate policy array (deferred; config forbids topology instead)
- Full approval UI polish (engine stores digest; UI checklist item)
- OpenViking / planning-as-files
