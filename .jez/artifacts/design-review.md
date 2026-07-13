# Kyrei desktop design review — pre-implementation

Date: 2026-07-13

## References

- Live Hermes shell: `output/visual-references/hermes-shell-live.png`
- Live Hermes settings: `output/visual-references/hermes-settings-live.png`
- Live Hermes capabilities: `output/visual-references/hermes-capabilities-live.png`
- Linear style reference: `output/playwright/refero-linear-full.png`
- User-annotated Hermes screenshot: `C:/Users/dizzable/AppData/Local/Temp/codex-clipboard-d9ece539-bbfd-45d2-bfed-e9acb48879cd.png`

## Current-state findings

### Layout and hierarchy

- Kyrei currently places sessions on the left and files on the right; this is the reverse of the requested Hermes arrangement.
- The shell has no terminal/activity region and no declarative activity navigation for Capabilities, Messaging, Artifacts, Memory, Providers, Agents or Cron.
- Fixed rails do not protect the minimum readable width of the conversation at narrow desktop sizes.
- The titlebar reserves a Windows-specific control inset on every platform.

### Visual system

- Existing dark tokens are warm black and amber. They conflict with the selected Linear reference: cool near-black surfaces, neutral text and acid-lime primary action.
- The current empty state is visually louder than an active conversation; Hermes keeps chrome quiet and the conversation/composer primary.
- Component radii and surface treatments vary. The target vocabulary is deliberately small: 4px badges, 6px controls, 12px cards, hairline borders and almost no shadow.

### Settings and feature discoverability

- Settings is a dense two-pane modal but its information architecture does not mirror the requested Hermes overlay and is not responsive below 760px.
- Provider, memory, web and runtime controls exist, but their entry points are scattered and do not appear in a coherent activity registry.
- Capabilities, Messaging and Artifacts have no first-class pages; unavailable adapters need honest empty states rather than fake functionality.

### Localization and accessibility

- The catalog has only 18 EN/RU entries and no rendered component consumes translated copy.
- User-facing strings, placeholders, titles and aria labels are hardcoded across shell, composer, settings and registries.
- Localized session titles leak into gateway semantics; switching language cannot be consistent until untitled becomes a protocol state.

## Direction

1. Recompose shell as `developer rail | conversation | activity rail` with persistent resize/collapse and narrow-window overlays.
2. Apply Linear tokens at the root; components consume semantic `--ui-*` variables only.
3. Preserve existing Kyrei behavior through props and registries; do not make visual placeholder controls that claim unavailable runtime support.
4. Make settings nearly full-screen with responsive rail/dropdown navigation and retain every current provider, web, memory, voice, safety and advanced setting.
5. Migrate all built-in copy to a typed EN/RU catalog and add a gate that rejects new user-facing literals.
6. Verify both locales at 1440×900 and 900×700, then compare against Hermes geometry and Refero style with `visual-verdict`.

## Acceptance bar

- Visual-verdict score at least 90/100 for category and composition.
- No visible embedded browser or webview.
- No lost Kyrei settings or provider operations.
- EN and RU screenshots contain no mixed-language built-in UI.
- `npm run gate` and the i18n hardcode check pass.

## Post-implementation verification

- Visual verdict: **92/100, pass**, category match true. The independent Hermes review scored the previous iteration 89/100; its remaining navigation and taxonomy findings were fixed before this verdict.
- Desktop composition: developer files/activity left, conversation/composer center, activity/sessions right.
- Settings: near-full-screen split overlay with 13rem navigation, distinct Models & providers, Workspace & safety, Chat & tools and Memory destinations, plus compact select navigation below 760px.
- Activity routing: Capabilities opens existing workspace/permission/web controls, Memory opens the real GBrain surface and Providers opens the unlimited provider manager; unavailable Messaging/Artifacts remain honestly disabled.
- Narrow layout: both rails are initially collapsed at 900px and open independently as side overlays; at 720x600 the composer remains fixed while the empty state scrolls independently.
- Localization: RU and EN live screenshots verified; typed catalog parity and hardcode check pass.
- Functional preservation: provider profiles/credentials/models, role models, workspace/safety/web, context, themes, notifications, voice, keybinds, GBrain, import/export/reset and advanced JSON remain present.
- Verification: `npm run gate` passes **52 test files / 389 tests**, both TypeScript projects, engine build, JS check and i18n check. `npm run build` also passes.

Known truthful gaps are runtime-bound rather than visual placeholders: the lower developer pane is a tool-activity trace until a cross-platform PTY service exists; project/worktree grouping and cron/subagent counters wait for durable gateway metadata. The renderer does not expose an embedded browser.
