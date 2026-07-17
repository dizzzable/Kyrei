# Requirements: Multi-platform Session → Memory Import

**Spec version:** 1.0  
**Scope for v1 implementation:** Phase A (core pipeline) + Phase B (P0 adapters)  
**Out of scope for v1:** Cursor SQLite, ChatGPT/Claude ZIP bulk, Windsurf, Copilot (Phase C–E — designed for later, not implemented now)

---

## Introduction

Kyrei already **exports** sessions (`src/lib/session-export.ts`) and has durable memory primitives:

- **Handoff** — `.kyrei/handoff/*.md` (`writeHandoff` / `reseedFromHandoff`)
- **LTM** — `ltm/store/*.jsonl` via `createLtmBridge` (events, checkpoints, decisions)
- **Sessions** — gateway `POST /api/sessions`, message store

Users work across **OpenCode, Claude Code, Hermes, Cursor, ChatGPT, Kiro**, etc. They need Kyrei to **ingest those histories as memory**, not as a raw second chat UI.

### Product goal

Import a conversation from another platform (or Kyrei export) and produce:

1. A **normalized transcript** (safe, redacted, platform-agnostic)
2. A **distilled handoff** (intent, done, next, key files, decisions, open questions)
3. Optional **LTM checkpoint/event**
4. Optional **new Kyrei session** seeded with a short “imported context” message — **never** replaying foreign tool-calls

### Non-goals (explicit)

| Non-goal | Why |
|----------|-----|
| Clone another agent’s full tool state | Formats incompatible; unsafe |
| Auto-scrape cloud accounts without user export | Auth/legal/PII |
| Inject 50 full transcripts into one context window | Noise, cost, quality collapse |
| Guarantee perfect Cursor SQLite forever | Undocumented schema drift |
| Replace project graph / workspace truth | Files on disk remain source of truth |

### Principles

1. **Memory import, not session clone**
2. **User-owned files only** (export JSON/MD/JSONL/ZIP the user provides)
3. **Fail closed on secrets** (redact or reject)
4. **Untrusted data** — imported text is never higher priority than Kyrei policy
5. **Deterministic core** first; LLM distill is optional and gated
6. **Adapter isolation** — one broken platform parser cannot break others
7. **Golden fixtures** per adapter — format drift caught by tests

---

## Glossary

| Term | Definition |
|------|------------|
| **Source export** | File(s) user selected (`.json`, `.jsonl`, `.md`, `.zip`) |
| **Adapter** | Pure function: bytes/path → `ImportedTranscript` or structured error |
| **ImportedTranscript** | Canonical intermediate model (see design) |
| **Distill** | Transcript → `HandoffArtifact` (+ optional LTM checkpoint fields) |
| **Heuristic distill** | No LLM; regex/heuristics over user/assistant text |
| **LLM distill** | Optional second pass with clean-context model (no tools) |
| **Seed session** | New Kyrei chat with 1–2 messages summarizing import (not full history) |
| **Import report** | Counts, redactions, warnings, output paths, adapter id |

---

## Requirements

### R1: Canonical intermediate model

**User Story:** As a developer, I want one internal shape so adapters stay small and distill stays platform-agnostic.

#### Acceptance Criteria

1. THE SYSTEM SHALL define `ImportedTranscript` with: `schemaVersion`, `source`, `sourceId?`, `title?`, `createdAt?`, `updatedAt?`, `workspaceHint?`, `messages[]`, `meta?`.
2. Each message SHALL have `role` ∈ `user|assistant|system|tool|unknown`, `text` (string), optional `at`, optional `parts` (diagnostic only).
3. THE SYSTEM SHALL set `schemaVersion: 1` for v1; future versions MUST migrate or reject.
4. THE SYSTEM SHALL NOT require tool call IDs, provider transcripts, or binary attachments in the intermediate model.

---

### R2: Detection and routing

**User Story:** As a user, I drop a file and the system picks the right parser (or asks me).

#### Acceptance Criteria

1. WHEN the user provides a file path or buffer THE SYSTEM SHALL run `detectImportFormat` and return `{ adapterId, confidence, reasons[] }`.
2. THE SYSTEM SHALL support explicit `adapterId` override (user selection in UI/API).
3. WHEN confidence is below threshold AND no override THE SYSTEM SHALL return `import_format_ambiguous` with candidate adapters (not silent wrong parse).
4. WHEN no adapter matches THE SYSTEM SHALL try `generic-md` only if content is text/markdown; else `import_format_unsupported`.

