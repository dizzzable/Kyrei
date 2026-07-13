# Provider account model routing and authentication plan

Date: 2026-07-13

Implementation status: phases 1-3 are complete and verified. Phase 4 remains a
separate guarded milestone; Kiro is not advertised as an execution provider
until ACP permissions and session transport are implemented and tested.

## Scope

Deliver an auditable account-to-model routing layer for every provider pool and
the first safe browser/device authentication connector through the official
Kiro CLI. Keep the desktop renderer browser-free and keep credentials outside
renderer state.

## Phase 1: account model policy

1. Persist optional `modelIds` on every account, including `primary`.
2. Treat absent policy as all models and explicit empty policy as none.
3. Validate selected IDs against the provider model catalogue.
4. Intersect stale policies when provider models change, without broadening an
   explicit empty policy.
5. Filter by model before affinity, concurrency, and balancing.
6. Display all/selected/none state in the account-pool dialog with EN/RU copy.

## Phase 2: provider auth boundary

1. Add a process-isolated connector interface with status, login, cancel,
   disconnect, and model discovery operations.
2. Keep all provider-specific executable arguments in audited core code.
3. Use `spawn` without a shell, bounded output, ANSI removal, and secret/email
   redaction.
4. Never return tokens or raw `whoami` identity to the renderer.
5. Tie login flows to a provider/account generation so deletion or mutation
   prevents stale completion.

## Phase 3: Kiro CLI

1. Detect the official `kiro-cli` binary and version.
2. Support official browser and forced device login modes for unified,
   Builder ID, Google, GitHub, and Identity Center login flags.
3. Poll bounded flow status and support cancellation/timeouts.
4. Discover models using `kiro-cli chat --list-models --format json`.
5. Report only authenticated state and the authentication method/category.
6. Keep the official CLI adapter single-identity because that CLI exposes one
   global OS session. This does not prohibit a separate organisation-controlled
   token-broker mode: multi-account credentials may be issued explicitly,
   encrypted with OS-backed storage, leased to requests, audited and revoked
   without ever entering renderer state.

## Phase 4: direct ACP execution

1. Spawn `kiro-cli acp` over JSON-RPC stdio from the desktop process.
2. Initialize only required client capabilities; do not silently grant terminal
   or filesystem permissions.
3. Create/load sessions and apply account-approved models through
   `session/set_model`.
4. Translate streaming agent message chunks and terminal completion into Kyrei
   events; surface tool permission requests through Kyrei's safety policy.
5. Do not expose ACP as an OpenAI-compatible network proxy.

## Migration

- Account pool schema `1 -> 2`.
- Public gateway config `3 -> 4` only if the persisted top-level representation
  changes; tolerate older configs either way.
- Existing accounts receive no `modelIds` field and therefore retain access to
  all existing provider models.
- No session-store migration is required.

## Rollout guardrails

- Feature UI appears only when the connector is detected and capability checks
  pass.
- Kiro multi-account remains disabled with an explicit explanation.
- All browser navigation remains external; renderer popup/navigation blocking
  stays enabled.
- Any secret-storage or auth-process failure leaves the account auth-required.
