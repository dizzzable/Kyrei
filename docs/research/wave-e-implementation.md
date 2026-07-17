# Wave E implementation

**Date:** 2026-07-17  
**Depends on:** Wave D (goal skim, plan gate, harness metrics log)

## Tracks

| ID | Change | Default |
|----|--------|---------|
| **E1 Intent** | `intent-router.ts` classifies short/long/research/polish before tools | drives plan gate + goal-verify preference |
| **E1 Map cache** | Symbol map cached by marker mtimes + 60s TTL | process-local |
| **E2 Post-edit** | After successful `edit_file`/`write_file`, optional `tsc`/lint/test | `reliability.postEditVerify: "polish"` |
| **E3 Metrics UI** | `result.harness` → gateway `lastHarnessMetrics` → `GET /api/usage` → Settings → Usage | always when a turn completed |

## Config

```ts
reliability.postEditVerify: "off" | "on" | "polish"  // default "polish"
```

## Surfaces

- Engine: `RunKyreiChatResult.harness`
- Gateway: `/api/usage` includes `harness` (sanitized)
- UI: `UsageSettings` harness panel (EN/RU)

## Safety

- Post-edit verify is **fail-open** (never rolls back edits).
- Metrics contain no prompts/secrets.
- Intent router is pure heuristics (no extra LLM call).
