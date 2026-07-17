# Wave H — Memory upgrade (MemoHood / MemoBase patterns)

**Date:** 2026-07-17  
**Rule:** Port **patterns**, not hermes plugins / silent MEMORY.md rewrite / cloud-default embeddings.

## Goal

Improve Kyrei durable memory quality using patterns from:

- [MemoHood](https://github.com/mxskorohood-cmd/memohood) — dialogue LTM  
- [MemoBase](https://github.com/mxskorohood-cmd/memobase) — grounded document KB  

**Not** in scope: vendoring those repos, replacing SQLite/markdown SoT, auto-rewrite of MEMORY.md every turn.

## Architecture (after)

```
capture-signals  →  curator heuristics (cheap gate)
                 →  LTM decisions (pin / kind / confidence)
                 →  SUPERSEDE + history (fetch_decision)

memory_search multi-channel hits
  → path dedupe
  → near-dupe cluster (Jaccard)
  → MMR diversity
  → optional cite-or-refuse sufficiency note

ltm refreshRuntimeSnapshot
  → rank by pin + Ebbinghaus confidence
  → drop below floor from *snapshot only* (ledger intact)
```

## What shipped

| Module | Role |
|--------|------|
| `memory/recall-pipeline.ts` | `shouldRecall`, near-dupe collapse, MMR, `postProcessRecall` |
| `memory/capture-signals.ts` | Keyword scoring, pin detection, decay math |
| `memory/cite-or-refuse.ts` | Sufficiency gate, citation verify, refuse message, grounded pack |
| `memory/ltm-bridge.ts` | `pinned`, `kind`, `confidence`, `supersedes`, `supersedeDecision`, `fetchDecision`, ranked list |
| `memory/session-curator.ts` | Capture merge; `recordDecisions` + SUPERSEDE on apply_safe |
| `tools/memory-search.ts` | Post-recall MMR; optional refuse when `citeOrRefuse.enabled` |
| `tools/index.ts` | `record_decision` pin/supersedesId/kind; `fetch_decision` |
| Config | `memory.recall`, `memory.decay`, `memory.citeOrRefuse` |

## Defaults (safe)

| Key | Default | Why |
|-----|---------|-----|
| `memory.recall.mmrEnabled` | true | Diversity without extra API |
| `memory.decay.enabled` | true | Rank only; no physical delete |
| `memory.citeOrRefuse.enabled` | **false** | Search stays informative; enable for strict grounded mode |
| Curator `applyMode` | `apply_safe` | MEMORY.md still not silent |

## Explicit non-goals

1. Per-turn auto-capture into MEMORY.md  
2. Cloudflare / Cohere / Gemini as required path  
3. Hermes `memory.provider` swap  
4. Full YouTube/PDF ingest pipeline (MemoBase product surface)

## Shipped in follow-up (same wave)

- **UI:** Settings → Memory → Decisions (pin & SUPERSEDE history)  
- **API:** `GET /api/memory/ltm/decisions`, `GET …/fetch`, `POST …/pin`  
- **Tool:** `memory_ask` — vault + MEMORY/notes + decisions, always cite-or-refuse  
- **Settings toggles:** MMR, cluster, decay, cite-or-refuse for `memory_search`

## Remaining optional

- Graph session_links boost (MemoHood graph_rerank) when session mirror has link edges  
- Night cron: pass decay config from engine config into consolidate

## Tests

`core/engine/memory/wave-h-memory.test.ts` — gate, MMR, capture, cite, supersede, curator apply.

## Product philosophy preserved

> Proposal-first durable markdown · files SoT · LTM ledger append-only · untrusted memory layers · no silent self-mutation of policy.
