# Hermes settings parity audit → Kyrei plan

## Scope and evidence

This document is an **audit-only plan** for Hermes settings parity. It is based on the installed local Hermes copy and the current Kyrei worktree; no product code was changed.

### Hermes evidence used
- Installed config structure: `/mnt/f/pi cli/Kyrei/hermes/config.yaml`.
  - Observed top-level groups (keys only, no secret values): `model`, `fallback_providers`, `agent`, `terminal`, `browser`, `file_read_max_chars`, `tool_output`, `tool_loop_guardrails`, `compression`, `prompt_caching`, `auxiliary`, `display`, `stt`, `memory`, `delegation`, `moa`, `skills`, `command_allowlist`, `code_execution`, `streaming`, `updates`, `session_reset`, `platform_toolsets`, `custom_providers`.
- Hermes desktop settings shell: `/mnt/f/pi cli/Kyrei/hermes/hermes-agent/apps/desktop/src/app/settings/index.tsx`
- Hermes curated config sections: `/mnt/f/pi cli/Kyrei/hermes/hermes-agent/apps/desktop/src/app/settings/constants.ts`
- Hermes settings pages:
  - `model-settings.tsx`
  - `config-settings.tsx`
  - `appearance-settings.tsx`
  - `notifications-settings.tsx`
  - `providers-settings.tsx`
  - `gateway-settings.tsx`
  - `keys-settings.tsx`
  - `sessions-settings.tsx`
  - `about-settings.tsx`
  - `computer-use-panel.tsx`
  - `pet-settings.tsx`
- Hermes settings tests present in source:
  - `helpers.test.ts`
  - `model-settings.test.tsx`
  - `provider-config-panel.test.tsx`
  - `providers-settings.test.tsx`
  - `toolset-config-panel.test.tsx`
  - `voice-field-visible.test.ts`
  - `with-active.test.ts`

### Kyrei evidence used
- Current settings UI: `src/components/Settings.tsx`
- Settings primitives: `src/components/settings/ConfigField.tsx`, `src/components/settings/ThemeGrid.tsx`, `src/components/settings/KeybindPanel.tsx`
- UI settings store: `src/store/settings.ts`
- Session UI/features: `src/components/Sidebar.tsx`, `src/lib/session-search.ts`, `src/lib/session-export.ts`, `src/store/sessions-ui.ts`
- Model/composer parity pieces already present: `src/components/composer/ModelPill.tsx`, `src/lib/model-status-label.ts`, `src/lib/slash-commands.ts`, `src/store/composer-queue.ts`, `src/store/composer-input-history.ts`
- Gateway/config backing: `src/lib/gateway.ts`, `core/gateway.js`, `core/engine/config/schema.ts`, `core/engine/config/config.test.ts`

## Hermes settings information architecture observed

