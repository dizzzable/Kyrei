# Provider account pools test specification

## Configuration and migration

- Legacy provider config gains a disabled/default pool without data loss.
- Legacy secret payload remains the primary credential.
- Extra account credentials normalize into a separate secret map.
- Public config never contains API keys, tokens, or provider-specific secrets.

## Scheduler

- Filters disabled, auth-required, cooldown, and saturated accounts.
- Reuses a healthy session lease when enabled.
- Balanced, round-robin, and fill-first produce deterministic candidate orders.
- Acquire/release changes in-flight counts without underflow.
- Retryable failures create bounded cooldown; auth failures require reauthentication;
  success clears transient failure state.
- No available capacity returns a structured empty result rather than fail-open.

## Gateway/API

- Capability-token/origin protections cover all new mutation routes.
- IDs, names, weights, priorities, limits, and body sizes are bounded.
- Credential endpoints are write-only and redacted on every response.
- Primary account cannot be deleted; extra members can be removed atomically with
  their secret and stale session binding.
- Same-provider account candidates precede cross-provider fallback.

## Runtime continuity

- Runtime target identity includes account ID.
- Two accounts with the same provider/model are not deduplicated.
- Early retry can switch accounts; post-commit retry remains forbidden.
- Successful completion binds the session to the winning account.

## UI/localisation

- Dedicated pool icon is keyboard accessible and does not trigger provider editing.
- Dialog supports enable/strategy/affinity/member management.
- Credentials are never prefilled.
- English/Russian locale trees contain the same keys and no user-facing hardcode.

## Release gate

- `npm run typecheck:engine`
- `npm run typecheck:renderer`
- `npm run check:js`
- `npm run check:i18n`
- focused provider pool tests
- `npm test`
- `npm run build`
- visual-verdict evidence saved under `.omx/state/provider-account-pools/`