---

### R3: Redaction and safety

**User Story:** As an owner, I never want API keys from ChatGPT/Cursor dumps written into my repo memory.

#### Acceptance Criteria

1. THE SYSTEM SHALL run redaction on all message `text` fields **before** distill and **before** any disk write.
2. THE SYSTEM SHALL reuse and extend patterns from `redactSecretsInExport` / engine `redact` (sk- keys, Bearer, long hex, common cloud tokens).
3. WHEN redaction changes text THE SYSTEM SHALL increment `report.redactionCount`.
4. THE SYSTEM SHALL treat imported content as untrusted data in any seed message prefix (policy envelope language).
5. THE SYSTEM SHALL reject files larger than **32 MiB** uncompressed (`import_payload_too_large`) before full parse.
6. THE SYSTEM SHALL reject ZIP bombs / entry count > 500 / single entry > 32 MiB.

---

### R4: Distill to handoff

**User Story:** As a user, I want a short durable summary the agent can reseed from, not a novel.

#### Acceptance Criteria

1. THE SYSTEM SHALL produce a `HandoffArtifact` valid against existing `HandoffSchema` (`core/engine/memory/handoff.ts`).
2. THE SYSTEM SHALL set `trigger: "explicit"` and a new `sessionId` (or provided target session id for bookkeeping only).
3. Heuristic distill SHALL extract at minimum: `intent` (from last substantial user message), `keyFiles` (paths mentioned in messages matching workspace-like patterns), bounded `done`/`nextActions`/`openQuestions` lists (max 20 each), empty arrays allowed.
4. Distill output field lengths SHALL be bounded (intent ≤ 500 chars; list items ≤ 300 chars; max 20 keyFiles).
5. Optional LLM distill WHEN `options.llmDistill === true` AND a model is available SHALL replace/refine heuristic fields but MUST NOT call tools and MUST re-validate via `HandoffSchema`.
6. THE SYSTEM SHALL write handoff via `writeHandoff(workspace, artifact)` → path under `.kyrei/handoff/`.

---

### R5: Optional LTM persistence

**User Story:** As a user, I want import to show up in long-term project memory.

#### Acceptance Criteria

1. WHEN `options.writeLtm === true` AND workspace has LTM dir configured THE SYSTEM SHALL append an LTM checkpoint via `createLtmBridge` with: summary, decisions (from handoff), openThreads, nextActions, changedFiles from keyFiles, sessionId.
2. WHEN LTM is disabled or dir missing THE SYSTEM SHALL skip LTM and set `report.ltmSkipped = true` (not hard fail).
3. LTM source tag SHALL be distinguishable (e.g. checkpoint summary prefix `import:` or meta `source: kyrei:import` if ledger allows — if not, encode in summary).

---

### R6: Optional Kyrei seed session

**User Story:** As a user, I want a new chat that already “knows” the import without loading full history.

#### Acceptance Criteria

1. WHEN `options.createSession === true` THE SYSTEM SHALL create a session via gateway session store (`source` MUST be extensible: prefer `source: "import"`; if store enum is closed, use `chat` + title prefix `[import]`).
2. THE SYSTEM SHALL append **at most two** messages: (a) system or user seed with `reseedFromHandoff` text + provenance footer (`Imported from {source}, adapter {id}, handoff {path}`); (b) optional short assistant ack if product wants — **default: user seed only**.
3. THE SYSTEM SHALL NOT copy the full `ImportedTranscript.messages` into the session by default.
4. WHEN `options.includeTranscriptExcerpt === true` THE SYSTEM MAY attach up to **8 KB** of last user+assistant turns as an additional bounded appendix (still redacted).

---

### R7: Import report and idempotency

**User Story:** As a user, I want to know what happened and avoid duplicate memory spam.

#### Acceptance Criteria

