# Requirements Document: Pipeline Action Executor + Truth-Gate Wiring

**Spec version:** v2.1 (post final red-team)

## Introduction

Kyrei уже имеет durable pipeline control-plane (state-machine, DAG, journaled store, team departments) и truth-gate domain-логику (`evaluateTruthGate`). Write/verify половина цикла **не подключена**: `PipelineMissionRunner` создаётся без `executeAction` / `verifyTruthGate` / `authorizeActionReceipt` / `authorizeTruthGateReceipt`, а `PipelineRunStore` — без `isVerifiedActionReceipt` / `isVerifiedTruthGate` (дефолт `() => false`).

Цель — довести Variant A («implement применяет код, tester/gate верифицирует») до **end-to-end** рабочего состояния: безопасно, детерминированно, обратимо.

### Principles

- **Один писатель:** department-роли read-only; пишет только детерминированный action-executor (без LLM).
- **Обратимость:** apply через `applyPatch` + snapshot/rollback; при ошибке lease **не** освобождается (quarantine).
- **Доверенные receipts:** completion write/verify только для объектов в gateway WeakSet registry.
- **Артефакт = аудит:** сырой патч — bounded evidence kind; модельный транскрипт не становится истиной.
- **Fail-closed:** неоднозначность → block/fail/uncertain, никогда «успех по умолчанию».
- **Observed ≠ claimed:** `origin:"observed"` для тестов производит **только** gateway trusted runner; LLM-артефакт не является входом gate as-is.

## Glossary

- **action-этап** — детерминированная запись (`action: "workspace.apply"`).
- **truth-gate** — completion gate на **synthetic** verification envelope + trusted policy.
- **actionReceipt** — квитанция apply: digests + timestamp (+ audit fields).
- **PatchEvidenceRef** — `kind:"patch"` evidence с raw patch + digest.
- **patch ingress** — путь team `applicablePatch` → department envelope (S1).
- **synthetic truth-gate artifact** — envelope, собранный verifier'ом из trusted runner (S2).
- **receipt registry** — WeakSet, куда `authorize*Receipt` кладёт object reference.

---

## Requirements

### Requirement 1: Патч как evidence kind (Вариант D)

**User Story:** Как оркестратор, я хочу применимый патч в валидируемом evidence, чтобы executor применил его без LLM.

#### Acceptance Criteria

1. THE SYSTEM SHALL add `PatchEvidenceRef { kind:"patch", patch:string, patchDigest:string }` to `EvidenceRef` (extends `EvidenceRefBase`).
2. WHEN evidence has `kind:"patch"` THE SYSTEM SHALL validate: `patchDigest === sha256(patch)`; `parsePatch(patch)` yields ≥1 op; paths are not absolute and contain no `..` segments; else reject `pipeline_artifact_patch_invalid` (data error, not crash).
3. THE SYSTEM SHALL reject patches with `Buffer.byteLength(patch,"utf8") > 65536` via `pipeline_artifact_patch_too_large`.
4. THE SYSTEM SHALL treat secret hits as **reject-not-rewrite** (preserve digest integrity; existing sensitive gate).
5. THE SYSTEM SHALL clone `patch`/`patchDigest` in `cloneEvidence` / `createArtifactEnvelope` so rebuild does not drop the payload.
6. WHERE an artifact has no patch evidence THE SYSTEM SHALL remain valid (backward compatible). Full workspace-root jail MAY be deferred to apply-time (`validateWriteTarget`).

---

### Requirement 2: Patch ingress from implementation department (S1)

**User Story:** Как implementation-команда, я хочу передать raw patch в pipeline-артефакт, иначе evidence kind бесполезен.

#### Acceptance Criteria

1. THE SYSTEM SHALL accept optional `applicablePatch: string` on structured team artifact **without** routing it through whitespace-collapsing `pipelineText`.
2. WHEN `applicablePatch` is present THE SYSTEM SHALL produce **exactly one** `PatchEvidenceRef` on the department envelope (`origin:"reported"`, stable id e.g. `applicable-patch`, `workspaceDigest` = run checkpoint when available).
3. WHEN `applicablePatch` fails size/parse/path/secret checks THE SYSTEM SHALL fail the department stage with a clear pipeline error (no partial silent drop).
4. WHEN `applicablePatch` is absent THE SYSTEM SHALL keep legacy diagnostic-only evidence behavior.
5. THE SYSTEM SHALL NOT force patch evidence into `kind:"diagnostic"`.

