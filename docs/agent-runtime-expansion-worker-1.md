# Kyrei agent-runtime expansion — worker-1 findings (provider + memory lanes)

Date: 2026-07-13
Worker: worker-1
Tasks: 1, 3

## Scope

This report covers:

1. unlimited generic custom provider architecture and UI/gateway migration, excluding any Hermes native provider implementation; and
2. memory / project-intelligence architecture comparing current Kyrei modules with OpenViking, Graphify, and SocratiCode.

No implementation edits are proposed here beyond safe first slices and exact touchpoints.

---

## Task 1 — provider architecture

### Current Kyrei constraints (local evidence)

Kyrei is still single-provider and single-secret end to end:

- `core/gateway.js:53-55` stores one config object with `provider`, `apiKey`, `model`, `workspace` in `kyrei-config.json`.
- `core/gateway.js:79-89` exposes only one provider/model pair plus `hasKey`.
- `core/gateway.js:108-127` passes exactly one `providerBase`, one `apiKey`, and one `model` into `runKyreiChat`.
- `core/gateway.js:168-180` only accepts `{ provider, apiKey, model, workspace, engine }` on `PUT /api/config`.
- `core/gateway.js:302-308` returns `/api/models` from a static registry, plus only one current `provider` and `model`.
- `src/lib/types.ts:45-52` defines `AppConfig` as one `provider`, one `model`, one `hasKey`.
- `src/lib/gateway.ts:39-41` and `src/components/Settings.tsx:72-118,272-318` hard-code one provider URL field, one API key, and one model input.
- `src/components/StatusBar.tsx:41-50` and `src/App.tsx:177-185` assume a single active provider/model for presets and status.
- `core/engine/types.ts:119-131` only allows one `providerBase` and one `apiKey` in `RunKyreiChatOpts`.
- `core/engine/provider/build.ts:7-31` already uses `@ai-sdk/openai-compatible`, so Kyrei already has the right primitive for generic OpenAI-compatible providers.
- `core/engine/provider/registry.ts:26-77` is a static model table with fallback to a synthetic `custom` provider; model IDs are not provider-scoped.

### What OpenCode is doing that is relevant

OpenCode’s provider docs show the useful pattern to copy conceptually, but not literally:

- credentials are stored separately from provider config (`/connect` stores them in `~/.local/share/opencode/auth.json`): <https://opencode.ai/docs/providers/> (lines 182-189 in the current docs snapshot).
- provider configuration is a map keyed by provider ID, with `name`, `options.baseURL`, optional `options.apiKey` / `headers`, and per-provider `models`: <https://opencode.ai/docs/providers/> (custom provider section, lines 2495-2684).
- default models are provider-scoped as `provider_id/model_id`: <https://opencode.ai/docs/models/> (lines 126-142).

Important adaptation for Kyrei: OpenCode exposes an `npm` field so users can point to arbitrary AI SDK packages. Kyrei should **not** copy that part. Executing arbitrary provider packages from user config would expand the trust boundary too far for a desktop app. Kyrei should keep a **closed internal protocol enum** and only support built-in adapters.

### Recommended Kyrei v2 provider model

#### 1) Split provider definition from credential storage

Keep provider metadata in the normal config file, but move secrets to a separate local-only secret store.

Suggested shapes:

```ts
export type ProviderProtocol = "openai-chat" | "openai-responses";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  limits?: { contextWindow?: number; maxOutput?: number };
  caps?: { tools?: boolean; reasoning?: boolean; streaming?: boolean; vision?: boolean };
}

export interface ProviderConfigRecord {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  headers?: Record<string, string>;
  models: ProviderModelConfig[];
  enabled: boolean;
}

export interface GatewayConfigV2 {
  activeProviderId: string;
  activeModelId: string;
  providers: ProviderConfigRecord[];
  workspace: string;
  engine?: Record<string, unknown>;
}

export interface ProviderSecretsFile {
  providers: Record<string, { apiKey?: string }>;
}
```

Why this shape fits current Kyrei:

- it preserves `hasKey`-style redaction already used by `core/gateway.js:79-89`;
- it maps cleanly onto the existing AI SDK builder in `core/engine/provider/build.ts:21-31`;
- it avoids arbitrary code loading;
- it lets one provider expose many models without overloading `providerRoles`.

#### 2) Make model references provider-scoped everywhere

Use `providerId/modelId` as the canonical selection key.

That fixes a current collision risk in:

- `src/components/composer/ModelPill.tsx:135-145` (grouping by provider for display only);
- `src/store/model-presets.ts` usage via `src/App.tsx:177-185` (presets are currently keyed by raw provider+model pair but the active selection still comes from a single global provider field);
- `core/engine/provider/registry.ts:55-67` (unknown model fallback cannot distinguish two providers exposing the same model ID).

#### 3) Keep provider adapters closed and explicit

Safe initial adapter set:

- `openai-chat` → current `@ai-sdk/openai-compatible` path
- `openai-responses` → add a second built-in adapter later if needed for providers that require `/v1/responses`

Do **not** add arbitrary `npm` provider package loading.

### Gateway/API migration plan

#### Current files to change first

- `core/gateway.js`
- `src/lib/types.ts`
- `src/lib/gateway.ts`
- `src/components/Settings.tsx`
- `src/components/StatusBar.tsx`
- `src/components/composer/ModelPill.tsx`
- `core/engine/types.ts`
- `core/engine/provider/registry.ts`
- `core/engine/provider/build.ts`
- `core/engine/orchestrator/run.ts`

#### Proposed HTTP surface

Keep `/api/config`, but move it to the v2 shape and add provider CRUD so the renderer does not rewrite the entire config for small edits.

Suggested endpoints:

- `GET /api/config` → `GatewayConfigV2` + `providerStatuses: Record<id, { hasKey: boolean }>`
- `PUT /api/config` → update global fields (`activeProviderId`, `activeModelId`, `workspace`, `engine`)
- `GET /api/providers` → provider list with `hasKey`
- `POST /api/providers` → create provider
- `PATCH /api/providers/:id` → update provider metadata
- `DELETE /api/providers/:id` → delete provider + optional secret cleanup
- `PUT /api/providers/:id/secret` → set or replace API key
- `DELETE /api/providers/:id/secret` → remove API key
- `POST /api/providers/:id/models:refresh` → optional explicit remote `/models` pull

### Migration from today’s single-provider config

On gateway startup:

1. If legacy config has `provider`, `apiKey`, `model` and no `providers`, create one migrated provider record.
2. Suggested migrated ID: `default-openai-compatible`.
3. Put legacy `provider` URL into `baseURL`.
4. Put legacy `model` into that provider’s `models` array if absent.
5. Move legacy `apiKey` into the secrets file.
6. Replace top-level `provider`/`model` with `activeProviderId`/`activeModelId`.
7. Preserve `workspace` and `engine` unchanged.

This is the smallest safe migration because it keeps `core/gateway.js:53-55` semantics while removing secrets from the general config.

### UI migration

#### Settings

Replace the single form in `src/components/Settings.tsx:272-318` with:

- left column: provider list (`name`, protocol badge, key-present badge, enabled/disabled)
- right column: selected provider editor
  - display name
  - base URL
  - protocol
  - custom headers
  - model list editor
  - secret save/remove controls
- top-level active provider + active model selectors

#### Model picker

`src/components/composer/ModelPill.tsx` should switch from "one current provider, many grouped models" to "provider-scoped model entries" where the selected value is fully-qualified.

#### Status surfaces

`src/components/StatusBar.tsx:41-50` should show provider display name first, raw base URL only as hover detail.

### Engine migration

#### Minimal engine contract change

Change `core/engine/types.ts:119-131` from one raw provider base to a provider selection envelope:

```ts
export interface ActiveProviderSelection {
  providerId: string;
  modelId: string;
  protocol: ProviderProtocol;
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
}
```

Then pass that through `runKyreiChat` instead of raw `providerBase` + `apiKey` + `model` fields.

#### Registry changes

`core/engine/provider/registry.ts` should stop being the source of truth for user providers. It should become either:

- a built-in capability hint table for known public models; or
- a resolver that merges built-in hints with gateway-configured provider/model records.

### Safe staged implementation order

1. **Persistence split only**: migrate secrets out of `kyrei-config.json`, keep one provider in UI.
2. **Provider list CRUD**: multiple providers in gateway + settings, still one active selection.
3. **Provider-scoped model keys**: update picker, presets, status bar, `/api/models` payload.
4. **Optional model refresh**: explicit per-provider `/models` fetch button.
5. **Protocol expansion**: add built-in responses adapter only if needed.

### Tests to add

#### Gateway/config