1. THE SYSTEM SHALL return `ImportReport`: adapterId, messageCount, redactionCount, handoffPath?, ltmCheckpointId?, sessionId?, warnings[], errors[].
2. THE SYSTEM SHALL compute `contentDigest = sha256(canonical JSON of redacted transcript messages text)` for bookkeeping.
3. WHEN `options.dedupe === true` (default true) AND a prior import marker with same digest exists under `.kyrei/import-receipts/{digest}.json` THE SYSTEM SHALL return `import_duplicate` or success with `report.deduped = true` without rewriting handoff (configurable: `dedupeMode: "skip" | "refresh"`).
4. Successful imports SHALL write a small receipt JSON (digest, source, adapterId, at, handoffPath).

---

### R8: Phase B adapters (P0)

**User Story:** As a user, I can import the tools I use daily.

#### Acceptance Criteria

1. **kyrei-export** — parse `SessionExport` (`exported_at`, `session_id`, `title`, `messages[]`); map roles; flatten `parts` text where present.
2. **opencode-json** — parse `opencode export` JSON (session + messages + text parts); skip pure tool/reasoning-only noise or flatten tool summaries to short stubs (`[tool:name]`).
3. **claude-code-jsonl** — parse `~/.claude/projects/**/*.jsonl` style lines (tolerate unknown fields); extract user/assistant text.
4. **claude-code-md** — parse `/export` markdown (role headings / fenced blocks heuristics).
5. **generic-md** — plain markdown or `User:`/`Assistant:` lines.
6. Each adapter SHALL have golden fixtures under `tests/fixtures/session-import/` and unit tests.
7. Adapter failures SHALL throw/return codes: `import_adapter_parse_failed` with field path hints.

---

### R9: Gateway API

**User Story:** As the desktop app, I call one HTTP endpoint to run import.

#### Acceptance Criteria

1. THE SYSTEM SHALL expose `POST /api/import/transcript` (auth: existing gateway token).
2. Body SHALL accept either: multipart file upload **or** JSON `{ path?, contentBase64?, fileName?, adapterId?, options }`.
3. Path mode SHALL only read paths under an allowlist: user-selected absolute path that the gateway validates is a regular file (no directory traversal into system roots beyond the provided path — treat as user-consented path). Prefer content upload from renderer for safety.
4. Response 200: `{ report, handoff?, transcriptMeta }` (no full transcript by default; optional `includeTranscript: true` for debug).
5. Errors: 400 validation, 409 duplicate (if skip), 413 too large, 422 unsupported format.

---

### R10: UI (minimal v1)

**User Story:** As a user, I pick a file and see results without CLI.

#### Acceptance Criteria

1. Settings or Sidebar SHALL offer **Import conversation…** file picker (`.json,.jsonl,.md,.txt,.zip` — zip reserved for Phase C; v1 may disable zip in UI).
2. UI SHALL show: detected adapter, message count, redactions, handoff path, open seed session button if created.
3. UI SHALL call gateway; SHALL NOT parse large files only in renderer without size check.
4. i18n keys for en + ru (project standard).

---

### R11: Security and verification

#### Acceptance Criteria

1. Unit tests: detect, each adapter fixture, redact, heuristic distill, dedupe, size limits.
2. Integration: gateway import → handoff file exists → seed session has seed message.
3. `npm run gate` green after implementation.
4. No adapter may `eval` or execute code from import content.
5. SQLite/DB adapters (Hermes DB, OpenCode DB, Cursor DB) are **out of Phase B** unless explicitly listed; Phase B is **file exports only**.

---

### R12: Extensibility for Phase C–E (design obligation)

#### Acceptance Criteria

1. Design SHALL document adapter interface so ChatGPT ZIP, Claude.ai ZIP, Kiro MD/JSON, Aider MD, Cursor MD can register without changing distill.
2. Design SHALL document why SQLite adapters are separate packages with version sniffing.

---

## Success metrics (product)

- Import OpenCode export or Claude Code jsonl → handoff reseedable in < 5s for ≤ 2 MB files.
- Zero secret-looking tokens in written handoff in fixture tests.
- Round-trip: Kyrei export → import → handoff non-empty intent.

---

## Traceability

| Area | Code touchpoints (existing) |
|------|----------------------------|
| Export (mirror) | `src/lib/session-export.ts` |
| Handoff | `core/engine/memory/handoff.ts` |
| LTM | `core/engine/memory/ltm-bridge.ts` |
| Sessions | `core/gateway.js` `createSession`, message store |
| Secrets | `session-export` redact + `core/engine/security/secrets.js` |
| Research | `docs/research/session-import-platforms.md` |
