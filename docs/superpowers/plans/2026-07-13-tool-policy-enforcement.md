# Local Tool Policy Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kyrei's terminal, review, permission-rule, secret-scan, and audit settings govern `run_command`, `write_file`, and `edit_file`, then add a durable signed interactive approval lifecycle.

**Architecture:** Use one fail-closed guarded-execution path inside the existing tool builder. `deny` never executes; `ask` executes only after AI SDK verifies a gateway-signed exact-call approval. Secret scanning runs again before mutation, durable one-shot consumption is an effect barrier, and a gateway-owned audit sink records denied/start/complete/error decisions with session and tool-call correlation. Continuation is always a new AI SDK run rather than a held in-memory tool promise.

**Tech Stack:** TypeScript 7, AI SDK 7 tools, Node.js filesystem/process APIs, JSONL audit log, Vitest 4

---

## Task 1: Lock permission and mutation behavior

**Files:**
- Modify: `core/engine/security/security.test.ts`
- Modify: `core/engine/tools/tools.test.ts`

- [x] Add policy tests for terminal off/auto/turbo, explicit allow/ask/deny precedence, review always/agent, and path-target rules.
- [x] Add effect tests proving blocked commands do not create a sentinel file and blocked writes/patches do not mutate the workspace.
- [x] Add secret-scan tests for both full writes and patches.
- [x] Add an atomic multi-file patch test proving one denied target blocks every target.
- [x] Add audit assertions for denied/start/complete records, session/tool-call IDs, and absent secret/file-content values.
- [x] Run the focused tests and confirm the new effect tests fail before wiring the guard.

## Task 2: Add the fail-closed guarded execution path

**Files:**
- Modify: `core/engine/tools/index.ts`
- Modify: `core/engine/security/audit.ts`
- Modify: `core/engine/security/permissions.ts`

- [x] Add `BuildToolsOptions` with optional abort signal, audit writer, and session ID while retaining three-argument call compatibility.
- [x] Add one `executeGuarded` helper that evaluates all target actions using deny > ask > allow, runs pre-hooks fail-closed, and wraps the effect with best-effort audit records.
- [x] Guard `run_command` using its exact command before sandbox/spawn.
- [x] Guard `write_file` using its exact path and run secret scanning before directory creation or file writes.
- [x] Parse `edit_file` once, evaluate every source/destination path, secret-scan the original patch, and apply only after every action is allowed.
- [x] Return a deterministic model-visible result when `ask` reaches execution without a valid signed one-shot approval; nothing executes.
- [x] Add `toolCallId` to audit records; keep audit failures from bypassing the policy decision or crashing the tool loop.

## Task 3: Wire one correlated audit sink through the live runtime

**Files:**
- Modify: `core/engine/types.ts`
- Modify: `core/engine/orchestrator/run.ts`
- Modify: `core/engine/orchestrator/run.test.ts`
- Modify: `core/gateway.js`

- [x] Add optional `sessionId` to `RunKyreiChatOpts` and pass it from `runPrompt`.
- [x] Create one audit sink per run and pass the same instance to local and web tool builders.
- [x] Update orchestrator mocks and assert audit/session/options wiring.
- [x] Run engine and renderer typechecks plus targeted orchestrator tests.

## Task 4: Full verification and independent review

**Files:**
- Modify: `docs/superpowers/plans/2026-07-13-tool-policy-enforcement.md`
- Modify if required: `docs/research/hermes-parity-matrix.md`

- [x] Run `npm run gate` and require every check and test to pass.
- [x] Run `npm audit --omit=dev --json` and require zero newly introduced vulnerabilities.
- [x] Request an independent review focused on bypasses, multi-file atomicity, audit leakage, abort behavior, and misleading approval semantics.
- [x] Fix every critical/important finding, rerun affected tests, then rerun `npm run gate`.
- [x] Record the intentionally deferred durable AI SDK approval resume flow and create a separate Lore-protocol commit.

## Review hardening completed

The independent review expanded the safety boundary before approval: permission config now recovers fail-closed; read/write paths reject live symlink/junction/reparse and Windows alias escapes; diagnostics uses both tool and terminal policies plus the configured sandbox; cancellation is an effect barrier with process-tree termination; and web audit stores only correlated origin/depth/length metadata. The remaining filesystem TOCTOU limitation is explicit in `security/jail.ts`.

## Durable approval lifecycle completed

- [x] Use AI SDK 7 HMAC-signed tool-approval requests rather than a synthetic user message.
- [x] Persist private structured model/tool/approval history while stripping it from every public session response.
- [x] Persist a session-bound exact-tool-call decision with a 24-hour TTL and reject replay after consumption.
- [x] Expose a local gateway response endpoint and reserve the session during continuation.
- [x] Render typed EN/RU allow-once and deny controls inline with the exact protected action.
- [x] Resume as a new run without holding an in-memory `execute()` promise across renderer disconnect or application restart.
- [x] Preserve per-turn reasoning and context/output overrides during continuation.
- [x] Fail expired approvals closed as denials without stranding the session.
- [x] Atomically consume explicit denials and expirations with their durable decision so a callback-free native denial cannot block later turns.
- [x] Durably consume the one-shot decision before starting its side effect; persistence failure blocks execution.
- [x] Preserve that barrier if policy changes while a signed request is pending: relaxed policy still consumes before effect, stricter policy consumes without effect.
- [x] Verify native AI SDK HMAC correlation rejects tool-call ID, input, and signature tampering and preserves mixed approve/deny batches.
- [x] Verify the full interaction in Electron with a real guarded command and terminal-backed output.

The approval signing key remains gateway-owned protected state. The public renderer receives only redacted action arguments and decision status; signatures and private model messages never cross the local HTTP boundary.