- legacy single-provider config migrates to `providers[]` + secrets file
- `GET /api/config` never returns raw API keys
- deleting a provider clears active selection safely
- deleting the active provider reassigns or empties selection deterministically

#### Renderer

- settings can add/edit/remove multiple providers
- model picker preserves fully-qualified selection keys
- presets remain stable when two providers expose the same model ID

#### Engine

- provider resolver chooses the active provider/model record, not just a model string
- fallback chains work across provider-qualified IDs
- custom headers are passed only for the selected provider

### Key risks

- model-ID collisions if Kyrei keeps raw `model` strings
- secret leakage if API keys stay in the shared config blob
- unsafe expansion of the trust boundary if Kyrei copies OpenCode’s arbitrary `npm` provider package loading
- brittle UX if remote model enumeration becomes implicit rather than explicit

### Task 1 bottom line

Kyrei already has the correct base primitive (`@ai-sdk/openai-compatible`), but its persistence, API, and UI are still locked to one provider. The correct migration is:

- **provider registry in config**,
- **credentials in a separate local secret store**,
- **fully-qualified provider/model IDs**,
- **closed built-in adapter enum rather than arbitrary provider packages**.

---

## Task 3 — memory / project intelligence architecture

### Current Kyrei baseline (local evidence)

Kyrei already has a stronger local-first substrate than the UI currently exposes:

- `core/engine/data/ports.ts:35-93` already defines swappable `SessionStore`, `MemoryStore`, and `VectorStore` interfaces.
- `core/engine/data/sqlite/schema.ts:21-93` already has SQLite tables for sessions, messages FTS, memory docs FTS, and vectors.
- `core/engine/data/sqlite/memory-store.ts:39-107` already supports upsert/list/search over memory docs with FTS.
- `core/engine/data/sqlite/vector-store.ts:37-87` already supports vector upsert/query/hybrid entry points, though current retrieval is brute-force cosine.
- `core/engine/context/ccr.ts:39-134` provides content-addressable reversible compaction recall.
- `core/engine/context/compaction.ts:42-89` already prunes older tool outputs while keeping recall handles.
- `core/engine/memory/layers.ts:43-55` assembles layered project memory from `AGENTS.md`, steering, project memory, and optional global memory.
- `core/engine/memory/ltm-bridge.ts:41-106` already bridges to a long-term event/checkpoint ledger.
- `core/engine/memory/handoff.ts:11-80` already supports clean-window handoff artifacts.
- `core/engine/memory/writer.ts:11-35` enforces memory write boundaries by role.

So Kyrei does **not** need a fresh external memory core. It needs:

1. better orchestration over what already exists,
2. graph/project-intelligence enrichment, and
3. an optional remote adapter boundary.

### Comparison with OpenViking

Useful patterns:

- OpenViking explicitly frames context as a filesystem-like memory/resource/skill store with tiered loading and directory recursive retrieval: <https://github.com/volcengine/OpenViking> (README lines 412-420 in the current snapshot).
- It supports a standalone HTTP server mode: <https://github.com/volcengine/OpenViking/blob/main/docs/en/getting-started/03-quickstart-server.md> (lines 247-285).
- Its server auth is multi-tiered (`user_key` vs `root_key`): same doc, lines 292-320.
- Its config supports local workspace + local AGFS/vector backends, but also remote storage expansion: <https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/01-configuration.md> (lines 258-277, 1232-1255, 1562-1576).
- It ships an official Docker deployment path: <https://github.com/volcengine/OpenViking/blob/main/docker-compose.yml> (lines 389-413).
- Its resource API includes `add_resource`, scheduled watches, and URI-based targeting: <https://github.com/volcengine/OpenViking/blob/main/docs/en/api/02-resources.md> (lines 357-406, 703-720).

Why not embed it:

- OpenViking’s main project is AGPLv3: <https://github.com/volcengine/OpenViking> and <https://github.com/volcengine/OpenViking/blob/main/LICENSE>.
- There is an auth footgun documented in issue #302 (`root_api_key` missing can disable effective auth): <https://github.com/volcengine/OpenViking/issues/302>.

Recommendation:

- treat OpenViking as an **optional external context service** only;
- never vendor its main AGPL code into MIT Kyrei;
- if integrated, use a narrow HTTP adapter over loopback / user-configured local Docker.

### Comparison with Graphify

Useful patterns:

