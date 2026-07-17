# Implementation Plan: Session → Memory Import (Phase A + B)

## Overview

Build a production-grade import pipeline: **detect → parse → redact → distill → handoff/LTM/seed session**.  
Adapters in v1: **kyrei-export, opencode-json, claude-code-jsonl, claude-code-md, generic-md**.

**Do not** implement ZIP (ChatGPT/Claude.ai), SQLite (Cursor/Hermes DB), or LLM distill in the first vertical slice unless noted as optional follow-up within a task.

Each phase ends with tests green. Final phase: `npm run gate`.

References: `requirements.md`, `design.md`, `docs/research/session-import-platforms.md`.

---

## Tasks

### Phase 0 — Types, errors, fixtures skeleton

- [x] 0.1 Create module skeleton  
  - `core/engine/memory/import/{types,errors,index}.ts`  
  - Export `ImportError` codes from design §4  
  - Export types from engine entry carefully (no circular import with handoff)  
  - _Требования: R1_

- [x] 0.2 Fixture directory  
  - `tests/fixtures/session-import/` with **sanitized** samples:  
    - `kyrei-export.min.json` (from real SessionExport shape)  
    - `opencode-export.min.json` (minimal message/parts)  
    - `claude-code.sample.jsonl` (2–3 lines)  
    - `claude-code.export.md`  
    - `generic.sample.md`  
  - No secrets; small files  
  - _Требования: R8.6_

- [x] 0.3* Unit tests for types/errors smoke  
  - ImportError code preserved  
  - _Требования: R11_

---

### Phase 1 — Detect, redact, digest

- [ ] 1.1 `redact.ts`  
  - Port/extend patterns from `src/lib/session-export.ts` `redactSecretsInExport` for plain strings  
  - `redactTranscript(t): { transcript, redactionCount }`  
  - _Требования: R3.1–R3.3_

- [ ] 1.2 `digest.ts`  
  - Stable `contentDigest` over redacted messages (design §9)  
  - _Требования: R7.2_

- [ ] 1.3 `detect.ts` + adapter confidence hooks  
  - `detectImportFormat(raw, adapters) → ImportDetectResult`  
  - Threshold 0.6; ambiguous if top two within 0.1 and both ≥ 0.5  
  - _Требования: R2_

- [ ] 1.4* Tests: redact, digest stability, detect per fixture  
  - _Требования: R3, R7, R11_

---

### Phase 2 — Adapters (Phase B)

Implement each as pure `ImportAdapter` in `adapters/*.ts`; register in `registry.ts` **in priority order** (kyrei → opencode → claude-jsonl → claude-md → generic last).

- [ ] 2.1 `kyrei-export` adapter  
  - Parse SessionExport; flatten parts; skip pending  
  - _Требования: R8.1_

- [ ] 2.2 `opencode-json` adapter  
  - User/assistant text parts; tool stubs optional short  
  - _Требования: R8.2_

- [ ] 2.3 `claude-code-jsonl` adapter  
  - Liberal field sniffing; golden fixture  
  - _Требования: R8.3_

- [ ] 2.4 `claude-code-md` + `generic-md` adapters  
  - Role heading heuristics; generic fallback whole-file user  
  - _Требования: R8.4, R8.5_

- [ ] 2.5* Adapter tests  
  - Each fixture → non-empty messages, correct `source`, snapshot or expected role sequence  
  - Malformed → `import_adapter_parse_failed`  
  - Empty → `import_transcript_empty`  
  - _Требования: R8.6, R8.7, R11_

---

### Phase 3 — Distill + orchestrate

- [ ] 3.1 `distill-heuristic.ts`  
  - Map ImportedTranscript → `HandoffArtifact` (`HandoffSchema.parse`)  
  - Bounds from R4  
  - `trigger: "explicit"`  
  - _Требования: R4.1–R4.4_

- [ ] 3.2 Receipts + dedupe  
  - `.kyrei/import-receipts/{digest}.json`  
  - skip vs refresh  
  - _Требования: R7.3, R7.4_

- [ ] 3.3 `orchestrateImport`  
  - Size limits (32 MiB)  
  - Message caps  
  - writeHandoff  
  - optional LTM checkpoint via createLtmBridge  
  - inject `createSeedSession` callback (no SessionStore in engine)  
  - _Требования: R4.6, R5, R6 (callback side), R7_

