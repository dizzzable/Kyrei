# Engine parity slice: Hermes → Kyrei

## Scope

This audit covers only the backend engine/runtime surface assigned to worker-2: `EngineConfig`, orchestration, and memory/runtime behavior. It excludes browser capabilities and UI/settings IA work, because Kyrei must preserve the closed desktop / no-browser constraint and worker-3 owns the settings/UI audit.

## Evidence reviewed

- Hermes runtime config: `../hermes/config.yaml`
- Hermes implementation surfaces: `../hermes/hermes-agent/agent/*`, `../hermes/hermes-agent/tools/*`, `../hermes/hermes-agent/acp_adapter/*`
- Kyrei engine config + runtime: `core/engine/types.ts`, `core/engine/config/schema.ts`, `core/gateway.js`
- Kyrei orchestration: `core/engine/orchestrator/run.ts`, `core/engine/orchestrator/prepare-step.ts`, `core/engine/orchestrator/stop-conditions.ts`, `core/engine/orchestration/*`
- Kyrei memory/runtime pieces: `core/engine/memory/*`, `core/engine/context/*`, `core/engine/data/*`
- Existing verification/tests: `core/engine/config/config.test.ts`, `core/engine/memory/memory.test.ts`, `core/engine/orchestration/orchestration.test.ts`, `core/engine/provider/provider.test.ts`

## Current parity map

### 1) Engine/runtime config

| Hermes capability | Hermes evidence | Kyrei status | Kyrei evidence | Gap |
|---|---|---|---|---|
| Iteration budget | `agent.max_turns: 60` | Partial | `EngineConfig.maxSteps`, `buildStopWhen(stepCountIs)` | Name/default mismatch; Kyrei has only `maxSteps`, no Hermes-style aliases, and only one stop condition is active. |
| API retry budget | `agent.api_max_retries: 5` | Partial | `EngineConfig.apiMaxRetries` wired in `run.ts` | Parity exists conceptually, but defaults differ and Kyrei has no Hermes config-shape compatibility. |
| Reasoning effort | `agent.reasoning_effort: xhigh`, `delegation.reasoning_effort: high` | Partial | `buildProviderOptions()` maps UI `modelParams` to `reasoningEffort` | Per-turn UI plumbing exists, but there is no persisted engine-level default equivalent to Hermes `agent.reasoning_effort`. |
| Fallback providers | `fallback_providers[]` with provider/model/base_url/key_env/api_mode | Partial | `fallbackChain: string[]`, `provider/registry.ts`, `open-stream.ts` | Kyrei can fail over only by model id; it cannot yet express Hermes-grade fallback descriptors. |
| File-read ceiling | `file_read_max_chars: 1000000` | Yes | `EngineConfig.fileReadMaxChars`, `tools/index.ts` `read_file` | Same capability, different defaults. |
| Tool output ceilings | `tool_output.max_bytes/max_lines/max_line_length` | Partial | `EngineConfig.maxToolOutput` char cap | Kyrei has one char-based cap only; no line/byte structure. |
| Personality text | `agent.personalities.*` | Partial | `EngineConfig.personality`, `prompt/system.ts` | Kyrei supports raw personality text but not Hermes-style named catalogs. |
| Terminal policy | `terminal.backend`, approvals mode elsewhere | Partial | `permissions.terminal`, `permissions.review`, `security/permissions.ts` | Kyrei has good policy primitives, but not Hermes' full approval persistence / session-scoped UX. |

### 2) Orchestration/runtime behavior

| Hermes capability | Kyrei status | Evidence | Gap |
|---|---|---|---|
| Tool loop with max-iteration stop | Yes | `orchestrator/run.ts`, `stop-conditions.ts` | Only step-count stop is live; no hard-stop loop guardrails equivalent to Hermes `tool_loop_guardrails`. |
| Context compression before overflow | Partial | `prepare-step.ts`, `context/compaction.ts`, `context/tokens.ts` | Kyrei has deterministic tool-output pruning, but not Hermes' pluggable/full compression engine semantics. |
| Read-only delegation / swarm | Partial skeleton only | `orchestration/reviewer.ts` has `runReadSwarm()` contract | No live subagent tool/runtime in Kyrei engine yet. |
| Clean-context review | Partial skeleton only | `reviewDiff()` + tests | Contract exists, but no live invocation in the turn loop. |
| Provider failover | Yes, simplified | `provider/open-stream.ts`, `provider/provider.test.ts` | Simpler than Hermes: no per-fallback provider/baseURL/key/api-mode objects. |
| Approval bridge | Partial | `approval.request` event type + `security/permissions.ts` | Gateway lacks a completed Hermes-like approval flow/persistence surface. |

### 3) Memory/runtime context

| Hermes capability | Kyrei status | Evidence | Gap |
|---|---|---|---|
| Project instruction layering (`AGENTS.md`, steering, project memory) | Implemented but dormant | `memory/layers.ts`, `memory/memory.test.ts`, `prompt/system.ts` supports `projectContext` | `runKyreiChat()` never calls `assembleSystemContext()`, so the layered context is not injected into live turns. |
| Controlled memory writes | Yes | `memory/writer.ts`, tests | Not yet wired into a live memory workflow/tool. |
| Handoff artifact | Yes, isolated | `memory/handoff.ts`, tests | Not triggered from runtime stop/completion paths yet. |
| LTM bridge | Yes, isolated | `memory/ltm-bridge.ts`, tests | Not invoked from write/edit/turn completion paths yet. |
| Structured memory/search backend | Partial | `data/*` SQLite + file fallback | Data ports exist, but the turn loop is not using them as an active memory system. |