- Graphify is MIT-licensed and explicitly local-first: <https://github.com/Graphify-Labs/graphify> (repo navigation shows MIT; README lines 307-310).
- It builds an explicit traversable graph rather than only a vector index: same README lines 307-310, 323-330.
- It explains edges as extracted vs inferred, which is a very good trust pattern for agent memory: same README line 309.
- It can serve the graph over stdio or HTTP, but defaults to loopback and documents API-key protection when exposed: <https://github.com/Graphify-Labs/graphify> (lines 615-641).

Fit for Kyrei:

- conceptually strong for project intelligence;
- license-compatible to study and reimplement patterns;
- but currently Python-based and built around its own artifact format (`graphify-out/graph.json`), so it is better as a **pattern source or import source**, not as a bundled dependency in Kyrei’s first slice.

### Comparison with SocratiCode

Useful patterns:

- strong codebase intelligence pitch: hybrid semantic search, dependency graphs, call-flow, cross-project search: <https://github.com/giancarloerra/SocratiCode> and package metadata lines 486-505 plus <https://github.com/giancarloerra/SocratiCode/blob/main/package.json>.
- operationally, default mode depends on Docker plus Qdrant/Ollama: <https://github.com/giancarloerra/SocratiCode> (Docker references around lines 584-590 and 1351-1375).
- it is local/private in positioning, but dual-licensed AGPL/commercial: <https://github.com/giancarloerra/SocratiCode> and license pages <https://github.com/giancarloerra/SocratiCode/blob/main/LICENSE>, <https://github.com/giancarloerra/SocratiCode/blob/main/LICENSE-COMMERCIAL>.

Fit for Kyrei:

- good inspiration for search-first agent behavior and symbol/dependency intelligence;
- not suitable to embed into MIT Kyrei because of AGPL/commercial licensing and heavier runtime stack.

### Recommended Kyrei memory architecture

#### Principle 1: keep SQLite local memory as the canonical built-in backend

Kyrei already has the right default boundary:

- durable local docs (`memory_docs`)
- local FTS
- local vectors
- reversible compaction
- project/global memory layers
- long-term event/checkpoint bridge

That should stay the built-in default because it is cross-platform, offline-capable, and license-clean.

#### Principle 2: add graph/project intelligence as a second local index, not as a replacement

Recommended new local seam:

```ts
export interface ProjectIntelHit {
  id: string;
  kind: "memory" | "file" | "symbol" | "edge" | "remote-resource";
  title: string;
  snippet?: string;
  score: number;
  source: "sqlite" | "graph" | "openviking";
  path?: string;
}

export interface ProjectIntelAdapter {
  health(): Promise<{ ok: boolean; mode: "local" | "remote" }>;
  ingestWorkspace(workspace: string): Promise<void>;
  search(query: string, opts?: { limit?: number }): Promise<ProjectIntelHit[]>;
  neighbors(id: string, opts?: { limit?: number }): Promise<ProjectIntelHit[]>;
}
```

First local implementation should sit on top of SQLite, not replace it.

#### Principle 3: make external systems adapters, not dependencies

Recommended adapters:

- `sqlite-local` (default)
- `openviking-http` (optional, user-managed Docker/service)
- later: `graph-import` for importing Graphify-style graph JSON

This matches the backend-swappable intent already visible in `core/engine/data/ports.ts:1-7`.

### Safe staged plan

#### Stage A — activate Kyrei’s existing memory stack

No external dependency yet.

1. wire memory docs + checkpoints into actual retrieval orchestration before full prompt assembly;
2. surface recent project memory / handoff data in the prompt builder before broad file reads;
3. add explicit search-before-read retrieval policy in agent prompting.

This gets immediate value from current modules.

#### Stage B — add local graph tables

Add SQLite tables like:

- `project_nodes(id, kind, label, path, meta_json, updated_at)`
- `project_edges(src_id, dst_id, type, provenance, weight)`

and keep provenance explicit:

- `EXTRACTED` for deterministic edges
- `INFERRED` for heuristic edges

That borrows the best Graphify idea without adding a Python dependency.

#### Stage C — add importer / watcher seams

Good first ingestion targets:

- workspace files
- current handoff/checkpoint/memory docs
- optional imported graph JSON
- optional remote OpenViking resources through HTTP

#### Stage D — optional OpenViking adapter through Docker

Provide a user-managed local Docker path only:

- store adapter config separately from core memory data;
- default to `http://127.0.0.1:1933` if explicitly enabled;
- require explicit API key configuration when auth is enabled;
- never silently fall back to unauthenticated remote access.