| Hermes area | Source path(s) | Backing config / state |
|---|---|---|
| Model | `app/settings/model-settings.tsx` | `model.*`, `fallback_providers`, `auxiliary.*`, `moa.*`, parts of `agent.*` |
| Chat | `app/settings/config-settings.tsx` + `constants.ts` (`chat`) | `display.personality`, `timezone`, `display.show_reasoning`, `agent.image_input_mode` |
| Appearance | `app/settings/appearance-settings.tsx` | desktop-only stores for theme/mode/zoom/translucency/pet/tool view |
| Workspace | `app/settings/config-settings.tsx` + `constants.ts` (`workspace`) | `terminal.cwd`, `code_execution.mode`, `terminal.persistent_shell`, `terminal.env_passthrough`, `file_read_max_chars` |
| Safety | `app/settings/config-settings.tsx` + `constants.ts` (`safety`) | `approvals.*`, `command_allowlist`, `security.*`, `browser.*`, `checkpoints.*` |
| Memory & Context | `app/settings/config-settings.tsx` + `constants.ts` (`memory`) | `memory.*`, `context.*`, `compression.*` |
| Voice | `app/settings/config-settings.tsx` + `constants.ts` (`voice`) | `tts.*`, `stt.*`, `voice.*` |
| Advanced | `app/settings/config-settings.tsx` + `constants.ts` (`advanced`) | `toolsets`, `terminal.backend`, `tool_output.*`, `agent.*`, `delegation.*`, `updates.*` |
| Notifications | `app/settings/notifications-settings.tsx` | desktop notification stores |
| Providers / API keys | `app/settings/providers-settings.tsx`, `provider-config-panel.tsx`, `credential-key-ui.tsx`, `env-credentials.tsx` | `custom_providers`, provider env vars, OAuth/account state |
| Gateway | `app/settings/gateway-settings.tsx` | local/cloud/remote gateway mode |
| Keys | `app/settings/keys-settings.tsx` | tool/server env vars |
| Sessions | `app/settings/sessions-settings.tsx` | archived sessions, default dirs |
| About / uninstall | `app/settings/about-settings.tsx`, `uninstall-section.tsx` | version/update/danger-zone |
| Extra desktop-only panels | `computer-use-panel.tsx`, `pet-settings.tsx` | Computer Use driver health; pet gallery |

## Current Kyrei coverage snapshot

| Kyrei area today | Current path(s) | Status vs Hermes |
|---|---|---|
| General (provider registry, protocol-specific credentials, model, role models, workspace) | `src/components/Settings.tsx`, `src/components/settings/ProviderManager.tsx`, `src/lib/gateway.ts`, `core/gateway.js` | **Strong partial** |
| Chat (personality, send-on-enter, rich rendering) | `src/components/Settings.tsx`, `core/engine/config/schema.ts` | **Partial** |
| Appearance (themes, VS Code theme import, language, scale, density, tool view) | `src/components/Settings.tsx`, `src/components/settings/ThemeGrid.tsx`, `src/lib/theme.ts`, `src/lib/vscode-theme.ts`, `src/store/settings.ts` | **Strong partial** |
| Notifications | `src/components/Settings.tsx`, `src/store/settings.ts`, `src/App.tsx` | **Partial** |
| Voice (Web Speech only) | `src/components/Settings.tsx`, `src/lib/speech.ts`, `src/lib/speech-text.ts`, `src/store/settings.ts` | **Intentional partial** |
| Keybinds | `src/components/settings/KeybindPanel.tsx`, `src/lib/keybinds/actions.ts`, `src/store/keybinds.ts` | **Strong partial** |
| Advanced engine config | `src/components/Settings.tsx`, `core/engine/config/schema.ts`, `core/engine/types.ts` | **Strong partial** |
| Sessions search/export/pin/rename | `src/components/Sidebar.tsx`, `src/lib/session-search.ts`, `src/lib/session-export.ts`, `src/store/sessions-ui.ts` | **Partial outside Settings** |
| Model pill / effort / fast / known models | `src/components/composer/ModelPill.tsx`, `src/lib/model-status-label.ts`, `src/store/model-presets.ts` | **Partial** |

## Capability-by-capability mapping and staged plan

Legend: **Keep** = already aligned enough; **Port** = safe parity target; **Reject** = should stay out because it conflicts with Kyrei constraints.

