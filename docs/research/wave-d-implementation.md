# Wave D implementation notes

**Date:** 2026-07-17  
**Source plan:** [`agent-optimization-landscape-2026.md`](./agent-optimization-landscape-2026.md) §7  

## What shipped

| Track | Integration point | Defaults |
|-------|-------------------|----------|
| **D0 metrics** | `observability/harness-metrics.ts` → `run.ts` logs `[kyrei harness] end` | always on (console) |
| **D1 goal skim** | `goal-skim.ts` + `tool-compress` focus + `read_file.focus` + prepareStep focus from last user turn | `compression.goalSkim: true` |
| **D2 mask + pin** | prepareStep always masks old tool bodies; `working-state.ts` re-pins goal | `alwaysMaskToolBodies` / `pinWorkingState: true` |
| **D3 long plan gate** | `plan-gate.ts` + force plan tools when auto + long goal + no plan artifact | `reliability.longTaskPlanGate: true` |
| **D3 goal verify** | polish / final-audit markers use last user turn when no explicit goal | `goalVerifyFromUserTurn: true` |
| **D4 symbol map** | `intel/repo-symbols.ts` injected into project context | fail-open, ~1.6k chars |

## Config (engine)

```ts
compression.alwaysMaskToolBodies  // default true
compression.goalSkim              // default true
compression.pinWorkingState       // default true
reliability.longTaskPlanGate      // default true
reliability.goalVerifyFromUserTurn // default true
```

## Non-conflicts

- Does **not** rewrite chat JSON SoT (pins/prunes are model-projection via prepareStep).
- Plan gate only for **auto** + long-horizon; short fixes unchanged.
- Symbol map is **hint** text (same posture as import graph tools).
- CCR still holds full tool bodies when archived.
- Product boundaries unchanged (no MoA, no silent skill rewrite, no cloud gateway).

## Prompt

`PROMPT_VERSION` → **1.26.0** (auto long-horizon plan-first + read_file focus wording).
