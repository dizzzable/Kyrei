# Design Document

**Spec version:** v2.1 (post final red-team)  
**Status:** design ready for implementation after S1–S3 closed on paper

## Overview

Этот документ проектирует **подключение write/verify-половины pipeline** — action-executor (`workspace.apply`) и truth-gate verifier — которые уже написаны на уровне домена, но не соединены с gateway.

Незыблемый принцип: **read-only команда решает ЧТО менять; детерминированный executor (без LLM) ПРИМЕНЯЕТ изменение.** Это разделение уже заложено в дизайн (команды заклампованы read-only), и мы его сохраняем.

### Карта гэпа (v2.1 — после red-team)

| # | Точка | Файл | Что нужно |
|---|-------|------|-----------|
| 1 | Evidence kind для патча | `pipeline/types.ts`, `artifacts.ts` | `PatchEvidenceRef` в `evidence[]` (Вариант D) |
| 2 | **Patch ingress (S1)** | `gateway.js` `pipelineDepartmentArtifact` | Команда может положить raw patch → `kind:"patch"` |
| 3 | `workspace.apply` executor | `pipeline/action-executor.ts` (новый) | Применить патч, собрать receipt |
| 4 | Receipt-trust registries | `gateway.js` ~1902 | WeakSet для action/truth-gate receipts |
| 5 | **Truth-gate synthesis (S2)** | `pipeline/truth-gate-policy.ts` (новый) | Trusted runner + **synthetic** envelope + policy |
| 6 | Runner wiring | `gateway.js` ~3390 | 4 callback'а в `PipelineMissionRunner` |
| 7 | Config: checks / testDigest | `pipeline-config.js` | `stage.checks` + schema/normalize |
| 8 | **Applied recovery (S3)** | `gateway.js` `verifyWriteResolutionMarker` | Unlock `outcome:"applied"` с postcondition |
| 9 | Approve-patch (H1) | `pipeline-config.js` default DAG | Approval **после** implementation, до apply |

### Поток данных (целевой, v2.1)

```
implementation department (read-only, любой провайдер)
  → team result.applicablePatch (raw string, без whitespace-collapse)
  → pipelineDepartmentArtifact:
        summary + reported diagnostics
        + ровно один PatchEvidenceRef { kind:"patch", patch, patchDigest, origin:"reported" }
    → approve-implementation (человек видит summary + patch preview/digest)
      → workspace.apply executor (детерминированный, без LLM)
          - observeWorkspace() = baseline == stage.workspaceDigestBefore
          - извлечь ровно один kind:"patch" из upstream department-артефакта
          - parsePatch() → createSnapshotStore → applyPatch()
          - observeWorkspace() post
          - actionReceipt { workspaceDigest, workspaceDigestBefore, observedAt, patchDigest, appliedFiles }
          - authorizeActionReceipt → WeakSet
        → verification department (read-only, inspect-only: summary/claims, НЕ источник truth)
          → department-артефакт (reported diagnostics; checks могут быть пустыми)
            → truth-gate verifier (gateway-owned, детерминированный)
                1. trusted test runner (sandbox + jail) → TestEvidenceRef origin:"observed"
                2. buildTruthGateArtifact(...) — SYNTHETIC envelope:
                     - evidence/checks из trusted runner
                     - inputDigests = actionReceiptDigests (lineage)
                     - workspaceDigest = current observe
                     - optional: non-blocking notes from verification department
                3. assembleTruthGatePolicy from TRUSTED digests (не из LLM-артефакта)
                4. evaluateTruthGate(syntheticArtifact, policy)
                5. authorizeTruthGateReceipt → WeakSet
              → acceptance (mission complete)
```

**Ключевое отличие v2.1:** verification department **не** производит observed-доказательства и **не** является входом `evaluateTruthGate` as-is. Gate всегда оценивает **synthetic** envelope, собранный verifier'ом.

---

## Design Decision 1: Где живёт патч (Вариант D)

### Проблема

`ArtifactEnvelope` по дизайну несёт дайджесты и summary, не сырой контент. Патчу негде жить без нового канала.