| Stage | Capability | Hermes evidence | Kyrei now | Decision / exact Kyrei files | Tests / verification |
|---|---|---|---|---|---|
| P0 | Single local provider + API key + model | `model-settings.tsx`, `providers-settings.tsx`, `config.yaml: model.*` | Base URL, API key, model already editable | **Keep/reshape only.** Continue using `src/components/Settings.tsx`, `src/components/composer/ModelPill.tsx`, `src/lib/gateway.ts`, `core/gateway.js`. Do **not** import Hermes OAuth/account catalog. | Run `src/lib/model-status-label.test.ts`; add `src/store/settings.test.ts` for import/export persistence; smoke: save provider/model/key and restart app. |
| P0 | Engine-backed role models (`default/small/plan`) | Hermes model picker + config-driven assignments in `model-settings.tsx` | Already surfaced in General | **Keep.** Source stays in `src/components/Settings.tsx`; backend contract remains `core/engine/config/schema.ts`. | Extend `core/engine/config/config.test.ts` with role round-trips and invalid-role fallback. |
| P0 | Advanced engine tuning already backed by Kyrei | Hermes `config-settings.tsx`, `constants.ts` (`advanced`); installed `agent.*`, `tool_output.*`, `file_read_max_chars` | `maxSteps`, `apiMaxRetries`, `commandTimeoutMs`, `maxToolOutput`, `fileReadMaxChars`, `permissions.*`, `contextBudget.*`, `sandbox`, `fallbackChain` exist | **Keep and split visually later.** Files: `src/components/Settings.tsx`, `core/engine/config/schema.ts`, `core/engine/types.ts`, `core/gateway.js`. | Existing `core/engine/config/config.test.ts`; add cases for `maxToolOutput`, `fileReadMaxChars`, permissions + UI JSON import/export smoke. |
| P1 | Monolithic Settings overlay → Hermes-style sectioned overlay | Hermes `index.tsx`, `config-settings.tsx`, `constants.ts` | Kyrei still has one monolithic `Settings.tsx` | **Port structure, not backend breadth.** Refactor into `src/components/settings/sections/*` while keeping the current categories. Avoid product-surface expansion until each section has backend parity. | Add `src/store/settings.test.ts`; manual smoke for open/close, section switching, import/export, autosave debounce. |
| P1 | Chat controls: personality + reasoning visibility + image input mode | Hermes `constants.ts` (`chat`), `config.yaml: agent.image_input_mode`, `display.show_reasoning` | Personality exists; reasoning visibility/image input mode do not | **Port selectively.** Add only settings that Kyrei can honor locally: likely `showReasoning` UI pref in `src/store/settings.ts` and optional engine `imageInputMode` only if wired in engine later. Files: `src/components/Settings.tsx`, `src/store/settings.ts`, possibly `core/engine/config/schema.ts`. | Add `src/store/settings.test.ts`; extend `core/engine/config/config.test.ts` if new engine keys are introduced. |
| P1 | Sessions inside Settings (archive/default dir/export entry points) | `sessions-settings.tsx` | Session features exist in sidebar, not in Settings | **Port lightly.** Reuse existing logic from `src/components/Sidebar.tsx`, `src/lib/session-search.ts`, `src/lib/session-export.ts`, `src/store/sessions-ui.ts`; add a Settings section only for session actions/default export preferences if needed. | Existing `src/lib/session-search.test.ts`, `src/lib/session-export.test.ts`; smoke: export session, pin/rename/delete still work. |
| P1 | Notification granularity | `notifications-settings.tsx` | Only master/sound/native toggles | **Port partially.** Keep local-only approach in `src/store/settings.ts`; add per-event toggles only if Kyrei emits distinct events worth honoring. No cloud/mobile delivery settings. | Add `src/store/settings.test.ts`; smoke: completion chime + native notification when window hidden. |
| P1 | Theme/mode parity | `appearance-settings.tsx` | Themes, VS Code import, scale, density, tool view, language already exist | **Keep; add missing small deltas only.** Candidate files: `src/lib/theme.ts`, `src/lib/vscode-theme.ts`, `src/store/settings.ts`, `src/components/settings/ThemeGrid.tsx`. | Add `src/lib/theme.test.ts` and `src/lib/vscode-theme.test.ts`; smoke: switch themes, import VS Code theme, restart persistence. |
| P2 | Keybind parity polish | Hermes keybind registry stored outside settings page but surfaced in settings | Kyrei already has rebind panel | **Keep + polish.** Files: `src/components/settings/KeybindPanel.tsx`, `src/lib/keybinds/actions.ts`, `src/store/keybinds.ts`. Focus on category copy/conflict UX, not more surfaces. | Existing `src/lib/keybinds/combo.test.ts`, `src/store/keybinds.test.ts`; smoke: rebind, conflict, reset all. |
| P2 | Voice settings | Hermes `constants.ts` (`voice`), `voice-field-visible.test.ts`, installed `stt.*` | Kyrei intentionally uses Web Speech only | **Port only Web Speech prefs.** Keep `src/components/Settings.tsx`, `src/store/settings.ts`, `src/lib/speech.ts`, `src/lib/speech-text.ts`. Do **not** port server-side STT/TTS provider matrix. | Existing `src/lib/speech-text.test.ts`; add `src/store/settings.test.ts`; smoke: dictation toggle, TTS test button, BCP-47 language. |
| P2 | Workspace controls | Hermes `constants.ts` (`workspace`), installed `terminal.*`, `code_execution.*` | Kyrei has workspace path and engine file-read cap, but no separate `persistent_shell` or `env_passthrough` settings UI | **Port only if backend exists.** Safe files: `src/components/Settings.tsx`, `core/gateway.js`, `core/engine/config/schema.ts`. Reject remote/unsafe workspace breadth until engine supports it. | Existing `core/engine/config/config.test.ts`; smoke: choose folder, verify jail still confines file tools. |
| P3 | Auxiliary models + MoA + delegation/subagents | Hermes `model-settings.tsx`, installed `auxiliary.*`, `moa.*`, `delegation.*` | Kyrei has no equivalent backend orchestration surface | **Reject for this parity phase.** No edits beyond documenting gap. | N/A; blocker is backend capability, not UI. |
| P1 | Providers/custom catalog | Hermes `providers-settings.tsx`, `provider-config-panel.tsx`, installed `custom_providers` | Kyrei now has unlimited profiles and six audited transports | **Ported selectively.** OpenAI-compatible, Responses, Anthropic, Gemini, Bedrock and Vertex are native; proprietary Hermes/Nous runtime and account marketplace remain excluded. | `tests/provider-config.test.ts`, `tests/gateway-provider.test.ts`, `core/engine/provider/provider.test.ts`. |
| P3 | Gateway Local/Cloud/Remote modes | Hermes `gateway-settings.tsx` | Kyrei is local desktop + local gateway only | **Reject.** Conflicts with the repo’s closed desktop/no-browser/local-first constraint. | N/A |
| P1 | Agent web research | Hermes `constants.ts` (`safety`), installed `browser.*` | Kyrei has isolated text-only `web_search`/`web_fetch` | **Ported selectively.** No user-facing browser, cookies, JavaScript, private networks, or desktop tabs; only the agent receives public-web tools controlled by `permissions.web`. | `core/engine/web/browser.test.ts`, `core/engine/tools/web.test.ts`. |
| P3 | Remote terminal backends (`docker`, `ssh`, `modal`, `daytona`, etc.) | Hermes `constants.ts` (`advanced`), installed `terminal.backend`, images | Kyrei currently exposes only local workspace and engine permissioning | **Reject for this phase.** Keep local-only desktop execution model. | N/A |
| P1 | External knowledge layer | Hermes `constants.ts` (`memory`) plus GBrain research | Kyrei keeps local project memory and now has optional GBrain tools | **Ported selectively.** GBrain is opt-in, separate, untrusted, and never replaces the built-in SQLite/project memory. | `core/engine/memory/gbrain.test.ts`, `core/engine/tools/gbrain.test.ts`. |
| P3 | Computer Use, pets, updates/uninstall, marketplace-like extras | `computer-use-panel.tsx`, `pet-settings.tsx`, `about-settings.tsx`, `uninstall-section.tsx` | Kyrei has no matching capability and does not need it for parity | **Reject.** Nice-to-have Hermes extras, not core Kyrei parity. | N/A |

