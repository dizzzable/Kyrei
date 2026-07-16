# Hermes → Kyrei: settings and capability parity matrix

**Last refresh:** 2026-07-16  
**Hermes source:** local tree under `hermes/hermes-agent` (desktop + CLI; historical audit also used commit `3b2ef789dfcf`)  
**Kyrei baseline:** main branch as of refresh (package `0.4.2`+)  
**Method:** code-backed review of `core/engine`, `core/gateway.js`, Settings UI, and prior audit rows  

`Port` = transfer behavior closely · `Adapt` = product idea inside Kyrei local-first bounds · `Reject` = deliberately exclude  

When this file and old plans disagree, **this matrix + `.kyrei/memory/MEMORY.md` win**.

---

## Settings surface

| Area | Hermes capability | Kyrei state (2026-07-16) | Decision |
|---|---|---|---|
| Import/export/reset | Whole config footer | Runtime/provider export without secrets | Port versioning/diff later |
| Model | Main model, fallbacks, reasoning, aux roles | Unlimited profiles; `modelAssignments.worker` + fallbacks; default reasoning | Adapt full aux role map later |
| Chat | Personality, timezone, reasoning, image mode | **Shipped:** personality catalog, timezone, show reasoning, image input mode | Keep |
| Appearance | Theme, zoom, translucency, tool view | Theme/import, scale, density, language, tool view | Adapt translucency optional |
| Workspace | cwd, PTY, env, read cap | Workspace jail + read cap; no persistent PTY settings | Local PTY later |
| Safety | once/always/deny, allowlist, checkpoints | Signed allow-once/deny; **Always allow/deny → exact rules**; protected paths; sandbox | Session-scoped TTL optional |
| Memory/context | External plugins, compression, curator | Hybrid SQLite FTS + mirror; compression prune; **memory curator** (archive); GBrain/OV opt-in | Keep built-in SoT |
| Voice | STT/TTS matrix | Web Speech only | Reject full matrix for now |
| Advanced | Toolsets, backends, delegation, updates | Caps, retries, delegation, MCP, reliability toolLoop | Hide unsupported backends |
| Notifications | Per-event desktop | Completion notification/sound | Port granularity later |
| Providers/keys | OAuth catalog | Encrypted profiles + Kiro connectors; no Hermes/Nous coupling | Reject marketplace OAuth |
| Gateway | Local/remote/cloud | Loopback local only | **Reject** remote/cloud |
| Skills/MCP | Capabilities UI | **Shipped:** Skills settings + MCP settings | Controlled install later |
| Sessions | Archive/restore/delete/branch | **Shipped:** soft archive, restore, delete, curate, **fork lineage** | Git worktree later |
| About/updates | Check/apply/restart | Version in app; no auto-updater | Port after stability |
| Skills curator | Skill catalog hygiene + patches | **Opt-in** heuristic + optional LLM **proposal** patches; no silent rewrite | Keep safe defaults |

---

## Runtime parity

| Capability | Hermes behavior | Kyrei state (2026-07-16) | Decision |
|---|---|---|---|
| Fallback chain | Provider/model chain | Active endpoint + modelAssignments fallbacks | Enrich profile-scoped chain later |
| Auxiliary roles | Vision, compress, skills, title, curator… | Worker assignment used by delegate/curators; not full role map | Typed router later |
| MoA | Multi-model aggregate | Missing | After deliberate need |
| Context compression | Structured summary + protect windows | **Two-stage:** tool CCR prune + middle REFERENCE-ONLY summary (model projection; UI history full). `summaryUseLlm` opt-in. Dual-trigger: max(local estimate, last-step provider usage) | Keep; dual-trigger shipped |
| External memory | Many plugins | GBrain + OpenViking adapters; local FTS authoritative | Keep |
| Post-turn learning | `background_review` memory/skills | **Memory curator** on archive (not every turn); **skills curator** on-demand scan | No silent every-turn self-edit |
| Skills hygiene | Skill Curator lifecycle | Opt-in scan; propose/disable stale; LLM suggest_patch explicit apply | **Never** auto-patch SKILL.md |
| Terminal backends | Local/Docker/SSH/cloud | One-shot local command + sandbox | Local PTY + optional Docker later |
| Approvals | once/always/deny + promote | **Shipped** promote-to-persistent exact rule | Session TTL optional |
| Agent browser | Click/type/CDP | Safe `web_search` / `web_fetch` | Disposable browser later |
| Skills runtime | Progressive load, provenance | **Shipped** store + progressive tools | Marketplace/AST later |
| Delegation | Isolated children | Bounded delegation + team + pipeline | Keep budgets strict |
| Sessions | Archive, branch, worktree | Soft archive + **fork lineage** (`parentSessionId` / `rootSessionId`, `POST …/fork`); no git worktree | Worktree later |
| Checkpoints | Retention/history UI | Turn snapshots + revert/changes panel | History retention UI later |
| Computer use | CUA | Missing | Opt-in far later |
| Goals/cron/Kanban | Ralph, schedules, board | Cron **shipped**; goal verifier exists; no Kanban board | Board later |
| Updates | Check/apply | Missing auto-updater | After core stability |

