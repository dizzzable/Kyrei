# Hermes Operational Chrome and Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use focused native subagents for isolated stores, engine tools, and renderer panels; keep the gateway and `App.tsx` integration under one owner.

**Goal:** Turn Kyrei's Hermes-like chrome into working product surfaces by adding Skills, live gateway/context/session telemetry, a read-only agent monitor, durable Cron jobs, and correct native-titlebar-safe settings geometry.

**Architecture:** Keep Electron closed and local-first. Durable capability data lives under Kyrei's application data directory, the loopback gateway exposes authenticated REST/SSE contracts, and the engine receives only validated skill documents plus bounded read-only delegation. The renderer consumes typed contracts and keeps every visible label in the EN/RU catalogs.

**Tech Stack:** Electron 43, React 19, TypeScript, Node standard library, AI SDK 7, Radix UI, Vitest, Playwright CLI.

---

### Task 1: Add a durable Agent Skills registry

**Files:**
- Create: `core/skills-store.js`
- Create: `tests/skills-store.test.ts`

- [ ] Write regression tests for first-run creation of `<dataDir>/skills`, discovery of global/project/custom `SKILL.md` files, frontmatter parsing, duplicate-safe IDs, enable/disable persistence, usage counters, custom-root removal, safe creation, and rejection of invalid skill names.
- [ ] Implement `SkillsStore` with `load()`, `setWorkspace()`, `list()`, `get()`, `setEnabled()`, `create()`, `delete()`, `addRoot()`, `removeRoot()`, `recordUsage()`, and `runtimeSkills()`.
- [ ] Skip symbolic links, cap each document and aggregate runtime content, and return provenance (`global`, `project`, `custom`) without executing skill code.
- [ ] Run `npx vitest --run tests/skills-store.test.ts` and require all tests to pass.

### Task 2: Make Skills available to the engine progressively

**Files:**
- Create: `core/engine/tools/skills.ts`
- Create: `core/engine/tools/skills.test.ts`
- Modify: `core/engine/types.ts`
- Modify: `core/engine/prompt/system.ts`
- Modify: `core/engine/prompt/tool-descriptions.ts`
- Modify: `core/engine/orchestrator/run.ts`
- Modify: `core/engine/prompt/prompt.test.ts`

- [ ] Define a serializable `RuntimeSkill` contract containing stable id, name, description, provenance, and bounded markdown content.
- [ ] Build a `read_skill` tool that lists only known IDs, returns only the selected markdown, and calls the gateway-owned usage callback.
- [ ] Add enabled skill summaries to the system prompt and instruct the model to load a skill only when the request matches it.
- [ ] Merge the skill tool with workspace/web/memory tools without requiring a workspace.
- [ ] Update the versioned prompt snapshot and engine tests.

### Task 3: Add a real bounded read-only delegation tool

**Files:**
- Create: `core/engine/orchestration/delegate.ts`
- Create: `core/engine/orchestration/delegate.test.ts`
- Modify: `core/engine/types.ts`
- Modify: `core/engine/config/schema.ts`
- Modify: `core/engine/orchestrator/run.ts`

- [ ] Add validated delegation settings: enabled flag, maximum tasks per call, and maximum parallel workers.
- [ ] Give child runs only `list_dir`, `read_file`, `grep_search`, `find_path`, project-intelligence, public-web-read, and read-only memory tools; never expose writes, commands, or recursive delegation.
- [ ] Emit `subagent.start`, `subagent.progress`, and terminal `subagent.complete`/`subagent.failed` frames with goal, model, duration, token/tool counts, files read, and summary.
- [ ] Return compact child summaries to the parent tool call and obey the parent abort signal.

### Task 4: Add durable local Cron scheduling

**Files:**
- Create: `core/cron-store.js`
- Create: `core/cron-scheduler.js`
- Create: `tests/cron-store.test.ts`

- [ ] Test strict five-field cron parsing for wildcards, steps, lists and ranges; reject impossible expressions.
- [ ] Persist jobs atomically with id, name, prompt, expression, enabled state, last/next run, and bounded run history.
- [ ] Implement create/update/delete/pause/resume/trigger and a scheduler that fires each due job once per minute.
- [ ] Ensure scheduler timers stop during gateway shutdown and manual trigger uses the same run callback as scheduled execution.