## Exact implementation slices that can be worked independently later

### Slice A — Settings IA refactor only
- Files:
  - `src/components/Settings.tsx`
  - new `src/components/settings/sections/*.tsx`
  - `src/components/settings/ConfigField.tsx`
- Goal:
  - Split the monolith into Hermes-like sections without changing backend semantics.
- Tests:
  - add `src/store/settings.test.ts`
  - manual smoke: section switching, import/export, persistence after reopen

### Slice B — Theme and appearance hardening
- Files:
  - `src/lib/theme.ts`
  - `src/lib/vscode-theme.ts`
  - `src/store/settings.ts`
  - `src/components/settings/ThemeGrid.tsx`
- Goal:
  - Finish parity on persistence/boot behavior/small UX deltas, not new remote theme sources.
- Tests:
  - add `src/lib/theme.test.ts`
  - add `src/lib/vscode-theme.test.ts`

### Slice C — Notifications + voice local settings cleanup
- Files:
  - `src/store/settings.ts`
  - `src/components/Settings.tsx`
  - `src/lib/speech.ts`
  - `src/lib/speech-text.ts`
- Goal:
  - Improve local-only desktop behavior while keeping Web Speech and native notifications.
- Tests:
  - existing `src/lib/speech-text.test.ts`
  - add `src/store/settings.test.ts`

