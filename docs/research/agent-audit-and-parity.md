# Kyrei coding-agent audit + external feature parity

**Date:** 2026-07-17  
**Scope:** Bring current WIP (modes, harness, OOB team, updates) to reliable ship quality; port *patterns* from OmniRoute / Kiro / open coding agents — not product clones.  
**Rule:** Local-first, multi-provider, no silent self-mutation of memory/skills.

**Related:** full program from Headroom / SkillOpt / Supergoal / curl.md / ECC / Karpathy / Tolaria →  
[`external-agent-systems-study.md`](./external-agent-systems-study.md).

---

## 1. What we already shipped (WIP baseline)

| Area | Status | Notes |
|---|---|---|
| Portable harness contracts | **Done** | `harness-contracts.ts` + system prompt 1.23 |
| Coding modes auto/plan/build/polish/deepreep | **Done** | Session override, Mode pill, `/mode` |
| Plan hard-gate tools | **Done** | Turn-start filter + mid-turn activeTools + approval deny |
| Pipeline stage → mode | **Done** | research→deepreep … verify→polish |
| Auto phase adopt UI | **Done** | Effective phase / MODE_SWITCH → session mode + optional model |
| OOB Coding team + prompt profiles | **Done** | Seed on empty config; mode stays single until toggle |
| In-app updates | **Done** | electron-updater, user-confirmed install |
| Role model assignments (plan/build/…) | **Fixed** | Was dropped by `normalizeGatewayConfig` — only worker/fallbacks survived |

---

## 2. Reliability gaps (“капризы”) — priority

| P | Gap | Risk | Fix direction |
|---|---|---|---|
| P0 | Role modelAssignments stripped on normalize | Settings save “forgets” plan/build models | **Fixed** in provider-config |
| P0 | Large uncommitted surface without full gate | Ship risk | Run full `npm run gate` before release |
| P1 | Mid-turn Effective phase only next step | First tool batch after phase line may still mutate | Keep; document; optional same-step deny via approval (partial) |
| P1 | Windows shell = cmd default, not PowerShell | Model may use bash-isms | Prompt note + optional `shell: pwsh` preference later |
| P1 | Team OOB re-seeds if profiles emptied | Hard to keep zero profiles | Acceptable for OOB; optional `orchestration.seeded: false` later |
| P2 | No deterministic intent pre-router | Model may skip tools | Eval suite + stronger stop conditions |
| P2 | Goal verifier not default end-of-turn | False “done” | Opt-in reliability flag |
| P2 | Explicit prompt-cache breakpoints | Missed $ savings on Anthropic | Provider-option later |
| P3 | Persistent PTY / interactive terminal | vs IDE agents | One-shot `run_command` remains; PTY backlog |

---

## 3. External products → Kyrei (port patterns, not clones)

