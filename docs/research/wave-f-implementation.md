# Wave F implementation

**Date:** 2026-07-17

## Tracks

| ID | Change |
|----|--------|
| **F1** | Invalidate symbol map cache after edit/write; StatusBar shows last intent + waste% |
| **F2** | Gateway always derives `goal` from last user message; Settings toggles for `longTaskPlanGate` + `postEditVerify` |
| **F3** | Goal-verify judge prefers **worker** model assignment when configured |

## Subagent / team context isolation (existing design)

Confirmed in code (not a new Wave F feature):

- **`delegate_read` / RO children** (`read-child.ts`): fresh `generateText` with isolated `instructions` + `prompt: goal` only — **parent chat history is not copied**. Parent receives a **bounded summary** (~1.2k chars), not the child transcript.
- **Team roles** (`member-runner.ts`): each role runs its own loop with role system prompt + task goal + dependency artifacts; **not** the main session message list. Output is a structured artifact for the parent.
- **Main model context window** is only charged for: parent transcript + tool results returned to parent (summaries/artifacts) + system packing.

So yes: each subagent/role is a **sidechain session** for the model API, deliberately to protect the main window.

## Surfaces

- `GET /api/status` includes `harness` (same sanitized snapshot as `/api/usage`)
- StatusBar chip (wide screens)
- Settings → Usage → agent loop policies
