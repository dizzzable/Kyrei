# Linear + Hermes Desktop Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Kyrei's cross-platform desktop renderer with Linear's visual system and Hermes' proven desktop information architecture, while preserving Kyrei features and providing complete English and Russian localization with no user-facing hardcode.

**Architecture:** Keep the existing Electron/gateway/engine boundary. Recompose only the renderer shell into persistent developer, conversation and activity rails; expose Kyrei functions through typed registries. Replace the partial nested dictionary with domain-owned, strictly typed locale modules composed into one catalog. Treat unavailable runtime capabilities as honest localized empty states, not simulated functionality.

**Tech Stack:** Electron 43, React 19, TypeScript 7, Vite 8, Tailwind CSS 4, Radix UI, Lucide, Vitest, Playwright CLI.

---

## Ownership rules

- Shell owner alone edits `src/App.tsx` and `src/index.css` during the parallel phase.
- Locale modules are divided by domain. Workers do not edit another domain's catalog.
- Settings owner preserves every existing config field and provider action.
- Composer owner preserves queue, attachments, voice, snippets, model options, slash commands and streaming controls.
- No product dependency is added. Browser tooling may be installed transiently for visual verification only.

### Task 1: Lock the design and localization contracts

**Files:**
- Modify: `.kiro/specs/kyrei-desktop-ui/design.md`
- Create: `.jez/artifacts/design-review.md`
- Create: `src/i18n/types.ts`
- Create: `src/i18n/translate.ts`
- Create: `src/i18n/locales/en/common.ts`
- Create: `src/i18n/locales/ru/common.ts`
- Modify: `src/i18n/index.tsx`
- Test: `src/i18n/catalog.test.ts`
- Test: `src/i18n/translate.test.ts`

- [ ] Write failing catalog parity, interpolation/plural and startup-locale tests.
- [ ] Define `Lang`, message-value and typed translator contracts without third-party i18n dependencies.
- [ ] Validate stored locale, default to system language with English fallback, and synchronize `<html lang>` on initial render and changes.
- [ ] Compose domain dictionaries with compile-time EN/RU parity.
- [ ] Run `npx vitest --run src/i18n/catalog.test.ts src/i18n/translate.test.ts`.

### Task 2: Build the Hermes shell using Linear tokens

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `src/components/Titlebar.tsx`
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/components/ResizeHandle.tsx`
- Modify: `src/components/FileExplorer.tsx`
- Modify: `src/components/Sidebar.tsx`
- Create: `src/components/shell/DeveloperRail.tsx`
- Create: `src/components/shell/ActivityRail.tsx`
- Create: `src/components/shell/TerminalActivity.tsx`
- Create: `src/components/shell/activity-registry.ts`
- Create: `src/i18n/locales/en/shell.ts`
- Create: `src/i18n/locales/ru/shell.ts`
- Test: `src/components/shell/shell-layout.test.tsx`

- [ ] Write failing tests for physical pane order, activity registry entries, translated labels and persistent pane preferences.
- [ ] Replace root dark tokens with Refero values and semantic aliases; keep alternate themes functional.
- [ ] Render files above a truthful terminal/tool-activity surface on the left, chat in the center and sessions/activity on the right.
- [ ] Add persistent collapse, resize and side-swap behavior with safe minimum center width.
- [ ] Add narrow-window overlay rails and platform-aware titlebar insets.
- [ ] Populate activity registry with Sessions, Capabilities, Messaging, Artifacts, Memory and Providers; render localized honest empty states where backend adapters are not present.
- [ ] Preserve session CRUD/pin/search/export/rename/delete and file preview behavior.
- [ ] Run shell tests and renderer typecheck.

### Task 3: Port composer and chat interaction chrome

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/components/composer/ModelPill.tsx`
- Modify: `src/components/Message.tsx`
- Modify: `src/components/CodeBlock.tsx`
- Modify: `src/components/chat/ThinkingDisclosure.tsx`
- Modify: `src/components/ToolRow.tsx`
- Modify: `src/lib/tool-view.ts`
- Modify: `src/lib/model-status-label.ts`
- Modify: `src/lib/slash-commands.ts`
- Delete: `src/lib/commands.ts`
- Modify: `src/store/snippets.ts`
- Create: `src/i18n/locales/en/chat.ts`
- Create: `src/i18n/locales/ru/chat.ts`
- Test: existing composer, slash-command, tool-view and model-label tests

