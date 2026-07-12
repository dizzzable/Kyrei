# Kyrei settings IA plan (Hermes parity discovery)

## Goal
Reframe Kyrei settings around **tasks users can actually complete today**, while borrowing Hermes' stronger settings shell patterns without exposing unsupported functionality.

## Constraints
- Preserve Kyrei's **closed desktop / no-browser** model (`electron/main.js` denies new windows/navigation).
- Discovery phase only: **no product-code edits yet**.
- Only surface capabilities that already exist in Kyrei's renderer + gateway today.

## Evidence audited
### Kyrei today
- `src/components/Settings.tsx` — one large modal with sections: `general`, `chat`, `appearance`, `notifications`, `voice`, `keybinds`, `advanced`, `about`.
- `src/store/settings.ts` — local-only UI prefs: scale, tool view, density, notifications, send-on-enter, rich rendering, voice flags/lang.
- `src/lib/gateway.ts` + `core/gateway.js` — persisted runtime config supports only: `provider`, `apiKey`, `model`, `workspace`, `engine`.
- `src/components/settings/ConfigField.tsx` — simple row primitives, currently viewport-based, not schema/container driven.
- `src/components/settings/ThemeGrid.tsx`, `KeybindPanel.tsx`, `src/lib/speech.ts` — concrete supported appearance/shortcut/voice capabilities.
- `electron/main.js` — desktop-only shell, no external browsing.

### Hermes patterns worth copying
- `hermes/hermes-agent/apps/desktop/src/app/settings/index.tsx` — split overlay shell, deep-linkable sections, footer actions.
- `.../primitives.tsx` — container-query rows that stack by pane width, not by viewport.
- `.../config-settings.tsx` — schema-driven field rendering and conditional visibility (`voiceFieldVisible`).
- `.../appearance-settings.tsx` / `notifications-settings.tsx` — dedicated panels instead of a monolith.

## Current Kyrei capability inventory
### Supported now
1. **AI connection**
   - Provider base URL
   - API key save/update
   - Main model
   - Engine role model aliases (`providerRoles.default/small/plan`)
2. **Workspace**
   - Workspace folder picker
   - Workspace jail messaging already implied in UI and gateway
3. **Chat behavior**
   - Assistant personality
   - Send-on-Enter
   - Rich markdown rendering
4. **Appearance**
   - Built-in themes
   - VS Code theme import
   - Language
   - UI scale
   - Density
   - Default tool view
5. **Notifications**
   - Master switch
   - Completion sound
   - Native notification toggle
6. **Voice**
   - Web Speech dictation toggle
   - Auto-speak toggle
   - Speech language
   - Test speech
7. **Keyboard**
   - Rebindable shortcuts
8. **Advanced engine tuning**
   - Max steps, retries, command timeout, tool/file output limits
   - Terminal autonomy, review mode, context thresholds, sandbox, fallback chain
   - Raw JSON editor
9. **Backup/reset/about**
   - Config export/import
   - Reset UI settings
   - About/version/provider summary

### Not supported now and should stay hidden
- Provider accounts/OAuth, provider catalog management, multiple key vaults
- Profiles, sessions/archive management from settings
- Messaging integrations, cron, artifacts gallery
- Memory providers / reset memory UI
- Browser/privacy URL permissions
- Terminal backends like docker/ssh/modal/daytona
- MCP/settings pages as first-class settings destinations
- Self-update / release-management UI
- Per-provider TTS/STT backends beyond Web Speech

## IA problem with current Kyrei settings
The current modal is functional but organized by **implementation buckets**, not user jobs:
- `general` mixes connection setup, model strategy, and workspace.
- `advanced` mixes safety, performance, context, and backup/reset.
- import/export is hidden in the left-nav footer.
- voice and notifications are split even though both are "attention & feedback" controls.
- the component is a single ~600+ line branchy file, so future parity work will keep getting harder.

## Proposed task-oriented IA
### 1. AI Setup
**User job:** connect Kyrei to a model and choose defaults.

Include:
- Provider base URL
- API key
- Main model
- Role models (default / fast / plan)

Source today:
- `src/components/Settings.tsx`
- `src/lib/gateway.ts`
- `core/gateway.js`

### 2. Workspace & Safety
**User job:** point Kyrei at a project and define how boldly it may act.

Include:
- Workspace folder
- Terminal autonomy
- Review mode
- Sandbox mode
- Command timeout
- File read max chars
- Tool output limit

Why: these settings affect trust/scope more than "advanced tuning".

### 3. Chat & Tools
**User job:** shape how responses are written and displayed during a run.

Include:
- Assistant personality
- Send-on-Enter
- Rich rendering
- Default tool view
- Max steps
- Context soft/hard thresholds
- Fallback chain

### 4. Appearance & Accessibility
**User job:** make the app comfortable to read and navigate.

Include:
- Theme presets
- VS Code theme import/reset
- Language
- UI scale
- Density

### 5. Notifications & Voice
**User job:** decide how Kyrei gets attention and whether it speaks/listens.