- [ ] 3.4* Orchestrate tests (temp workspace)  
  - handoff file exists and parses  
  - dedupe skip  
  - LTM skip when no dir  
  - createSeedSession called when provided  
  - _Требования: R11_

---

### Phase 4 — Gateway API

- [ ] 4.1 Session `source: "import"`  
  - Extend store validation / types if enum-constrained  
  - Fallback documented only if blocked  
  - `src/lib/types.ts` SessionInfo.source  
  - _Требования: R6.1_

- [ ] 4.2 Append seed message helper  
  - Use same persistence path as normal chat messages  
  - Seed text = `reseedFromHandoff` + provenance + untrusted notice  
  - _Требования: R6.2–R6.4_

- [ ] 4.3 `POST /api/import/transcript`  
  - JSON body base64 (primary)  
  - Wire orchestrateImport + createSeedSession  
  - Map errors to HTTP  
  - _Требования: R9_

- [ ] 4.4* Gateway integration test  
  - POST fixture → 200 report → handoff on disk → session list contains seed  
  - oversized → 413  
  - _Требования: R9, R11_

---

### Phase 5 — UI + i18n

- [ ] 5.1 Client API helper `src/lib/session-import-api.ts`  
  - File → base64 → POST  
  - Client size guard 32 MiB  
  - _Требования: R10.3_

- [ ] 5.2 UI entry (pick **one** for v1)  
  - **Preferred:** Settings → Memory / Data section “Import conversation”  
  - Alternative: Sidebar menu  
  - Result panel: adapter, counts, paths, open session  
  - _Требования: R10.1, R10.2_

- [ ] 5.3 i18n en + ru keys  
  - _Требования: R10.4_

- [ ] 5.4* Component/unit test if pattern exists; else manual checklist in PR  
  - _Требования: R11_

---

### Phase 6 — Verification gate

- [ ] 6.1 Manual checklist  
  - [ ] Kyrei export round-trip  
  - [ ] OpenCode export sample  
  - [ ] Claude Code jsonl sample  
  - [ ] Generic md paste  
  - [ ] Dedupe second import  
  - [ ] No secrets in handoff from fixture with fake `sk-` key  

- [ ] 6.2 `npm run gate` green  
  - _Требования: R11.3_

- [ ] 6.3 Update research doc with “Implemented: Phase A+B” note + link to this spec  
  - _Требования: R12_

---

## Explicitly deferred (do not sneak into v1 PRs)

| Item | Phase later |
|------|-------------|
| ChatGPT / Claude.ai ZIP | C |
| Kiro MD/JSON, Aider MD | C |
| Cursor MD + SQLite | C/D |
| Hermes/OpenCode live DB read | D |
| Windsurf, Copilot, Cline | E |
| LLM distill | Optional after A+B stable |
| Multipart upload | Optional; base64 JSON enough |
| Path-based server read of arbitrary disk files | Avoid; security |

---

## Implementation notes (anti-rework)

1. **Adapters never write disk** — only orchestrate does.  
2. **Gateway never parses formats** — only calls engine orchestrate.  
3. **Do not** put import logic in renderer beyond file pick + API.  
4. Prefer **base64 in JSON** over gateway reading user paths (clearer consent, fewer path bugs).  
5. Golden fixtures must stay **tiny**; large real exports belong in local manual tests only.  
6. If OpenCode export shape differs from assumption, fix adapter + fixture — do not special-case in distill.  
7. Session `source: "import"` — fix types early (Phase 4.1) before UI assumes it.  
8. Match handoff schema **exactly** — use `HandoffSchema.parse`, never hand-roll markdown only.

---

## Suggested PR split

| PR | Content |
|----|---------|
| PR1 | Phase 0–2 (types, redact, detect, adapters + fixtures) |
| PR2 | Phase 3 (distill, orchestrate, receipts) |
| PR3 | Phase 4 (gateway + session source) |
| PR4 | Phase 5–6 (UI + gate) |

Each PR must keep `npm run gate` green (or package.json test subset + typecheck at minimum if gate too heavy mid-flight — final PR requires full gate).

---

## Definition of done

- [x] Spec complete (requirements + design + tasks)  
- [x] Phase 0–5 core complete (engine + gateway + sidebar import)  
- [ ] Manual checklist 6.1 (user smoke on real exports)  
- [x] Gate green (2026-07-16: 1175 tests)  
- [x] User can import OpenCode / Claude Code / Kyrei export and continue work from handoff-seeded session  

