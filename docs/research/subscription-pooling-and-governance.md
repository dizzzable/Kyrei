# Subscription pooling & governance (OmniRoute / Kiro-Go / codex-lb → Kyrei)

**Date:** 2026-07-17  
**Intent:** Companies and power users pool paid API keys / subscription-backed accounts, give staff **local** access without handing raw secrets, revoke access quickly, and see **where tokens/money went**.  
**Sources (patterns only, not forks):**
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — multi-provider gateway, fallback, compression, one endpoint  
- [Kiro-Go](https://github.com/Quorinex/Kiro-Go) — multi-account pool for Kiro→OpenAI/Anthropic, usage, admin, token refresh  
- [codex-lb](https://github.com/Soju06/codex-lb) — ChatGPT account LB, usage dashboard, **per-API-key limits**, dashboard auth  

**Legal note:** Pooling *subscription* accounts may violate vendor ToS. Product should default to **BYO API keys** and document ToS risk for subscription reverse-proxies. Governance features (revoke, budgets, audit) are legitimate for **company-owned keys**.

---

## 1. What you actually need (product requirements)

| Need | Why |
|---|---|
| **Pool many credentials** (1× GPT, 1× Claude, N keys) | One agent, many backends; failover when one hits limit |
| **Employees never hold raw company keys** | Leak / side projects on company dime |
| **Revoke one person without rotating every key** | Offboarding / abuse |
| **Per-user / per-key budgets** (tokens, $ , models) | Cap personal “хотелки” |
| **Usage ledger** by provider, model, user, session, day | Finance + savings narrative |
| **Optional shared gateway on LAN** | Team uses company endpoint; admin controls it |
| **Agent remains local-first** | Workspace tools stay on the PC |

This is **governance + routing**, not “another coding harness monolog”.

---

## 2. How the three projects map

| Capability | OmniRoute | Kiro-Go | codex-lb | Kyrei today |
|---|---|---|---|---|
| Multi-provider one hop | ✅ | Kiro-focused | ChatGPT/Codex-focused | ✅ multi-provider profiles |
| Multi-**account** pool same vendor | partial | ✅ RR + refresh | ✅ LB + strategy | ✅ `accountPool` per provider + Kiro org pool |
| Auto fallback on error/quota | ✅ | account rotate | account rotate | ✅ openStream + fallbacks + cooldown |
| Usage / cost dashboard | partial | ✅ tracking | ✅ 28d trends, cost | ⚠️ per-turn usage in UI; **no durable org ledger** |
| Employee API keys with limits | partial | admin panel | ✅ per-key rate/cost/model | ❌ missing |
| Disable user without touching pool | via gateway keys | admin | API key delete/disable | ❌ missing |
| Compression to save tokens | ✅ RTK-style | — | — | ✅ CCR + summary (local) |
| Admin web UI | yes | yes | yes | Settings only (single-user desktop) |
| Expose OpenAI-compatible proxy for *other* tools | core | core | core | ❌ loopback gateway is Kyrei-internal |

---

## 3. What Kyrei already has (foundation)

```text
[Desktop] ──loopback──► [Kyrei gateway]
                              │
                              ├─ providers[] + secrets (encrypted)
                              ├─ accountPool (balanced | round-robin | fill-first)
                              │     maxConcurrency, cooldown, session affinity
                              ├─ kiroOrganization (multi-account Kiro path)
                              ├─ modelAssignments.fallbacks
                              ├─ openStream early fallback
                              └─ turn usage (input/output tokens, cost when known)
```

**Good for:** solo power user or small team on one machine — several company keys in one Kyrei, failover, Kiro pool UI.

**Not enough for:** “20 employees, one shared pool, revoke Alice, show finance the Claude bill by person.”

---

## 4. Target architecture (Kyrei-shaped, not a clone)

### Mode A — **Solo / small office (near-term)**  
All keys stay **on the machine admin trusts** (or encrypted store). One Kyrei desktop (or one shared PC).  
- Multiple providers + multi-account pool  
- Fallbacks  
- **Local usage ledger** (SQLite): every request → who (machine user), provider, model, tokens, $  
- Optional soft budgets per day  
- **No multi-employee remote auth yet**

### Mode B — **Company gateway (enterprise, later)**  
```text
 Employee Kyrei (or Codex/Claude Code)
        │  only sees COMPANY_BASE_URL + personal access token
        ▼
 [Kyrei Access Gateway]  ← admin: pool keys, budgets, revoke tokens
        │
        ├─ OpenAI account pool
        ├─ Anthropic keys
        ├─ Kiro accounts (via existing org path / external)
        └─ ledger: employee_id × provider × model × tokens × $
```

Employee **never** has company `sk-…`. Admin disables `employee_token` → access gone.  
Raw pool keys only on gateway host.

This is the **codex-lb / Kiro-Go / OmniRoute governance pattern**, implemented as a **first-class Kyrei module**, not a dependency on those binaries (optional: *point Kyrei at* an external gateway as one “provider”).

---

## 5. Capability backlog (prioritized)

### P0 — Local multi-sub “works for me + saves money” (solo)
1. **Durable usage ledger** — **SHIPPED** `core/usage-ledger.js` → `dataDir/usage-ledger.jsonl`  
   Fields: session, provider, accountId, model, tokens, costUsd, status, latency, reserved `accessTokenId`  
2. **Settings → Usage** — **SHIPPED** summary by day / provider / model (`GET /api/usage`)  
3. **Engine returns usage** on `RunKyreiChatResult` (bridge totals + registry cost estimate)  
4. **Surface account used** on status (which pool member served the turn) — next  
5. Keep existing pool + fallback reliability (cooldowns, ready filters)

### P1 — Soft governance on one install
5. **Daily/monthly soft/hard budget** — **SHIPPED** `engine.usageBudget` + `core/usage-budget.js`  
   Soft → status in Usage panel; hard → `POST /api/prompt` returns `429 budget_exceeded`  
6. **Disable account member** without deleting secret (already close via pool status)  
7. Export CSV for accounting  

### P2 — Company-ready access layer
8. **Access tokens** — **SHIPPED** `core/access-tokens.js`  
   - Plain `kyrei_at_…` shown once; secrets store **SHA-256 only**  
   - Public principals in `config.accessControl`  
   - API: list/create/patch/delete/regenerate + `requireToken`  
   - Prompt: optional/required Bearer or `X-Kyrei-Access-Token`  
   - Ledger tags `accessTokenId` + `principalLabel`  
   - Per-principal hard budget → `429 principal_budget_exceeded`  
9. Optional **listen beyond loopback** with explicit risk dialog + bind allowlist  
10. Admin list = Settings → Usage → Access tokens; revoke = disable/delete  
11. Tag usage by `accessTokenId` / user label — **SHIPPED**

### P3 — Full gateway product
12. OpenAI-compatible `/v1` — **SHIPPED**  
    - `GET /v1/models`, `POST /v1/chat/completions` (+ stream)  
    - Auth: access token and/or gateway token; `proxy.requireAccessToken` / LAN  
    - Ledger + global/principal budgets  
    - `config.proxy`: enabled, listenLan (bind 0.0.0.0 after restart), requireAccessToken  
13. Optional compression policy toggle (already have local CCR)  
14. Multi-node / Postgres ledger (only if customers demand)

---

## 6. Mapping your story → product language

| You said | Product feature |
|---|---|
| 1 GPT + 1 Claude together | Multi-provider + role/fallback routing |
| Company buys keys, staff use locally | Access tokens; keys only on admin gateway |
| Cut employee access instantly | Disable access token |
| Work vs personal abuse | Ledger + per-token budgets + model allowlist |
| Count savings | Ledger + optional baseline cost comparison |
| Many subscriptions for staff | Pool N accounts per provider + RBAC later |

---

## 7. Explicit non-goals / risks

| Risk | Stance |
|---|---|
| ToS of ChatGPT Plus / Claude Pro reverse-proxy | Document; prefer **API keys** for commercial product |
| Shipping secrets to employees | Never; access tokens only |
| Becoming OmniRoute clone | No — keep agent + optional **governance gateway** module |
| Silent spend | Default soft limits + visible usage |

---

## 8. Immediate engineering entry points (in-repo)

| Area | Files / surface |
|---|---|
| Account pool | `core/provider-account-pool.js`, `ProviderAccountPoolDialog.tsx` |
| Kiro multi-account | `core/kiro-organization-*.js`, `KiroOrganizationPoolCard.tsx` |
| Fallbacks | `modelAssignments.fallbacks`, `openStream` |
| Turn usage | engine `RunKyreiChatResult.usage` → gateway ledger |
| **Ledger (P0 shipped)** | `core/usage-ledger.js`, `GET /api/usage`, Settings → Usage |
| **Access tokens (P2)** | gateway middleware + secrets store (planned; fields reserved on ledger events) |

---

## 9. Success criteria

| Criterion | Pass |
|---|---|
| Solo power user | GPT+Claude keys, failover, weekly usage chart |
| Admin offboard | Disable one token; pool keys unchanged |
| Finance | Export tokens/$ by provider for a month |
| Security | Employee disk has no company `sk-` |
| Agent quality | Unchanged local tools/jail/modes |
| **Capacity (Vasya scenario)** | 2+ accounts per Claude/GPT/Grok; 429 hops to spare without killing the turn |

## 9b. Capacity pools (OmniRoute-class, shipped foundation)

| Piece | Location |
|---|---|
| Family detection (claude/gpt/grok/…) | `core/capacity-router.js` |
| Order: primary accounts → family siblings → fallbacks | `orderCapacityCandidates` |
| Account strategies | `spare-first`/`fill-first`, `round-robin`, `least-used`, `balanced` in `provider-account-pool.js` |
| Chat turn wiring | gateway expands multi-account + family before `openStream` |
| Provider catalogue | expanded OpenAI-compatible templates (v2) — not 250 free scrapers |

**Operator setup for Vasya:**
1. Add providers: Anthropic, xAI, OpenAI (or OpenRouter).
2. For each: Account pool → 2 keys, strategy **spare-first** (or fill-first).
3. Issue Vasya an access token; point tools at `/v1` with `providerId/modelId`.
4. If Claude key A hits 429 → key B same model → optional OpenRouter claude sibling → configured fallbacks.

---

## 10. Recommended sequence

1. **Ship current agent polish** (modes, OOB team, assignment fix) — quality base.  
2. **P0 usage ledger + Usage UI** — proves value of multi-model pooling.  
3. **P1 budgets** — first “stop the bleed” control.  
4. **P2 access tokens + optional non-loopback** — real company story.  
5. Only then external OpenAI proxy (P3) if customers still need Codex-CLI-through-Kyrei.