Suggested Kyrei boundary:

- health check
- add resource
- search/find
- optional watches

Do **not** mirror the full OpenViking surface initially.

### Exact touchpoints for a future implementation

Primary local files:

- `core/engine/data/ports.ts`
- `core/engine/data/sqlite/schema.ts`
- `core/engine/data/sqlite/memory-store.ts`
- `core/engine/data/sqlite/vector-store.ts`
- `core/engine/context/ccr.ts`
- `core/engine/context/compaction.ts`
- `core/engine/memory/layers.ts`
- `core/engine/memory/ltm-bridge.ts`
- `core/engine/orchestrator/run.ts`

New likely files:

- `core/engine/intel/types.ts`
- `core/engine/intel/sqlite-graph.ts`
- `core/engine/intel/openviking-adapter.ts`
- `core/engine/intel/search.ts`

### Tests to add

#### Local memory/intel

- graph-node/edge upsert and delete behavior
- provenance preservation (`EXTRACTED` vs `INFERRED`)
- search ranking merges FTS, vector, and graph-neighbor boosts deterministically
- prompt assembly prefers memory/intel hits before broad file reads

#### OpenViking adapter

- adapter disabled by default
- loopback health check and auth-required flows
- error handling when server is absent or misconfigured
- no writes to remote service unless user explicitly enabled adapter

### Licensing / operational conclusions

- **OpenViking**: valuable architecture, but main project is AGPLv3; use only as an optional external HTTP service.
- **Graphify**: best source for local graph ideas; MIT-compatible; use patterns or import artifacts, not first-slice bundling.
- **SocratiCode**: strong ideas for hybrid search and dependency/call-flow intelligence, but AGPL/commercial plus Docker/Qdrant/Ollama stack make it unsuitable to embed.

### Task 3 bottom line

Kyrei already has enough local primitives to ship a stronger memory system without adopting an external AGPL core. The best path is:

- **keep SQLite + existing memory modules as the default canonical backend**,
- **add a provenance-aware local graph layer**,
- **treat OpenViking as an optional Docker-backed HTTP adapter**,
- **borrow Graphify/SocratiCode patterns, not their codebases**.

---

## Recommended overall order for the leader

1. provider persistence split (`config` vs `secrets`)
2. multi-provider UI/gateway CRUD
3. provider-qualified model identities and picker migration
4. activate current memory retrieval/handoff/checkpoint orchestration
5. add local graph tables + provenance-aware search fusion
6. optional OpenViking adapter behind explicit Docker configuration

## Source links

### Local repo

- `core/gateway.js`
- `core/engine/types.ts`
- `core/engine/provider/build.ts`
- `core/engine/provider/registry.ts`
- `core/engine/orchestrator/run.ts`
- `src/lib/types.ts`
- `src/lib/gateway.ts`
- `src/components/Settings.tsx`
- `src/components/composer/ModelPill.tsx`
- `core/engine/data/ports.ts`
- `core/engine/data/sqlite/{schema,memory-store,vector-store}.ts`
- `core/engine/context/{ccr,compaction}.ts`
- `core/engine/memory/{layers,ltm-bridge,writer,handoff}.ts`

### External

- OpenCode providers: <https://opencode.ai/docs/providers/>
- OpenCode models: <https://opencode.ai/docs/models/>
- OpenViking repo: <https://github.com/volcengine/OpenViking>
- OpenViking server quickstart: <https://github.com/volcengine/OpenViking/blob/main/docs/en/getting-started/03-quickstart-server.md>
- OpenViking config: <https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/01-configuration.md>
- OpenViking Docker compose: <https://github.com/volcengine/OpenViking/blob/main/docker-compose.yml>
- OpenViking resources API: <https://github.com/volcengine/OpenViking/blob/main/docs/en/api/02-resources.md>
- OpenViking auth bug: <https://github.com/volcengine/OpenViking/issues/302>
- Graphify repo: <https://github.com/Graphify-Labs/graphify>
- SocratiCode repo: <https://github.com/giancarloerra/SocratiCode>
- SocratiCode package metadata: <https://github.com/giancarloerra/SocratiCode/blob/main/package.json>
- SocratiCode license: <https://github.com/giancarloerra/SocratiCode/blob/main/LICENSE>
- SocratiCode commercial license: <https://github.com/giancarloerra/SocratiCode/blob/main/LICENSE-COMMERCIAL>