- [ ] Add or update failing tests for translated controls, registry-generated slash commands, localized built-in snippets and unknown tool fallback.
- [ ] Keep Hermes control order: add-context, model/options, mic/steer, speech, primary send/queue/stop.
- [ ] Make the composer responsive without removing queue, attachments, history, voice or model controls.
- [ ] Consolidate slash command registries into one locale-neutral ID registry.
- [ ] Add first-class web search/fetch and memory/GBrain tool metadata without exposing an embedded browser.
- [ ] Run focused tests and renderer typecheck.

### Task 4: Rework settings and provider surfaces

**Files:**
- Modify: `src/components/Settings.tsx`
- Modify: `src/components/settings/ProviderManager.tsx`
- Modify: `src/components/settings/KeybindPanel.tsx`
- Modify: `src/components/settings/ThemeGrid.tsx`
- Modify: `src/components/ThemeSwitcher.tsx`
- Create: `src/components/settings/settings-registry.ts`
- Create: `src/i18n/locales/en/settings.ts`
- Create: `src/i18n/locales/ru/settings.ts`
- Test: `src/components/settings/settings-copy.test.tsx`
- Test: `src/components/settings/provider-validation.test.ts`

- [ ] Write failing RU/EN rendering and provider-validation tests.
- [ ] Convert Settings to a near-full-screen overlay with a 13rem rail and compact dropdown navigation below 760px.
- [ ] Drive sections and field options from stable IDs plus translation keys.
- [ ] Preserve unlimited custom providers, credentials, model discovery, role models, workspace, safety, web, context/memory, appearance, notifications, voice, keybinds, GBrain and advanced JSON.
- [ ] Remove mixed-language validation/status copy; retain raw model/provider names as data.
- [ ] Run focused tests and renderer typecheck.

### Task 5: Remove localized protocol state and remaining hardcode

**Files:**
- Modify: `core/gateway.js`
- Modify: `core/provider-config.js`
- Modify: `src/lib/gateway.ts`
- Modify: `src/lib/session-search.ts`
- Modify: `src/lib/theme.ts`
- Modify: `src/lib/tool-result-summary.ts`
- Modify: `src/components/CommandPalette.tsx`
- Modify: `src/components/ui/dialog.tsx`
- Modify: `src/components/ui/search-field.tsx`
- Modify: `electron/main.js`
- Create: `scripts/check-i18n.mjs`
- Modify: `package.json`
- Test: `tests/gateway-i18n-contract.test.ts`

- [ ] Write failing tests proving new sessions store no localized title and error responses have stable codes/details.
- [ ] Resolve untitled session copy in the renderer and migrate legacy localized untitled values on read.
- [ ] Pass translators into pure registries/formatters rather than importing React context.
- [ ] Add an i18n static check for JSX text and user-facing props with a narrow technical-data allowlist.
- [ ] Add `check:i18n` to `npm run gate` and make the repository pass it.

### Task 6: Visual and functional verification loop

**Files:**
- Create: `.omx/state/kyrei-desktop-redesign/ralph-progress.json`
- Update: `.jez/artifacts/design-review.md`
- Create: `output/playwright/kyrei-ru-1440.png`
- Create: `output/playwright/kyrei-en-1440.png`
- Create: `output/playwright/kyrei-narrow-900.png`

- [ ] Run `npm run gate` and fix every failure.
- [ ] Start the packaged Electron development application and capture RU/EN/narrow screenshots.
- [ ] Exercise session CRUD, settings navigation, provider profile editing, model picker, attachments, file preview, command palette and pane persistence.
- [ ] Run `visual-verdict` against the live Hermes composition and Refero style; persist JSON after each iteration.
- [ ] Continue editing until score is at least 90 and there are no category mismatches.
- [ ] Re-run `npm run gate` after the final visual edit.

### Task 7: Independent review and handoff

**Files:**
- Review all changed renderer, gateway, Electron, tests and design files.

- [ ] Run an independent code review focused on behavior loss, cross-platform titlebar behavior, secret handling and untranslated copy.
- [ ] Fix all high/medium findings and re-run affected tests plus `npm run gate`.
- [ ] Remove transient Playwright session state, keep only useful visual evidence, and verify `git diff --check`.
- [ ] Commit with Lore trailers describing constraints, rejected alternatives, verification and residual risk.