---

### Requirement 3: Deterministic action-executor (`workspace.apply`)

**User Story:** Как пользователь, я хочу обратимое применение патча без LLM.

#### Acceptance Criteria

1. WHEN an action stage runs THE SYSTEM SHALL observe workspace and require digest === `stage.workspaceDigestBefore` else fail `pipeline_action_baseline_mismatch`.
2. THE SYSTEM SHALL extract exactly one upstream `kind:"patch"` evidence and apply via `applyPatch` + `createSnapshotStore` + abort signal.
3. WHEN apply throws THE SYSTEM SHALL NOT release the workspace lease (runner quarantine) and SHALL fail the stage with a reproducible reason.
4. WHEN apply succeeds THE SYSTEM SHALL return `actionReceipt` with `workspaceDigest`, `workspaceDigestBefore`, `observedAt`, `patchDigest`, `appliedFiles` (exact shape; no LLM).
5. THE SYSTEM SHALL use the same pre/post runtime guards pattern as department execution (`assertPipelineRuntimeCurrent` / checkpoint / abort) at the gateway wrapper layer.
6. 0 or >1 patch evidence → `pipeline_action_payload_missing`. Digest mismatch → `pipeline_action_payload_digest_mismatch`.

---

### Requirement 4: Trusted receipt registries

**User Story:** Как store, я принимаю completion write/verify только для gateway-verified receipt objects.

#### Acceptance Criteria

1. THE SYSTEM SHALL create `actionReceiptRegistry` and `truthGateReceiptRegistry` WeakSets in gateway (mirror resolution registry).
2. THE SYSTEM SHALL pass `isVerifiedActionReceipt` / `isVerifiedTruthGate` into `PipelineRunStore`.
3. WHEN `authorizeActionReceipt` / `authorizeTruthGateReceipt` run THE SYSTEM SHALL register the exact object reference before store update.
4. THE SYSTEM SHALL only authorize receipts produced on the deterministic executor/verifier path (never raw model JSON as receipt).

---

### Requirement 5: Truth-gate policy + synthetic artifact (S2)

**User Story:** Как acceptance gate, я принимаю изменения только по наблюдаемым тестам, а не по заявлению модели.

#### Acceptance Criteria

1. WHEN truth-gate runs THE SYSTEM SHALL run a gateway-owned trusted test runner and build `observedEvidenceDigests` **only** from its `TestEvidenceRef` (`origin:"observed"`) via `canonicalEvidenceDigest`.
2. THE SYSTEM SHALL **not** call `evaluateTruthGate` on the verification department envelope as-is.
3. THE SYSTEM SHALL build a **synthetic** `ArtifactEnvelope` (`kind:"verification"`, `producerId` gateway-owned) whose: `evidence`/`checks`/`claims` bind to trusted test evidence; `inputDigests` equals the action receipt digest set used for lineage; `workspaceDigest` equals current `observeWorkspace`.
4. THE SYSTEM SHALL call `evaluateTruthGate(synthetic, policy)` and complete only if `decision.accepted === true`.
5. WHEN rejected THE SYSTEM SHALL fail with `decision.issues` (including reported-only / untrusted paths if mis-built).
6. WHEN accepted THE SYSTEM SHALL return `truthGateReceipt = { workspaceDigest, observedAt, actionReceiptDigests }` where `actionReceiptDigests` is the sorted unique copy of the runner-supplied set (store equality).
7. THE SYSTEM SHALL keep runner vs store `upstreamActionReceiptDigests` in contract tests (case-normalized).

---

### Requirement 6: Trusted test runner (keystone)

**User Story:** Как система, я хочу, чтобы «тесты прошли» было фактом gateway-кода.

#### Acceptance Criteria

1. THE SYSTEM SHALL execute required checks under workspace jail + sandbox + sanitized env (same class of controls as `run_command`). THE SYSTEM SHALL NOT use bare unsandboxed `runVerify` as the production path.
2. THE SYSTEM SHALL emit `TestEvidenceRef` with `origin:"observed"`, `passed`, `exitCode`, `testDigest`, `outputDigest`, `workspaceDigest`, `command`, `cwd`, `checkId`.
3. THE SYSTEM SHALL load required checks from **stage config** (`stage.checks`), with `testDigest` frozen at config normalize time.
4. THE SYSTEM SHALL reject config pin mismatch with `pipeline_truth_gate_test_definition_tampered`.
5. THE SYSTEM SHALL run the runner **inside** `verifyTruthGate` (no new state-machine stage kind).
6. Root marker scan for optional ecosystem defaults SHALL be explicit (readdir workspace root → `detectEcosystem`); preferred path is explicit `checks` on the default pipeline.

