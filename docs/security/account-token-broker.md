# Account token broker security model

## Corrected position

Pooling organisation-controlled accounts is not inherently unsafe. It is a
common access-control pattern: employees receive a bounded service capability,
while administrators keep ownership of the upstream accounts and can revoke
access centrally. The security question is how credentials are issued, stored,
routed, audited, and revoked.

Kyrei may support Kiro-Go-style multi-account routing, but it must not expose
refresh credentials to the renderer or silently copy credentials from an
employee's unrelated personal session.

## Trust boundaries

1. The renderer handles account labels, policies and health summaries only.
2. The local gateway authenticates every request with its per-launch capability.
3. The core token broker owns OAuth/device flows, credential encryption and
   access-token refresh.
4. Provider adapters receive a short-lived access token only for the selected
   request and account lease.
5. Logs, exports, crash reports and agent context never contain credentials.

## Credential lifecycle

- Prefer provider-supported OAuth Authorization Code + PKCE or Device
  Authorization flows.
- Treat refresh tokens, client secrets and imported credential documents as
  secrets at rest.
- Encrypt each credential envelope with an OS-backed key: DPAPI on Windows,
  Keychain on macOS, and Secret Service/KWallet on Linux. If a secure Linux
  backend is unavailable, fail closed or require an explicit user-managed
  passphrase; never downgrade silently to plaintext.
- Keep access tokens in memory, refresh shortly before expiry, and erase leases
  after completion or cancellation.
- A logout, administrator disable, provider removal or suspected compromise
  revokes new leases immediately and invalidates cached access tokens.
- Never display, export or return raw credentials through the public gateway.

## Pool policy

Each account has an immutable internal ID, operator-visible label, enabled
state, model allowlist, weight, concurrency limit, cooldown and health state.
Routing filters by provider and model before applying affinity or balancing.
Accounts that are disabled, expired, over quota or authentication-failed are
not eligible. Session affinity is a routing hint, not an entitlement bypass.

An organisation can create independent pools for teams or projects, assign
specific models and quotas, and remove an employee's access without sharing the
underlying upstream credential with that employee.

## Audit and operator controls

Audit events contain account ID, actor, provider, model, policy decision,
timestamps and token/credit counters — never token values. Operators can:

- disable an account or an entire pool;
- revoke all active leases;
- rotate or re-authorise credentials;
- restrict accounts to models and projects;
- inspect health, quota and recent policy decisions;
- export configuration without credential material.

## Kiro integration stages

The official Kiro CLI connector intentionally exposes one global CLI identity
for browser/device authentication status and model discovery. Kyrei now also
has a separate first-stage broker for organisation-owned Kiro API keys. It
stores those keys through the OS-backed secret codec, derives one isolated
`KIRO_HOME` per account, enforces one concurrent operation per profile, and
supports verification, model discovery, model/project policies, affinity and
immediate lease revocation. It remains distinct from the user's global CLI
session and does not import browser state.

Task execution transport and account-scoped browser/device sign-in are later
protected stages. Until they are implemented, the organization broker must not
be advertised as a Kyrei chat execution provider.

Kiro-Go demonstrates useful routing mechanics: multiple authentication
methods, token refresh, account disablement, weighted selection, quota checks
and cooldown. Kyrei reuses the policy concepts, but deliberately excludes its
private token endpoints, raw credential export and plaintext secret storage.
