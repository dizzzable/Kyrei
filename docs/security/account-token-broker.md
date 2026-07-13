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

The current official Kiro CLI connector intentionally exposes one global CLI
identity for authentication status and model discovery. A separate broker mode
can add multiple organisation-controlled Kiro accounts through explicit
Builder ID / IAM Identity Center / supported credential import flows. That mode
must use the lifecycle above and remain distinct from the user's global CLI
session.

Kiro-Go demonstrates the useful routing mechanics: multiple authentication
methods, token refresh, account disablement, weighted selection, quota checks
and cooldown. Kyrei should reuse those ideas while strengthening desktop secret
storage and keeping all tokens behind the core boundary.