## Recommended smallest safe functional parity slice

### Slice A — Activate project-scoped layered memory/instruction context in live turns

This is the smallest slice that is both **real parity work** and **safe to ship independently** without overlapping UI work.

Why this slice first:

1. The code is already mostly built and tested.
2. It is backend-only, so it does not conflict with worker-3's settings/UI scope.
3. It preserves Kyrei's no-browser constraint.
4. It closes an actual Hermes parity gap immediately: project instructions and project memory influencing every turn.
5. It avoids new persistent schema changes.

### What the slice should do

When `workspace` is present, inject the already-implemented layered project context into the live system prompt:

1. `AGENTS.md`
2. `.kiro/steering/*.md` with `inclusion: always`
3. `.kyrei/memory/MEMORY.md`
4. optional global layer later, but **not required for the first slice**

### Exact files for Slice A

- `core/engine/orchestrator/run.ts`
  - call `assembleSystemContext({ workspace })`
  - pass result into `buildSystemPrompt({ ..., projectContext })`
- `core/engine/prompt/system.ts`
  - likely no logic change required; only confirm prompt text remains deterministic
- `core/engine/memory/memory.test.ts`
  - keep existing layering tests as regression coverage
- `core/engine/orchestration/orchestration.test.ts` or new orchestrator integration test
  - add a live-turn test proving the built prompt contains layered project context when a workspace has `AGENTS.md` / steering / `MEMORY.md`
- `core/engine/prompt/prompt.test.ts`
  - if prompt snapshots are used for wording changes, update snapshot/version intentionally

### Data model / migration for Slice A

- **No new persisted schema**
- Reuse existing on-disk files only:
  - `AGENTS.md`
  - `.kiro/steering/*.md`
  - `.kyrei/memory/MEMORY.md`
- **Migration:** none
- **Fail-open behavior:** if files are absent, engine behavior stays unchanged

### Acceptance criteria for Slice A

- Live `runKyreiChat()` uses layered project context when `workspace` is set.
- Turns without a workspace remain unchanged.
- Missing memory/steering files do not throw.
- Prompt remains deterministic.
- No UI or settings panel work is required for the slice to function.

## Next slices after Slice A

### Slice B — Hermes config-shape compatibility for backend runtime settings

Primary goal: accept Hermes-like shapes without requiring UI work yet.

Suggested scope:

- alias/migrate:
  - `agent.max_turns -> maxSteps`
  - `agent.api_max_retries -> apiMaxRetries`
  - `agent.reasoning_effort -> persisted default reasoning mode`
  - `file_read_max_chars -> fileReadMaxChars`
- optionally introduce a richer fallback descriptor type instead of `fallbackChain: string[]`

Likely files:

- `core/engine/types.ts`
- `core/engine/config/schema.ts`
- `core/gateway.js`
- `core/engine/provider/*`
- tests in `core/engine/config/config.test.ts` and `core/engine/provider/provider.test.ts`

### Slice C — Runtime handoff + LTM activation

Primary goal: make the already-built memory artifacts actually happen during real work.

Suggested scope:

- emit LTM events after `write_file` / `edit_file`
- create handoff artifacts on turn-limit / explicit completion boundaries
- optionally surface last handoff path in session metadata

Likely files:

- `core/engine/tools/index.ts`
- `core/engine/orchestrator/run.ts`
- `core/engine/memory/ltm-bridge.ts`
- `core/engine/memory/handoff.ts`
- `core/session-store.js` (only if exposing artifact metadata is needed)

### Slice D — Live read-only swarm + reviewer wiring

Primary goal: approach Hermes' delegation/orchestration model without enabling multi-writer conflicts.

Suggested scope:

- keep single-writer Kyrei invariant
- expose read-only subagent execution as a separate internal tool/runtime
- run clean-context diff review after code modifications

This is higher risk and should follow, not lead.

## Blockers / constraints to report upstream

1. **Fallback descriptor mismatch**
   - Hermes fallbacks are structured objects (`provider`, `model`, `base_url`, `key_env`, `api_mode`).
   - Kyrei fallbacks are only `string[]` model ids today.
   - Full parity here requires a real config/data-model expansion.

2. **Dormant memory pieces are not yet integrated**
   - Kyrei already has `layers.ts`, `writer.ts`, `handoff.ts`, `ltm-bridge.ts`, and SQLite memory ports.
   - The main gap is wiring, not greenfield implementation.

3. **Approval/runtime parity is incomplete**
   - Kyrei has engine-side permission decisions and an `approval.request` event type.
   - It does not yet match Hermes' richer approval routing/persistence behavior end-to-end.

4. **No-browser constraint must stay explicit**
   - Hermes exposes browser tools and browser-oriented config.
   - Kyrei parity work for this phase should explicitly exclude browser features.

## Recommended first implementation order

1. **Slice A** — activate layered project context in live turns
2. **Slice B** — accept Hermes-like backend runtime config aliases / richer fallback model
3. **Slice C** — wire handoff + LTM into real runtime events
4. **Slice D** — add live read-only swarm/reviewer orchestration

## Bottom line

The best first functional slice is **not** adding more settings fields. It is **turning on the project-scoped memory/instruction layers that Kyrei already has but does not yet use in `runKyreiChat()`**. That delivers real Hermes-style engine parity with the least risk, no product-UI overlap, and no schema migration.