---

### Requirement 7: Multi-action lineage policy (H5)

**User Story:** Как конфигуратор, я не хочу неоднозначного scalar `requiredActionDigest` при нескольких action-предках.

#### Acceptance Criteria

1. THE SYSTEM SHALL reject pipeline definitions where a truth-gate has more than one action-stage ancestor in its dependsOn closure (`definitionViolation` / unsafe transition).
2. THE SYSTEM SHALL set `policy.requiredActionDigest` to the single upstream action receipt digest for v1.
3. Extending `TruthGatePolicy` to multiple digests is OUT OF SCOPE for this spec version.

---

### Requirement 8: Gateway wiring

**User Story:** Как разработчик, я хочу атомарно закрыть оба half-gaps runner+store.

#### Acceptance Criteria

1. THE SYSTEM SHALL pass `executeAction`, `verifyTruthGate`, `authorizeActionReceipt`, `authorizeTruthGateReceipt` into `PipelineMissionRunner`.
2. THE SYSTEM SHALL pass both `isVerified*` predicates into `PipelineRunStore`.
3. Gateway wrappers SHALL mirror department error sanitization and runtime guards.
4. Department/approval execution paths SHALL remain behavior-compatible except intentional default-DAG and patch-ingress additions.
5. Lease: acquire before apply; release on success; quarantine (no release) on failure.

---

### Requirement 9: Human approval of implementation patch (H1)

**User Story:** Как владелец кода, я хочу одобрить именно implementation-diff, а не только план.

#### Acceptance Criteria

1. THE SYSTEM SHALL change `createDefaultCodingPipeline` so an **approval stage depends on implementation** and **action depends on that approval** (not implementation→action directly).
2. THE SYSTEM SHALL strengthen validation so each action stage has an approval dependency that directly consumes a department stage (blocks plan-only transitive approval as the sole gate before write).
3. Approval records SHOULD include `patchDigest` (and file list when available) for audit; UI display is checklisted at implement time.

---

### Requirement 10: Applied write recovery (S3)

**User Story:** Как оператор, после crash post-apply pre-receipt я хочу детерминированно закрыть stage как applied, не гадая.

#### Acceptance Criteria

1. THE SYSTEM SHALL allow `verifyWriteResolutionMarker` `outcome:"applied"` only when current `observeWorkspace` matches marker digest AND digest ≠ `stage.workspaceDigestBefore` (actual change) AND existing freshness/workspace evidence checks pass.
2. THE SYSTEM SHALL continue to reject free-form applied claims without matching workspace observation.
3. `retry` / `abandoned` paths SHALL remain available under existing rules.
4. Successful applied resolution SHALL remain usable as action lineage for truth-gate (existing store behavior for resolution→actionReceipt).

---

### Requirement 11: Security and verification

**User Story:** Как владелец, я хочу jail, tests, и отсутствие secret leakage.

#### Acceptance Criteria

1. THE SYSTEM SHALL apply patches only through `applyPatch`/`validateWriteTarget` jail.
2. THE SYSTEM SHALL not weaken config rules requiring approval lineage and downstream truth-gate for action stages.
3. THE SYSTEM SHALL pass `npm run gate`.
4. THE SYSTEM SHALL have tests for: (a) patch evidence validate + round-trip; (b) patch ingress; (c) action-executor happy/fail/quarantine; (d) synthetic truth-gate accept/reject; (e) registry rejection of unverified receipts; (f) multi-action config reject; (g) applied recovery postcondition; (h) e2e mission department→approve→action→verify dept→truth-gate.
5. THE SYSTEM SHALL secret-redact receipts/errors/artifacts channels; patch body reject-not-rewrite on sensitive content.

---

### Requirement 12: Verification department advisory role

**User Story:** Как архитектор, я отделяю «мнение команды» от «факта runner'а».

#### Acceptance Criteria

1. THE SYSTEM SHALL treat verification department output as non-authoritative for observed test evidence.
2. THE SYSTEM MAY copy uncertainties/unchecked into synthetic summary notes but SHALL NOT trust department `origin:"observed"` claims for gate policy.
3. Default DAG MAY keep the verification department stage for human-readable inspection.

---
