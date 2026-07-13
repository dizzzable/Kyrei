# Research Brief: AI SDK 7 migration and Hermes parity

**Date:** 2026-07-13
**Depth:** wide — migration safety, desktop compatibility, security exposure, and feature parity
**Workspace:** `F:\\pi cli\\Kyrei`

## Questions

1. What is the smallest safe path from AI SDK 5 to AI SDK 7 without changing Kyrei's event contract?
2. Which current dependency vulnerabilities disappear after the migration?
3. Which Hermes settings and features are already implemented, partially connected, dormant, or absent in Kyrei?
4. Which parity gap should ship immediately after the migration?

## Current evidence

### AI SDK 7

- The official AI SDK 7 release requires Node.js 22 or newer and ESM. Kyrei already declares `"type": "module"`; local Node is 24.15.0, Electron is 43.1.0, and its bundled Node is 24.18.0.
- Current Kyrei packages are AI SDK 5-era packages. Latest stable versions observed on 2026-07-13 are:
  - `ai@7.0.22`
  - `@ai-sdk/openai@4.0.11`
  - `@ai-sdk/anthropic@4.0.12`
  - `@ai-sdk/google@4.0.12`
  - `@ai-sdk/amazon-bedrock@5.0.17`
  - `@ai-sdk/google-vertex@5.0.16`
  - `@ai-sdk/openai-compatible@3.0.7`
  - `zod@3.25.76` (retained because AI SDK 7 supports it; no unrelated Zod-major migration)
- The official migration path spans both the v6 and v7 guides. Known source changes relevant to Kyrei include:
  - `stepCountIs` becomes `isStepCount`.
  - `system` becomes `instructions`.
  - `StreamTextResult.fullStream` becomes `stream`.
  - mock language models move from the V2 to the V3 contract during the v6 step.
  - provider factory and result-message names must be checked against installed v7 types rather than guessed.
- Kyrei's public renderer event contract is isolated by `core/engine/stream-bridge/bridge.ts`; preserving that adapter boundary should prevent an SDK-specific event rename from leaking into Electron or React code.
- The current AI SDK 5 dependency tree reports low-severity advisory `GHSA-866g-f22w-33x8`; compatible v5 updates do not remove it, so the major migration is the correct remediation path.

### Hermes parity

- The first critical Kyrei gap is not a missing form field but a disconnected enforcement path: terminal/review/rule settings reach config and UI, while `run_command`, `write_file`, and `edit_file` execute without calling `decide()`, pre-hooks, secret scanning, or the approval service.
- Consequently, `off`, `always`, and deny rules can currently give a false impression of protection. The first post-migration parity slice must be an end-to-end local-tool policy gate with regression tests.
- Provider extensibility, secret storage, public import/export, native Google/Bedrock/Vertex adapters, web tools, OpenViking, and optional GBrain integration are already present from the previous delivery. A complete Hermes capability matrix is being collected separately and will be appended below.

## Working decision

Migrate dependencies and compile-time APIs first while preserving the existing Kyrei stream/event boundary. Run the entire quality gate and production build, then implement the local-tool permission gate as an independently tested parity slice. Do not mix unrelated Hermes settings into the SDK compatibility diff.

## Primary sources

- AI SDK 7 release: https://vercel.com/changelog/ai-sdk-7
- AI SDK 7 migration guide: https://raw.githubusercontent.com/vercel/ai/main/content/docs/08-migration-guides/23-migration-guide-7-0.mdx
- AI SDK 6 migration guide: https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0
- AI SDK repository and codemods: https://github.com/vercel/ai

## Migration result

- Resolved direct versions match the target list above; their AI SDK transitives converge on `@ai-sdk/provider@4.0.3`, `@ai-sdk/provider-utils@5.0.7`, and `@ai-sdk/gateway@4.0.16`.
- Both official v6 and v7 codemods were run in dry/print mode over `core` and `tests`; neither produced a safe automatic edit for Kyrei's adapter pattern, so the small boundary migration was performed manually and compiler-verified.
- Kyrei now uses `instructions`, `stream`, `responseMessages`, `isStepCount`, `MockLanguageModelV4`, `createGoogle`, and `createGoogleVertex`.
- The engine build target is Node 22; Electron 43 remains above that contract.
- `npm audit --omit=dev --json`: 0 total vulnerabilities. The old `@ai-sdk/provider-utils@3.0.28` lineage affected by `GHSA-866g-f22w-33x8` is absent.
- Deterministic eval: 100% pass rate, median 2 steps, median 60 tokens. This locks the v7 usage shape rather than silently accepting zero-token metrics.
- Independent review found and fixed one P1 regression: AI SDK 7 emits `start`/`start-step` before early provider errors, so the fallback adapter now buffers and replays that preamble before deciding whether to retry.
- Full verification after the fix: 43 test files / 323 tests, both TypeScript projects, JavaScript checks, engine bundle, renderer production build, and `package:prepare` passed.

## Hermes/Kyrei capability conclusion

The exhaustive local audit is recorded in `docs/research/hermes-parity-matrix.md`. The highest-value order is:

1. End-to-end approvals and local-tool policy enforcement.
2. Bounded read-only delegation with a single writer.
3. Skills list/view plus provenance, followed by controlled installation.
4. Two-stage context compression with structured summaries and CCR recall.
5. Typed auxiliary model routing and provider-profile-scoped fallbacks.

Cloud gateway/account coupling, mass messaging platforms, unrestricted CDP/browser eval, and cosmetic pet/embed features are rejected for Kyrei's local desktop direction.

## First parity slice delivered

The post-migration safety slice now enforces permission rules, terminal mode, review mode, secret scanning, cancellation, sandbox wrapping, and correlated metadata-only audit for local mutations, commands, diagnostics, and web tools. Malformed permission config recovers conservatively instead of resetting to permissive defaults. Live target validation rejects symlink/junction/reparse and Windows alias escapes for reads and writes.

`ask` is intentionally fail-closed: it returns a model-visible denial and executes nothing. Interactive approve/deny remains a separate durable AI SDK approval-message resume flow; an in-memory waiting promise was rejected because renderer disconnect, cancellation, or app restart could orphan it.

Verification after independent security review: 43 test files / 349 tests, both TypeScript projects, JavaScript checks, engine and renderer production builds, package preparation, and zero production audit findings.
