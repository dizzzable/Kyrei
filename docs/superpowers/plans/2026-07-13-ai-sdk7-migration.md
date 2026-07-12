# AI SDK 7 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Kyrei from AI SDK 5 to the current stable AI SDK 7 family, remove the affected dependency advisory, and preserve the existing engine and renderer behavior.

**Architecture:** Keep AI SDK-specific APIs behind Kyrei's provider, open-stream, orchestrator, and stream-bridge adapters. Migrate compile-time contracts at those boundaries, preserve the `KyreiEvent` protocol, and prove behavior with deterministic mock-model and synthetic-stream tests before the full desktop build.

**Tech Stack:** TypeScript 7, Node.js 24, Electron 43, AI SDK 7, Vitest 4, Vite 8, esbuild

---

## Task 1: Lock the existing engine boundary

**Files:**
- Modify: `core/engine/provider/open-stream.test.ts`
- Modify: `core/engine/stream-bridge/bridge.test.ts`
- Test: `core/engine/provider/open-stream.test.ts`
- Test: `core/engine/stream-bridge/bridge.test.ts`

- [x] Add a regression test proving the open-stream adapter replays the peeked first part and preserves the response messages promise.
- [x] Add or retain deterministic tests proving text deltas, aborts, tool results, tool failures, usage, and stable tool-call IDs map to the same `KyreiEvent` shapes.
- [x] Run `npx vitest --run core/engine/provider/open-stream.test.ts core/engine/stream-bridge/bridge.test.ts` and record the green pre-migration baseline.

## Task 2: Upgrade the AI SDK dependency family

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] Set Node engine compatibility to `>=22` so unsupported runtimes fail explicitly.
- [x] Upgrade `ai` and all six `@ai-sdk/*` providers; retain the already-compatible `zod@3.25.76` to avoid an unrelated major migration.
- [x] Install dependencies and inspect the resolved package tree with `npm ls ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/amazon-bedrock @ai-sdk/google-vertex @ai-sdk/openai-compatible zod`.
- [x] Run the official v6 and v7 `@ai-sdk/codemod` transforms in dry/print mode, inspect the result, and apply the adapter changes manually where the transforms do not match Kyrei.

## Task 3: Migrate runtime API boundaries

**Files:**
- Modify: `core/engine/orchestrator/run.ts`
- Modify: `core/engine/orchestrator/stop-conditions.ts`
- Modify: `core/engine/provider/open-stream.ts`
- Modify: `core/engine/provider/build.ts`
- Modify: `core/engine/stream-bridge/bridge.ts`
- Modify: `core/engine/types.ts`
- Modify: `tests/eval/harness.ts`

- [x] Replace deprecated v5/v6 option and stop-condition names with AI SDK 7 equivalents (`instructions`, `isStepCount`, and `stream`).
- [x] Adapt response-message access and Google/provider factory names according to the installed v7 declarations.
- [x] Update mock model contracts and stream chunk shapes to the v7 test API.
- [x] Keep `StreamLike` and `bridgeStream` as Kyrei-owned interfaces so SDK changes do not propagate into the renderer protocol.
- [x] Run `npm run typecheck:engine` and fix all SDK type errors without weakening types or adding broad casts.
- [x] Run `npm run typecheck:renderer` and confirm no renderer API changes escaped the adapter boundary.

## Task 4: Verify providers and deterministic engine behavior

**Files:**
- Modify if required: `core/engine/provider/provider.test.ts`
- Modify if required: `tests/provider-config.test.ts`
- Modify if required: `core/engine/orchestrator/run.test.ts`
- Test: `core/engine/provider/provider.test.ts`
- Test: `tests/provider-config.test.ts`
- Test: `core/engine/orchestrator/run.test.ts`
- Test: `tests/eval/eval.test.ts`

- [x] Add/update construction tests for OpenAI, Anthropic, Google, Bedrock, Vertex, and OpenAI-compatible models without network calls.
- [x] Run `npx vitest --run core/engine/provider/provider.test.ts tests/provider-config.test.ts core/engine/orchestrator/run.test.ts tests/eval/eval.test.ts`.
- [x] Run `npm audit --omit=dev --json` and verify the previous AI SDK advisory is no longer present; document any unrelated residual advisories.

## Task 5: Verify desktop packaging boundaries

**Files:**
- Modify if required: `scripts/build-engine.mjs`
- Verify: `core/engine/.dist/index.mjs`
- Verify: `dist/renderer/`

- [x] Run `npm run build:engine` and confirm AI SDK packages remain intentionally externalized for Electron packaging.
- [x] Run `npm run build` and confirm the production renderer builds.
- [x] Run `npm run gate` and require all typechecks, JS checks, builds, and tests to pass.
- [x] Run a packaging dry path (`npm run package:prepare`) to catch ESM/runtime resolution problems before release packaging.

## Task 6: Independent review and migration record

**Files:**
- Modify: `.jez/artifacts/research-brief-ai-sdk7-hermes-parity.md`
- Modify: `docs/superpowers/plans/2026-07-13-ai-sdk7-migration.md`

- [x] Append exact resolved versions, changed APIs, audit output, and verification evidence to the research brief.
- [x] Request an independent code review focused on stream semantics, tool-loop behavior, provider construction, Electron ESM loading, and dependency security.
- [x] Fix every high/medium finding and rerun the smallest affected test followed by `npm run gate`.
- [x] Mark all completed checklist items and create a Lore-protocol commit containing only the migration and its evidence artifacts.