---

## Current Kyrei truth table (code-backed)

| Status | Capabilities |
|---|---|
| **Implemented** | Electron shell, loopback gateway, multi-provider profiles, six transports, stream/tool loop, workspace tools/jail, safe web tools, project intel, hybrid memory + session mirror, session soft-archive, **session fork lineage**, memory curator, personality catalog, image input modes, skills store + optional skills curator (proposal-first), MCP opt-in, delegation/team/pipeline, cron, supervised file review (hunk), approval promote-to-rule, **two-stage context compression** (CCR prune + middle summary), tool-loop guardrails, timezone/reasoning defaults, prompt profiles, planning files, messaging webhook opt-in, GBrain/OpenViking opt-in, Kiro CLI + org pool connectors, EN/RU i18n |
| **Partial** | Aux model roles (worker only), fallback chain richness, checkpoint history UI, notification granularity, secret store UX on Linux, OS sandbox strict modes, transcript import (some adapters), agent browser automation |
| **Missing / reject** | Remote/cloud gateway, Hermes/Nous OAuth marketplace, pets, MoA, Computer Use, STT/TTS matrix, silent post-turn skill/memory rewrite, persistent multi-backend PTY/SSH core, git worktree isolation, auto update manager |

---

## Skills / memory learning — explicit safety contract

| Action | Automatic? | Notes |
|---|---|---|
| Memory curator on archive | If enabled (default on) | Background after soft-archive (HTTP non-blocking, 25s abort); `apply_safe` writes notes/LTM/handoff; MEMORY.md needs apply_all or manual apply |
| Skills curator scan | Only if enabled (**default off**) + user Scan | Manual or future schedule; not silent post-turn |
| Disable stale skill | Only `apply_safe` after scan | State flag only; no file delete |
| LLM skill patch | Never automatic | Proposal + **Apply patch** on owned skill |
| Full SKILL.md / MEMORY rewrite | Never silent | Product boundary |

---

## Prioritised remaining delivery (honest)

**Done (do not re-list as missing):** skills list/manage, archive/curate memory, promote-to-rule, image mode, personality catalog, optional skills curator proposals, **two-stage compression**, **session fork lineage**.

1. Session-scoped approval TTL (expiring allow-once beyond current session map).
2. Richer aux role router (compress/title/vision) reusing worker pattern — still no silent writes.
3. Interrupted-run recovery polish.
4. ~~Provider-usage dual-trigger~~ **shipped** (`providerUsageFromSteps` in prepareStep).
5. ~~Sidebar fork tree~~ **shipped** (nest under parent when both listed).
6. Disposable agent-only browser on existing SSRF boundary.
7. Local persistent PTY + optional Docker isolation.
8. Checkpoint history retention UI + audit browse.
9. Controlled skills install from trusted archives (still no silent patch).
10. About/update manager (signed local updates).
11. Broader transcript import (Cursor/Hermes DB) behind adapters.

---

## Product boundary

Port Hermes **runtime contracts**, not its cloud ecosystem. Kyrei stays a Windows/macOS/Linux desktop app with:

- no user-facing embedded browser for product chrome  
- no remote Hermes gateway  
- no mass messaging platform layer as core  
- no proprietary Hermes/Nous provider coupling  
- **no silent autonomous modification of skills or durable memory catalogs**

Historical planning docs (`docs/hermes-parity-plan.md`, `docs/superpowers/plans/*`) may lag; update **this matrix** when shipping parity work.