Include:
- Notification master switch
- Completion sound + test
- Native notification toggle
- Voice input toggle
- Auto-speak toggle
- Speech language
- Speech test
- Existing Web Speech warning copy

### 6. Shortcuts
**User job:** tune keyboard workflow.

Include:
- Existing `KeybindPanel`
- Read-only shortcuts grouped under same categories

### 7. Backup & Advanced
**User job:** import/export/reset and edit expert-only engine JSON.

Include:
- Config export/import
- Reset UI settings
- API retries
- Raw engine JSON editor
- Any remaining expert-only numeric knobs not promoted above

### 8. About
**User job:** verify app/build identity.

Include:
- Existing version / engine / provider summary

## Mapping from current sections
| Current | Proposed |
|---|---|
| General | AI Setup + Workspace & Safety |
| Chat | Chat & Tools |
| Appearance | Appearance & Accessibility |
| Notifications + Voice | Notifications & Voice |
| Keybinds | Shortcuts |
| Advanced | Workspace & Safety + Chat & Tools + Backup & Advanced |
| About | About |

## Responsive behavior proposal
Use Hermes' settings primitive approach, but sized for Kyrei's current desktop window constraints (`minWidth: 980`).

### Width >= 1200
- Two-pane overlay
- Left nav fixed at ~240px
- Right pane scrolls independently
- Label/control rows stay 2-column

### Width 980-1199
- Keep two panes
- Shrink nav to ~208-220px
- All setting rows become **container-aware** and stack when the content pane gets tight
- Multi-control rows (role models, theme actions, notification test buttons) wrap instead of compressing

### Future-proof width < 980
If Kyrei later lowers window min-width:
- Settings becomes full-screen sheet
- Nav collapses to top segmented/tabs list
- Footer actions move into the content header of "Backup & Advanced"

## Exact component/file plan
### Stage 1 — shell + IA refactor (no behavior changes)
Files:
- `src/components/Settings.tsx`
- `src/components/settings/ConfigField.tsx`
- new `src/components/settings/SettingsNav.tsx`
- new `src/components/settings/SettingsSection.tsx`
- `src/App.tsx` (section IDs/deep-link openers)

Tests to add:
- `src/components/settings/SettingsNav.test.tsx`
- `src/components/Settings.test.tsx`

### Stage 2 — split monolith into task panels
Files:
- new `src/components/settings/panels/AiSetupPanel.tsx`
- new `src/components/settings/panels/WorkspaceSafetyPanel.tsx`
- new `src/components/settings/panels/ChatToolsPanel.tsx`
- new `src/components/settings/panels/AppearancePanel.tsx`
- new `src/components/settings/panels/NotificationsVoicePanel.tsx`
- new `src/components/settings/panels/ShortcutsPanel.tsx`
- new `src/components/settings/panels/BackupAdvancedPanel.tsx`
- new `src/components/settings/panels/AboutPanel.tsx`

Tests to add:
- `src/components/settings/panels/AiSetupPanel.test.tsx`
- `src/components/settings/panels/WorkspaceSafetyPanel.test.tsx`
- `src/components/settings/panels/NotificationsVoicePanel.test.tsx`

### Stage 3 — container-aware layout primitives
Files:
- `src/components/settings/ConfigField.tsx`
- optional new `src/components/settings/SettingsRow.tsx`

Tests to add:
- `src/components/settings/SettingsRow.test.tsx`

### Stage 4 — settings metadata cleanup
Files:
- `src/store/settings.ts`
- optional new `src/components/settings/sections.ts`
- optional new `src/lib/settings-metadata.ts`
- `src/lib/slash-commands.ts` and `src/components/CommandPalette.tsx` if section deep-links are exposed there

Tests to add:
- `src/store/settings.test.ts`
- `src/lib/slash-commands.test.ts`

## Independently implementable slices
1. **Shell-only IA rename/reorder** — safest first slice; mostly renderer-only.
2. **Panel extraction** — mechanical split of `Settings.tsx`; low product risk.
3. **Responsive row primitive** — isolated UI infrastructure slice.
4. **Backup & Advanced relocation** — improves discoverability without engine changes.
5. **Deep-link section IDs** — small follow-up once section names stabilize.

## Recommended order
1. Stage 1 shell refactor
2. Stage 2 panel extraction
3. Stage 3 responsive row primitive
4. Stage 4 metadata/deep-link cleanup

## Non-goals for this parity wave
Do **not** add Hermes-only surfaces yet:
- Providers/Accounts/Keys split
- Sessions page
- Gateway page
- Memory settings
- Messaging settings
- Browser/privacy toggles
- Multi-provider voice backends

Those require real backend/runtime capability first; exposing them early would violate the "supported functionality only" rule.

## Why this plan is the best parity move now
It copies Hermes where Hermes is structurally better:
- split settings shell
- container-aware rows
- smaller dedicated panels
- deep-linkable sections

But it avoids false parity by keeping Kyrei scoped to what its current gateway, Electron shell, and renderer already support.