> **Enterprise pooling / revoke / token accounting** is specified separately in  
> [`subscription-pooling-and-governance.md`](./subscription-pooling-and-governance.md)  
> (OmniRoute + [Kiro-Go](https://github.com/Quorinex/Kiro-Go) + [codex-lb](https://github.com/Soju06/codex-lb)).

### 3.1 OmniRoute (AI gateway / routing)

| Feature | OmniRoute | Kyrei now | Decision |
|---|---|---|---|
| One endpoint, many providers | Core product | Multi-provider profiles + loopback gateway | **Keep ours** (not become remote SaaS gateway) |
| Auto fallback on quota/error | Yes | `openStream` + modelAssignments.fallbacks + key pool | **Enrich** fallback UX + error-class routing |
| Free-tier / account pooling | Yes | Provider account pool + Kiro org pool | **Keep / polish** |
| Token compression before model | Yes | Two-stage context compression (CCR + summary) | **Keep**; avoid opaque middleman rewrite |
| Unified OpenAI/Claude translation | Yes | Native multi-protocol adapters | **Keep native** |
| MCP built into gateway | Yes | Opt-in MCP tools in engine | **Keep** |

**Do not:** re-home Kyrei as OmniRoute clone.  
**Do:** make our fallbacks and multi-account routing *boring-reliable* (clear UI, metrics, no silent model swap without signal).

### 3.2 Kiro (AWS agentic IDE) — “Kiro Go” / org connector

| Feature | Kiro | Kyrei now | Decision |
|---|---|---|---|
| Spec-driven (requirements → design → tasks) | Specs | Plan mode + `.kyrei/plan` + pipeline | **Adapt** stronger plan artifacts UI |
| Hooks (on-save / on-commit actions) | Yes | Cron + permissions; no FS hooks | **Later** opt-in hooks |
| Parallel agents | Yes | Team + pipeline + delegate_read | **Polish** defaults (OOB coding team) |
| Steering rules | Yes | AGENTS / project context / prompt profiles | **Keep** |
| Autopilot vs supervised | Yes | executionMode + file review | **Keep** |
| Kiro CLI / org accounts | AWS product | `kiroOrganization` connector already | **Polish** reliability of pool |

**Do not:** fork VS Code or depend on AWS identity.  
**Do:** spec quality of plan mode + pipeline stages feel “Kiro-grade” locally.

### 3.3 “Code LB” / open coding-agent class (Cline, OpenCode, Kilo, Codex CLI…)

Interpreted as **open agent-harness class** (if you meant a specific product, name it and we rematch).

| Feature | Class leaders | Kyrei now | Decision |
|---|---|---|---|
| Modes (code/architect/ask) | Common | auto/plan/build/polish/deepreep | **Keep + polish** |
| Diff review / accept hunks | Common | File review panel | **Keep** |
| Checkpoints / rewind | Common | Snapshots + changes panel | **UI polish** |
| Rules / project memory | Common | Layers + FTS + curator | **Keep** |
| Skills / MCP | Common | Shipped | **Keep** |
| Browser agent | Some | web_search/fetch only | **Reject** full CUA for now |
| Cloud sandbox | Some | Local PC shell | **Local-first** (product boundary) |

---

## 4. Target architecture (ideal loop — no drama)

```text
User goal
  → Mode (auto or locked)
  → Stable system prefix (cache-friendly)
  → Tools loop on LOCAL PC (files, shell, memory)
  → Verify (diagnostics/tests)
  → Optional delegate/team for parallel research
  → Durable write only via parent + permissions
  → Fallback chain if provider fails early
```

**Invariants (non-negotiable):**
1. Workspace jail + permissions always win over prompts.  
2. User/prompt profiles never override safety footer.  
3. No silent every-turn MEMORY/SKILL rewrite.  
4. Team stays off until user enables (OOB profile ready).  
5. Plan mode cannot mutate app source via tools.

---

## 5. Execution backlog (next sprints)

### Sprint A — Reliability polish (this ship)
- [x] Persist plan/build/polish/deepreep model assignments  
- [x] Windows shell note in harness (cmd default; explicit `pwsh`/`powershell`) — PROMPT 1.24  
- [x] Audit doc + parity matrix  
- [ ] Full `npm run gate` green on WIP  
- [ ] Snapshot/i18n/settings-copy aligned (prompt snapshot updated)  
- [ ] Commit cohesive release notes (modes + OOB team + updates + fix)

### Sprint B — OmniRoute-class routing polish
- [ ] Surface active fallback attempt in UI status  
- [ ] Per-provider cooldown visibility  
- [ ] Optional “sticky model” vs “cheapest available” policy (explicit)

### Sprint C — Kiro-class planning polish
- [ ] Plan mode default artifact under `.kyrei/plan` always encouraged  
- [ ] Pipeline default template coding-product (if not already)  
- [ ] Optional post-edit hook skeleton (lint/test) — opt-in

### Sprint D — Eval / no-caprice
- [ ] Golden path tests: plan blocks edit; auto adopts phase; OOB team seed  
- [ ] Smoke: send message → tool → complete on mock provider  
- [ ] Manual checklist: install, key, workspace, team toggle, update check

---

## 6. Definition of “ideal / no caprice”

| Signal | Pass |
|---|---|
| Settings save | Roles, team, modes survive restart |
| Plan mode | edit_file / run_command hard-fail |
| Auto mode | Effective phase updates pill next turn |
| Team off | No multi-role spend |
| Team on | Researcher/Critic/Architect available |
| Provider down | Fallback without hanging session |
| Memory | Search works; writes only when allowed |
| Update | User confirms download; no silent install |

---

## 7. Explicit non-goals (this phase)

- Becoming a multi-tenant cloud gateway (OmniRoute space)  
- Full interactive PTY product  
- Computer-use / browser agent  
- Silent self-improving memory every turn  
- Pasting third-party system monologs  