### Отклонённый Вариант A

Top-level `actionPayload` **уничтожается** в 4–6 местах: `rejectUnknownKeys` (`artifacts.ts` ROOT), `createArtifactEnvelope` allowlist rebuild, `exactKeys` / `validPersistedArtifactEnvelope` в `pipeline-run-store.js`.

### Решение: Вариант D — `PatchEvidenceRef` в `evidence[]`

- `evidence[]` уже allowlisted (`ROOT_KEYS`, store root keys).
- JS store проверяет evidence-элементы только как `plainRecord` → **0 правок** `pipeline-run-store.js` для shape.
- `canonicalEvidenceDigest` хеширует весь объект evidence.

### Форма

```typescript
export interface PatchEvidenceRef extends EvidenceRefBase {
  readonly kind: "patch";
  readonly patch: string;       // context-anchored (parse-patch.ts), ≤ 64 KB utf8
  readonly patchDigest: string; // sha256(patch)
}
// origin: "reported" — предложен командой, не применён
```

### Инварианты (evidence-switch в `artifacts.ts`)

1. `Buffer.byteLength(patch, "utf8") <= 65536` → иначе `pipeline_artifact_patch_too_large`.
2. `patchDigest === sha256(patch)`.
3. `parsePatch(patch)` успешен и возвращает ≥1 file op; иначе `pipeline_artifact_patch_invalid`.
4. Пути: reject absolute (`/`, `C:\`, UNC) и `..` segments на границе (pure validator **не** знает workspace root). Полный jail — в `applyPatch` / `validateWriteTarget`.
5. Redaction = **reject-not-rewrite** (существующий `canonicalArtifactEnvelope` gate). Не rewrite patch body.
6. Ровно один `kind:"patch"` на implementation-артефакт, ведущий к action (enforced в executor; producer тоже enforce).

### Точные правки types/artifacts

1. `types.ts` — `PatchEvidenceRef` + union `EvidenceRef`.
2. `artifacts.ts` `EVIDENCE_KEYS` — `"patch"` + keys `patch`, `patchDigest`.
3. `artifacts.ts` evidence-switch — case `"patch"`.
4. `artifacts.ts` `cloneEvidence` — case `"patch"` (иначе rebuild выбросит body).

---

## Design Decision 1b: Patch ingress (S1) — **showstopper fix**

### Проблема (red-team S1)

Даже с Вариантом D патч **никогда не попадёт** в envelope: `pipelineDepartmentArtifact` принимает только short text lists, гоняет их через `pipelineText` (whitespace collapse + truncate ≤1000) и форсит `kind:"diagnostic"`, `origin:"reported"`.

### Решение

Расширить structured team result **только для implementation-стадий** (или когда payload присутствует):

```typescript
// team structured output (дополнительное опциональное поле)
{
  artifact: {
    summary: string,
    evidence: string[],      // как сейчас — reported diagnostics
    // ...
    applicablePatch?: string // NEW: raw multi-line patch, НЕ через pipelineText
  }
}
```

В `pipelineDepartmentArtifact`:

1. Если `applicablePatch` отсутствует / пуст → behavior as today (no patch evidence). Action later fails with `pipeline_action_payload_missing` if required.
2. Если присутствует:
   - **Не** вызывать `pipelineText` / whitespace collapse на patch body.
   - Проверить size ≤ 64 KB utf8.
   - `parsePatch` + path safety (absolute/`..`).
   - Secret scan: если redact изменил бы body → fail `pipeline_artifact_sensitive_value` / reject envelope (reject-not-rewrite).
   - Добавить **ровно один** evidence:
     ```ts
     {
       id: "applicable-patch",
       kind: "patch",
       origin: "reported",
       summary: `patch files: ${fileList.join(", ")}`.slice(0, ...),
       capturedAt,
       workspaceDigest: run.workspaceCheckpointDigest,
       patch,
       patchDigest: sha256(patch),
     }
     ```
3. Обычные text evidence остаются diagnostic/reported (как сейчас).
4. Team schema validation (`isStructuredPipelineTeamArtifact`) — `applicablePatch` optional string; max length checked at producer, not via 1000-char text list.

**Файлы:** `gateway.js` (`pipelineDepartmentArtifact`, schema helpers). При необходимости — team tool/schema docs, чтобы implementation-роль знала поле.

---

## Design Decision 2: `workspace.apply` executor

### Сигнатура

```typescript
async function executeWorkspaceApply(input: {
  run: PipelineRunState;
  stage: PipelineStageState;
  dependencyArtifacts: Record<string, ArtifactEnvelope[]>;
  signal: AbortSignal;
  lease: WorkspaceLease;
}): Promise<{ actionReceipt: ActionReceipt }>;
```

### Поток

1. `throwIfAborted(signal)`.
2. Baseline: `observeWorkspace(run.workspace)` === `stage.workspaceDigestBefore` else `pipeline_action_baseline_mismatch`.
3. Найти upstream department-артефакты в `dependencyArtifacts`; среди evidence — **ровно один** `kind:"patch"`. 0 или >1 → `pipeline_action_payload_missing`.
4. Verify: `patchDigest === sha256(patch)`, `parsePatch`, path safety; optional `evidence.workspaceDigest === baseline` if present.
5. `createSnapshotStore(workspace)` → `applyPatch(workspace, parsed, snapshot, signal)`.
6. Post: `observeWorkspace` → receipt.
7. Return `{ actionReceipt }`.

### ActionReceipt

```typescript
{
  workspaceDigest,           // post-apply, 64-hex
  workspaceDigestBefore,     // === stage.workspaceDigestBefore
  observedAt,                // ISO from observeWorkspace
  patchDigest,               // audit
  appliedFiles,              // rel paths from ApplyReport
}
```

Store сегодня валидирует минимум: `workspaceDigest`, `workspaceDigestBefore`, `observedAt`. Extra fields входят в `digestValue(receipt)` — фиксируем exact shape в executor (не добавлять произвольные ключи).

### Lease

- Успех: runner `updateStage(completed)` + `release` lease.
- Ошибка: runner **не** release (quarantine) — executor только throws.
- Abort mid-apply: `applyPatch` + snapshot rollback; no receipt → stage fail/uncertain path.

### Идемпотентность

Action `maxAttempts === 1` (config). Повторный apply одного патча не предусмотрен. Crash mid-write → S3 recovery.

---

## Design Decision 3: Receipt-trust registries (WeakSet)

Паттерн зеркалит `resolutionReceiptRegistry` (`gateway.js` ~1898):

```typescript
const actionReceiptRegistry = new WeakSet<object>();
const truthGateReceiptRegistry = new WeakSet<object>();
const isVerifiedActionReceipt = (r) =>
  typeof r === "object" && r !== null && actionReceiptRegistry.has(r);
const isVerifiedTruthGate = (r) =>
  typeof r === "object" && r !== null && truthGateReceiptRegistry.has(r);
```

Передать в `new PipelineRunStore({ ..., isVerifiedActionReceipt, isVerifiedTruthGate })`.

`authorizeActionReceipt` / `authorizeTruthGateReceipt` добавляют **тот же object reference**, который затем уходит в `updateStage` (до `canonicalReceipt` clone внутри store — `isVerified*` проверяется **до** clone).

---

## Design Decision 4: Truth-gate — trusted runner + synthetic artifact (S2)

### Проблема (red-team S2)

`evaluateTruthGate(artifact, policy)` требует:

- `checks[]` с required ids, `status:"passed"`, `evidenceIds`;
- evidence objects с ids ∈ `policy.observedEvidenceDigests` и `canonicalEvidenceDigest` match;
- `inputDigests` includes `requiredActionDigest` (action **receipt** digest, not dependency artifact hash);
- `workspaceDigest` match.

Текущий `pipelineDepartmentArtifact` всегда: `checks:[]`, diagnostic reported, `inputDigests = digestJson(dependency artifacts)`.  
Вызов gate на LLM-артефакте **всегда fail** даже с честным runner «сбоку».

### Решение: Option (b) + **synthetic envelope**

Verifier `executePipelineTruthGate` **не** передаёт department-артефакт в `evaluateTruthGate` as-is.

```
1. throwIfAborted
2. actionReceiptDigests = input.actionReceiptDigests (from runner; must be non-empty)
3. workspace = observeWorkspace(run.workspace)
4. requiredChecks + testDigests from stage.checks (config)
5. Trusted test runner → TestEvidenceRef[] (origin observed)
6. synthetic = buildTruthGateArtifact({
     run, stage, workspace, actionReceiptDigests,
     trustedEvidence, requiredChecks, testDigests,
     // optional notes from verification department for summary only
     departmentNotes?: dependencyArtifacts
   })
7. policy = {
     workspaceDigest: workspace.digest,
     requiredActionDigest: actionReceiptDigests[0], // see DD4b — single-action only in v1
     requiredChecks,
     observedEvidenceDigests: map id → canonicalEvidenceDigest(ev),
     testDigests,
   }
8. decision = evaluateTruthGate(synthetic, policy)
9. if !accepted → fail with issues
10. truthGateReceipt = { workspaceDigest, observedAt, actionReceiptDigests: sorted unique copy of input }
```

### `buildTruthGateArtifact` contract

```typescript
{
  schemaVersion: 1,
  id: `truth-gate:${run.id}:${stage.id}:${...}`,
  kind: "verification",
  runId, stageId,
  producerId: "kyrei:trusted-test-runner",
  createdAt, summary: "Trusted verification (gateway-owned).",
  workspaceDigest: workspace.digest,
  inputDigests: actionReceiptDigests,  // lineage — CRITICAL
  assumptions: [],
  uncertainties: [], // may copy non-authoritative notes from department
  unchecked: [],
  provenance: { providerId: "kyrei", modelId: "none", policyDigest: run.runtimeFingerprint or fixed },
  metrics: { zeros or runner timing },
  claims: [{ id: "claim-tests", statement: "Required checks passed.", evidenceIds: [...] }],
  evidence: trusted TestEvidenceRef[],
  checks: requiredChecks.map(id => ({
    id, status: passed ? "passed" : "failed",
    evidenceIds: [matching evidence id],
    workspaceDigest: workspace.digest,
    testDigest: testDigests[id],
  })),
  contradictions: [],
}
```

If any required check failed in runner → synthetic still built with `status:"failed"` → gate rejects (`required_check_not_passed`) — fail closed, no short-circuit that skips evaluate.

### Verification department role (v2.1)

- **Inspect-only / advisory:** summary, uncertainties, whatWasNotChecked.
- **Not** a source of `origin:"observed"` test evidence.
- Remains in default DAG (human-readable report, future debate hooks).
- May be skipped in future config; not required for gate correctness.

---

## Design Decision 4b: Multi-action lineage (H5) — **решение**

`TruthGatePolicy.requiredActionDigest` сегодня **scalar**; `evaluateTruthGate` checks single digest in `inputDigests`.

**v1 decision: forbid multiple action ancestors** for one truth-gate in `pipeline-config` `definitionViolation`:

- if `upstream action count > 1` along dependsOn closure → `pipeline_transition_unsafe` (or dedicated code).
- Default coding pipeline has exactly one action → OK.
- Extending policy to `requiredActionDigests[]` deferred (would need `truth-gate.ts` change + migration).

Receipt still carries **full** `actionReceiptDigests` list (store requires exact set match with `upstreamActionReceiptDigests`). For the single-action case, list length is 1 and `requiredActionDigest === that one`.

Contract test: runner `upstreamActionReceiptDigests` vs store version — same set (normalize lower-case).

---

## Design Decision 5: Trusted Test Runner (keystone)

### Reuse (glue, not new subsystem)

| Block | Location | Role |
|-------|----------|------|
| `observeWorkspace` | `workspace-evidence.js` | workspace digest |
| `detectEcosystem` | `verify.ts` | suggest commands from root markers |
| Ecosystem root scan | new small helper | `readdir` workspace root → marker filenames for `detectEcosystem` |
| Sandboxed command exec | **not bare `runVerify`** | jail + `maybeSandbox` + `sanitizeEnv` (mirror `run_command`) |
| `canonicalEvidenceDigest` | `artifacts.ts` | trusted digests |
| `evaluateTruthGate` | `truth-gate.ts` | accept/reject |

**Red-team H3:** `runVerify` uses `spawn({ shell: true })` **without** sandbox. Spec forbids calling bare `runVerify` as production path. Either:

- wrap spawn with `maybeSandbox` + workspace cwd jail, or  
- extract shared `runTrustedCommand({ command, cwd, sandbox, signal, timeout })` used by runner.

`detectEcosystem` remains pure command suggestion; actual exec always sandboxed.

### testDigest provenance

```typescript
testDigest = sha256(canonicalJson({ ecosystem, command, cwdPolicy: "workspace-root" }))
```

Stored in `stage.checks[checkId] = { command, ecosystem?, testDigest }` (normalized at config load).  
Runner recomputes from config command (not from mutable package.json alone for the digest identity — command string is pinned in config).  
If workspace `package.json` scripts change after config pin, exec may still run dangerous script content — **mitigated by sandbox/jail**, and by approve-patch (human saw intended change). Optional future: pin script body hash.

Mismatch → `pipeline_truth_gate_test_definition_tampered` only when **config pin** ≠ recomputed pin (config mutation), not when npm script body drifts (that's sandbox residual risk, documented).

### stage.checks schema (`pipeline-config.js`)

```javascript
// on truth-gate stage (and optionally defaults)
checks: [
  { id: "unit", command: "npm test --silent", ecosystem: "node" },
  // testDigest computed at normalize time and frozen
]
```

If `checks` empty on truth-gate → violation or fallback: run `detectEcosystem` once at normalize and freeze resulting commands into checks (deterministic snapshot). **Prefer explicit checks in default pipeline** after implement.

---

## Design Decision 6: Approve-patch (H1)

### Проблема

`createDefaultCodingPipeline` approves **plan** only. Action is allowed because plan-approval is ancestor (`everyInboundPathApproved`). Human **never** sees implementation patch before write.

### Решение

Default DAG change:

```
... → implementation → approve-implementation (approval) → apply-changes (action) → verification → acceptance (truth-gate)
```

- `approve-implementation.dependsOn = ["implementation"]`
- `apply-changes.dependsOn = ["approve-implementation"]`
- Approval UI/payload **must** surface: artifact summary, `patchDigest`, file list from parsePatch, and patch body (or bounded preview + full in detail view). Exact UI is outside engine; gateway approval record should store `patchDigest` in reason/metadata for audit.

Residual risk if custom pipelines omit post-impl approval: config rule already requires *some* approval on every inbound path since last truth-gate — document that plan-only approval is weaker; **recommend** approval directly consuming implementation department (already partially encouraged by approval rules).

Optional strengthen (v1.1): definitionViolation — action's **direct** dependency must include an approval that directly consumes a department (not only transitive plan approval). **v2.1 adopts this strengthen:**

- For `kind:"action"`, at least one node on every inbound path since last truth-gate is approval, **and** there exists a direct dependency chain `department → approval → action` (approval directly depends on department; action directly or through only non-department? **Simpler rule:** action.dependsOn must include an approval stage that has a department in its dependsOn).

Implement as: `action.dependsOn` contains an `approval` stage whose `dependsOn` intersects a `department` that is an ancestor producing patch (implementation). Default DAG satisfies.

---

## Design Decision 7: Applied write recovery (S3)

### Проблема

`verifyWriteResolutionMarker` **always** rejects `outcome:"applied"` (`pipeline_write_outcome_unverifiable`). Crash after successful apply, before receipt → permanent quarantine with no legal applied close.

### Решение

Unlock `applied` only when **all** hold:

1. `marker.outcome === "applied"`.
2. `observeWorkspace().digest === marker.workspaceDigest`.
3. `marker.workspaceDigest !== stage.workspaceDigestBefore` (workspace actually changed — or allow equal only if patch was pure no-op which apply already rejects).
4. Marker includes evidence entry `{ type: "workspace", digest }` matching observation.
5. Optional but recommended: marker includes `patchDigest` matching the upstream implementation patch evidence (if still available on run artifacts).
6. Freshness windows (existing stale checks) still apply.
7. **Not** sufficient: human free-text claim without matching digest.

On success, existing store path that sets `actionReceipt` from resolution marker remains the durable receipt for truth-gate lineage.

`retry` / `abandoned` paths unchanged.

---

## Data Models

```typescript
// types.ts
export interface PatchEvidenceRef extends EvidenceRefBase {
  readonly kind: "patch";
  readonly patch: string;
  readonly patchDigest: string;
}

export interface ActionReceipt {
  readonly workspaceDigest: string;
  readonly workspaceDigestBefore: string;
  readonly observedAt: string;
  readonly patchDigest: string;
  readonly appliedFiles: readonly string[];
}

export interface TruthGateReceipt {
  readonly workspaceDigest: string;
  readonly observedAt: string;
  readonly actionReceiptDigests: readonly string[]; // sorted, unique, lower-case hex
}
```

## Files

| File | Change |
|------|--------|
| `core/engine/pipeline/types.ts` | `PatchEvidenceRef`, receipts |
| `core/engine/pipeline/artifacts.ts` | EVIDENCE_KEYS + switch + cloneEvidence |
| `core/engine/pipeline/action-executor.ts` | **new** `executeWorkspaceApply` |
| `core/engine/pipeline/truth-gate-policy.ts` | **new** runner + `buildTruthGateArtifact` + policy + verify wrapper |
| `core/engine/index.ts` | exports |
| `core/gateway.js` | patch ingress; registries; wrappers; runner wiring; applied recovery; approval metadata |
| `core/pipeline-config.js` | checks schema; default DAG approve-implementation; multi-action forbid; action↔approval strengthen |
| `core/pipeline-run-store.js` | **no shape change** for artifacts (Variant D) |
| tests | unit + contract + e2e mission |

## Error codes

| Code | When |
|------|------|
| `pipeline_artifact_patch_invalid` | parse/path safety fail |
| `pipeline_artifact_patch_too_large` | > 64 KB |
| `pipeline_action_baseline_mismatch` | workspace drifted before apply |
| `pipeline_action_payload_missing` | 0 or >1 patch evidence |
| `pipeline_action_payload_digest_mismatch` | patchDigest mismatch |
| `pipeline_truth_gate_test_definition_tampered` | config testDigest pin mismatch |
| `pipeline_truth_gate_action_lineage_invalid` | existing — missing action digests |

Existing: `action_executor_unavailable`, `truth_gate_verifier_unavailable`, `pipeline_action_receipt_required`, `pipeline_truth_gate_receipt_invalid`, `pipeline_write_outcome_unverifiable` (narrowed).

## Size estimate (honest, v2.1)

| Area | LOC (approx) |
|------|----------------|
| types + artifacts patch kind | ~80 |
| patch ingress gateway | ~100 |
| action-executor | ~150 |
| trusted runner + synthetic + policy | ~250 |
| config checks + DAG | ~120 |
| applied recovery | ~40 |
| wiring registries/callbacks | ~80 |
| tests | ~400+ |
| **Total** | **~1200+ MEDIUM–LARGE** |

Not ~450 — red-team corrected optimism.

## Compatibility

- Artifacts without patch evidence unchanged.
- Department/approval paths unchanged except default DAG + optional `applicablePatch`.
- Pipelines without action/truth-gate unchanged.
- Custom pipelines with multi-action→one gate become invalid at config normalize (explicit).

## Security residual risks (accepted)

1. Sandbox escape is sandbox product risk, not eliminated.
2. `package.json` script body can differ from human mental model; pin is command string in config + sandbox.
3. 64 KB patch limit may force smaller diffs (product constraint).
4. Approval UI must actually show patch — engine stores digest; UI work may lag (track as implement checklist).
