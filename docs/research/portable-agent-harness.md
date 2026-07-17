# Portable agent harness (provider-agnostic)

**Status:** living  
**Goal:** Take *behaviors* from top coding agents and frontier chat harnesses, rewrite them for Kyrei architecture, so any provider/model gets the same high-signal contracts.

## What we take vs what we refuse

| Take (patterns) | Refuse (product monologs) |
|---|---|
| Explore → edit → verify loop | Full Fable/Sol/Claude.ai XML dumps |
| Read-before-edit, care/blast radius | Ads, Mythos marketing, sports UI tools |
| Parallel read tools | IDE-only code-reference syntax |
| Progressive skills load | Silent every-turn MEMORY rewrite |
| MCP list→call + untrusted | Computer-use / Chrome product chrome |
| Plan/durable memory layers | Hard dependency on one vendor model |

## Kyrei mapping

| Capability | Kyrei home |
|---|---|
| Core contracts | `core/engine/prompt/harness-contracts.ts` + `system.ts` |
| Tool wording | `core/engine/prompt/tool-descriptions.ts` |
| Coding phases | `core/engine/coding-mode.ts` + `modelAssignments.build/polish` |
| Skills | progressive `search_skills` / `read_skill` |
| MCP | `mcp_list_tools` / `mcp_call` opt-in |
| Memory | curator + memory_search/write (proposal-first) |
| Team / pipeline | team_delegate + missions (orchestration) |
| Safety | jail + permissions + immutable footer |

## Provider independence

- No tool names from other products (`apply_patch` → our `edit_file`).
- No “you are Claude/ChatGPT”.
- Mode/model assignments are optional operator config; defaults work with any main model.

## Coding modes (chat + orchestration)

| Mode | Intent | Tools | Models |
|---|---|---|---|
| auto | Agent picks phase each turn | full | current |
| plan | Decision-complete plan | **hard-gate** no write/edit/shell/MCP write/team_delegate | optional plan assignment |
| build | Implement | full | optional build |
| polish | Audit / bugs | full | optional polish |
| deepreep | Code+web research, human + team | full | optional deepreep |

- Session `codingMode` overrides engine default for that chat.
- UI: Composer Mode pill, `/mode <name>`, Settings → Chat / Model assignments.

## Changelog

- **2026-07-17:** Plan hard-gate tools; session-scoped codingMode; deepreep/plan/auto modes (PROMPT 1.23).
- **2026-07-16:** Initial portable harness contracts (PROMPT 1.22) + coding modes (1.21).