### Task 5: Expose authenticated capability and telemetry APIs

**Files:**
- Modify: `electron/main.js`
- Modify: `core/gateway.js`
- Modify: `src/lib/gateway.ts`
- Modify: `src/lib/types.ts`
- Create: `tests/gateway-capabilities.test.ts`

- [ ] Expand `/api/status` with readiness, uptime, active runs, platform, provider/model, skill totals, and cron totals without secrets.
- [ ] Add `/api/skills` list/view/toggle/create/delete/roots/open-folder endpoints and restrict OS folder opening to registry-owned paths.
- [ ] Add `/api/cron/jobs` CRUD/pause/resume/trigger/runs endpoints.
- [ ] Pass validated runtime skills and usage callbacks into `runKyreiChat()`.
- [ ] Run Cron jobs through a new local session tagged `source: cron`, record run IDs, and emit normal session events.
- [ ] Return complete session metadata on creation so live timers survive selection and reload.

### Task 6: Build the Capabilities / Skills settings surface

**Files:**
- Create: `src/components/settings/SkillsSettings.tsx`
- Modify: `src/components/Settings.tsx`
- Modify: `src/components/settings/settings-registry.ts`
- Modify: `src/components/shell/activity-registry.ts`
- Modify: `src/i18n/locales/en/settings.ts`
- Modify: `src/i18n/locales/ru/settings.ts`
- Modify: `src/components/settings/settings-copy.test.ts`

- [ ] Route Capabilities to a dedicated `skills` settings section.
- [ ] Show global, project and custom skill roots with open/add/remove controls.
- [ ] Show discovered skills with search, provenance, usage, enable switch, path, and markdown preview.
- [ ] Allow creation and deletion only in user-owned global/project roots; refresh after mutations.
- [ ] Keep every visible label and error in the typed EN/RU catalog.

### Task 7: Replace the decorative status bar with live controls

**Files:**
- Create: `src/lib/status-metrics.ts`
- Create: `src/components/agents/AgentsPanel.tsx`
- Create: `src/components/cron/CronPanel.tsx`
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/locales/en/shell.ts`
- Modify: `src/i18n/locales/ru/shell.ts`
- Create: `src/components/StatusBar.test.tsx`

- [ ] Implement Gateway menu polling with real online/degraded/offline state and runtime details.
- [ ] Implement Agents action backed by live subagent frames, including running/failed counts and a detail panel.
- [ ] Implement Cron action backed by the durable job API, including create/edit/pause/resume/run/delete and run history.
- [ ] Show used/context-window tokens, percentage meter, turn timer, session timer, global Turbo toggle, developer activity toggle, version and commit.
- [ ] Hide lower-value items responsively without introducing horizontal scrolling.

### Task 8: Correct native window safe areas and modal stacking

**Files:**
- Modify: `src/components/Settings.tsx`
- Modify: `src/components/ui/dialog.tsx`
- Modify: `src/index.css`

- [ ] Keep full-screen overlays below the 34px native titlebar and above the 20px status bar.
- [ ] Preserve one in-app close action while removing overlap with Windows/Linux native controls.
- [ ] Keep mobile/narrow layouts scrollable and prevent background content from painting through the overlay.

### Task 9: Verify functionality, localization, and visual parity

**Files:**
- Update: `.omx/state/statusbar-skills-parity/ralph-progress.json`
- Update: `.jez/artifacts/design-review.md`

- [ ] Run focused store, engine, gateway, renderer and localization tests.
- [ ] Run `npm run gate`, `npm run build`, and `git diff --check`.
- [ ] Launch a fresh Electron instance with remote debugging and exercise Skills, Gateway, Agents, Cron, Turbo, EN/RU switching, and settings close/scroll behavior at 1456×928, 900×700, and 720×600.
- [ ] Capture screenshots under `output/playwright/`, run `visual-verdict` against the supplied Hermes/status/settings references, and continue until the score is at least 90.
- [ ] Request an independent final code review and resolve all high/medium findings.