### Slice D — Sessions/settings bridge
- Files:
  - `src/components/Sidebar.tsx`
  - `src/lib/session-search.ts`
  - `src/lib/session-export.ts`
  - `src/store/sessions-ui.ts`
  - optional new section under `src/components/settings/`
- Goal:
  - Reuse existing session export/search/pin behavior from the sidebar rather than re-implementing Hermes’ archive stack.
- Tests:
  - existing `src/lib/session-search.test.ts`
  - existing `src/lib/session-export.test.ts`

### Slice E — Engine-backed settings expansion only where Kyrei already has backend support
- Files:
  - `src/components/Settings.tsx`
  - `core/gateway.js`
  - `core/engine/config/schema.ts`
  - `core/engine/config/config.test.ts`
- Goal:
  - Add or reorganize only keys that the engine already understands.
- Tests:
  - extend `core/engine/config/config.test.ts`

## Recommended order

1. **Slice A** — refactor Settings information architecture first; lowest risk, no backend expansion.
2. **Slice E** — cleanly expose only existing engine-backed keys.
3. **Slice B** — finish appearance polish/persistence.
4. **Slice C** — local notifications + voice cleanup.
5. **Slice D** — optional settings/session bridge.
6. Leave all **P3 reject** items out of scope unless Kyrei’s product direction changes.

## Hard constraints / blockers

- **Closed desktop / no user browser**: remote gateway modes and cloud-first account flows stay out; public web access exists only inside the isolated agent tool layer.
- **Backend mismatch**: Hermes `auxiliary`, `moa`, `delegation`, external memory providers, and remote terminal backends have no Kyrei engine backing today.
- **Test harness gap**: Kyrei currently has strong pure-unit coverage but no dedicated renderer component test suite for `src/components/Settings.tsx`; if settings refactors grow, add small pure tests first (`src/store/settings.test.ts`, `src/lib/theme.test.ts`, `src/lib/vscode-theme.test.ts`) before considering a heavier UI harness.

## Bottom line

Kyrei already covers the **high-value local desktop subset** of Hermes settings: provider/model basics, workspace, themes, keybinds, voice prefs, notifications, and advanced engine tuning. The right parity path is **selective consolidation**, not wholesale cloning. The next safe move is to reorganize the current Kyrei settings surface into Hermes-like sections while explicitly rejecting Hermes features that depend on browser automation, cloud gateway modes, OAuth/provider marketplaces, remote terminals, or subagent orchestration.
