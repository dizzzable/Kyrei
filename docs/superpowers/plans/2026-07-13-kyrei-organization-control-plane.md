# Kyrei Organization Control Plane — implementation plan

Date: 2026-07-13
Status: Phase 1 complete; Phase 2 safe read-only Team runtime adapter complete

## Objective

Add a durable organization layer above the existing Team/MoE runtime so users can compose independent departments into a coding mission that survives restarts, respects budgets, exchanges typed evidence and cannot silently treat model consensus as truth.

## Invariants

1. Existing Single, Team and Consensus modes remain compatible.
2. Pipeline definitions reference public Team profile IDs; credentials stay in the gateway secret store.
3. A running mission pins an immutable definition revision.
4. Cross-department context is a bounded artifact envelope, not a transcript dump.
5. Provider calls reserve budget before dispatch; missing usage is charged at the reservation ceiling.
6. Only one Action Executor may write a workspace in Phase 1.
7. A crashed write attempt is `uncertain` and cannot be resumed blindly.
8. Truth gates require observed, fresh deterministic receipts.
9. Persistent skill changes are staged and approved; live self-modification is forbidden.

## Bounded contexts

### Team Runtime

Existing roles, provider/model targets, internal DAG, consensus and nested read-only helpers. It produces one department artifact.

### Organization Configuration

Revisioned pipeline definitions, departments/stages, dependency graph, allowed assistance edges and nested limits. Validation is strict at API boundaries and tolerant during migration/reconciliation.

### Mission Control

Durable mission snapshot, append-only events, stage attempts, approvals, artifacts, attached sessions and recovery. Chat history is a view, not the source of truth.

### Evidence and Verification

Typed observed/reported evidence, workspace and input digests, deterministic check receipts and explicit stale/contradictory states.

### Budget and Admission

Atomic in-process reservation and reconciliation for tokens/calls/cost/time. A later persistent scheduler will serialize reservations across processes.

### Improvement

Opt-in experience curation, candidate skill patching, independent held-out evaluation, security audit, staged adoption, canary and rollback.

## Phase 1 files

New control-plane modules:

- `core/pipeline-config.js`
- `core/pipeline-run-store.js`
- `core/workspace-lease-store.js`
- `core/engine/pipeline/types.ts`
- `core/engine/pipeline/state-machine.ts`
- `core/engine/pipeline/budget.ts`
- `core/engine/pipeline/artifacts.ts`
- `core/engine/pipeline/truth-gate.ts`
- `core/engine/pipeline/index.ts`

Integration:

- persist public pipeline definitions alongside gateway configuration;
- expose authenticated create/list/get/approve/pause/resume/cancel/attach APIs;
- expose renderer contracts without secrets;
- add a settings surface for revisioned coding pipelines after the domain/API gate is green.

## Default coding pipeline

```text
research
  -> plan
  -> approval
  -> implementation-proposal
  -> action
  -> verification
       pass -> complete
       fail -> fix-proposal -> action-fix -> verification (bounded)
```

An executor may emit an `AssistanceRequest` only to a department listed in `allowedHelpFrom`. The scheduler counts the request against both the stage and mission budgets and records the returned artifact as an input dependency.

## Artifact contract

Every accepted artifact contains:

- immutable ID, kind, producer and input digests;
- bounded payload or content-addressed payload reference;
- typed evidence references with observed/reported trust;
- assumptions, contradictions, uncertainties and unchecked items;
- provider/model/policy provenance without credentials;
- token/call/time metrics.

Verification receipts bind to the applied workspace digest. Any file change after verification makes the receipt stale.

## Recovery

- Active read-only stages become `interrupted` after restart and may be explicitly resumed with a fresh runtime fingerprint.
- Active write stages become `uncertain`.
- Resume re-resolves credentials and checks definition revision, providers/models/skills, workspace baseline and sandbox policy.
- `uncertain` writes require a deterministic postcondition resolution before retry or completion.
- Attaching another session is idempotent and does not clone the mission.

## Execution sequence

1. Land configuration, state machine, evidence, budget, store and lease primitives with unit tests.
2. Add authenticated gateway APIs and config persistence/reconciliation.
3. Add renderer types and a minimal mission/pipeline settings surface in EN/RU.
4. Extract direct `executeTeamRun` from the existing tool wrapper.
5. Add department coordinator and scheduler with read-only departments first.
6. Add strict-required Action Executor only where sandbox enforcement and workspace lease are available.
7. Add verification/fix loops and assistance routing.
8. Add the optional SkillOpt sidecar behind the Improvement pipeline and promotion controller.

## Phase 2 cleanup and integration plan

1. Extract the typed Team task executor from the model-facing tool wrapper so
   chat and Pipeline share one lifecycle, timeout, concurrency and redaction
   implementation.
2. Extract the role-executor factory from the chat orchestrator. The Pipeline
   adapter uses the same provider resolution and positive capability allowlist,
   with an additional read-only capability clamp.
3. Resolve the Pipeline stage's specific Team profile only inside the gateway,
   run its bounded department graph, and convert its compact structured result
   into a canonical `ArtifactEnvelope`.
4. Schedule only those read-only department stages. Action and truth-gate
   stages remain fail-closed until separately trusted adapters exist.
5. Lock the new behavior with engine and gateway regression tests, then run
   the full gate before declaring the adapter usable.

## Delivered control-plane guarantees

- The durable store now accepts only canonical, bounded `ArtifactEnvelope`
  records bound to their mission and producing stage. A department cannot be
  marked complete without one of those artifacts.
- An interrupted write cannot leave `uncertain` through the generic state
  transition API; it needs an explicit verifier-backed resolution receipt.
- A truth receipt contains the exact canonical digest(s) of every upstream
  action receipt. Snapshot recovery rechecks that lineage.
- `PipelineMissionRunner` is the SDK-neutral Phase 2 coordinator: it advances
  department stages, requests approvals, leases a workspace before an action,
  preserves a failed write as `uncertain`, and closes only after a truth gate.
- Chat and Pipeline now share one Team role-executor factory. Pipeline
  departments receive an explicit read-only capability clamp and must return a
  compact structured artifact; raw model prose cannot silently become a durable
  mission result.
- A multi-role department creates one bounded task per role and a final
  synthesis task that consumes every role artifact. The synthesis task counts
  towards both `maxAgents` and `maxTasks`, so those limits cap every provider
  call rather than only the first layer of the Team graph.
- Gateway execution snapshots the stage configuration and credential values,
  redacts those values from events and artifacts, then rechecks the runtime
  fingerprint and workspace checkpoint before persisting a result.
- Department artifact persistence and stage completion are one durable store
  mutation. A pause, cancellation, malformed response, or crash cannot leave a
  partially attached department artifact.
- An unavailable legacy Team adapter produces an explicit blocked stage instead
  of leaving the mission in a misleading running state. Action execution and
  truth verification remain deliberately fail-closed until trusted sandbox and
  deterministic verifier adapters are supplied.

## Explicit non-goals for Phase 1

- No autonomous production-skill replacement.
- No parallel writes to one git working tree.
- No claim that Windows host commands are strictly sandboxed without a container/VM adapter.
- No persistence of chain-of-thought, raw provider transcripts or credentials.
- No truth decision based on model vote count.
