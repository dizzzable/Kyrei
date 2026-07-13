# Test specification: provider account model routing and authentication

Date: 2026-07-13

## Account policy tests

- Missing `modelIds` serves every provider model.
- Explicit `modelIds: []` serves no model.
- Duplicate/oversized/invalid IDs are rejected or normalized at the correct
  boundary.
- Unknown provider model IDs are rejected on account create/update.
- Removed provider models are intersected without widening policy.
- Affinity to an ineligible account is ignored after a model switch.
- Preferred account is ignored when ineligible.
- No eligible account fails before any engine/provider invocation.
- Only the selected account's credential reaches the engine.
- Public config and status never contain credentials.

## Kiro connector tests

- Executable detection and version parsing are bounded.
- `whoami` returns only authenticated/category/method fields; email and identity
  are absent.
- Model discovery validates/deduplicates/bounds model IDs and names.
- Browser/device methods map only to documented CLI flags.
- Identity Center accepts only an HTTPS AWS access-portal URL and a valid AWS
  region.
- Spawn never uses a shell.
- Only one login flow exists at a time; flow IDs are unguessable.
- Output is length-bounded, ANSI-free, and redacts emails/tokens.
- Completion, non-zero exit, timeout, cancellation, and logout are deterministic.
- No function reads Kiro token/cookie/config files.

## Gateway/UI tests

- Account policy CRUD survives reload and preserves absent vs empty.
- Auth start/status/cancel/disconnect routes require the launch capability.
- Stale auth completion after account/provider mutation is rejected.
- Login responses contain no token-like fields or raw identities.
- EN/RU catalog parity passes.
- Account dialog remains usable at 1280x720 and 1440x920.

## Verification commands

- `npm run typecheck:engine`
- `npm run typecheck:renderer`
- `npm run check:js`
- `npm run check:i18n`
- focused Vitest suites for provider pool/config/gateway/connector/UI
- `npm run gate`
- `npm audit --omit=dev`
- visual verdict for the account-pool dialog
- Windows package build; macOS/Linux packaging remains CI-native
