# Provider account pools implementation plan

## Goal

Add a secure, native Kyrei account pool for multiple credentials of one provider while
preserving session continuity and the engine's current pre-commit failover boundary.

## Work items

1. Add versioned pool metadata and extra-account secret normalization.
2. Add a deterministic pool scheduler with affinity, capacity, health, cooldown, and
   explicit balanced/round-robin/fill-first strategies.
3. Add redacted loopback APIs for pool settings and write-only account credentials.
4. Expand runtime targets with account identity and order same-provider candidates
   before existing cross-provider fallbacks.
5. Persist an optional account binding on a Kyrei session after a successful turn.
6. Add a provider-row icon and bilingual account-pool dialog.
7. Cover migration, redaction, routing, API validation, runtime failover, and UI copy.
8. Run visual-verdict, type checks, JS/i18n checks, focused tests, then the full gate.

## Constraints

- No new dependency.
- No OAuth emulation or credential scraping.
- No secret may be returned to the renderer, logged, exported, or stored outside the
  existing encrypted secret persistence boundary.
- No retry after client-visible output or tool side effect.
- Existing single-credential provider configurations remain valid.

## Completion evidence

- Main chat, delegated workers, Team roles, nested helpers, and Pipeline departments use
  just-in-time, fail-closed account admission with exactly-once lease release.
- Provider mutations abort in-flight work and generation-fence late results.
- `npm run gate`: 96 test files / 825 tests passed, including engine and renderer
  typechecks plus JS and EN/RU hardcode checks.
- Visual verdict: 94/100 at 1440×900 with no clipping or overlap.
- `npm run dist:win`: NSIS installer and portable x64 artifacts produced successfully.

## Deliberate follow-ups

- Persisted quota/health windows and provider-specific usage telemetry.
- Safe auxiliary-account candidate fallback after a durable tool-idempotency boundary;
  workers and Team/Pipeline roles currently enforce admission on one resolved account.
- Reviewed OAuth/device-flow adapters for subscription accounts; the current release
  pools only credential types Kyrei already supports.
- Native macOS/Linux artifact builds in their respective CI runners and release signing.
