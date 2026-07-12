# Hermes → Kyrei: settings and capability parity matrix

**Audit date:** 2026-07-13
**Hermes source:** local Hermes Agent Desktop, commit `3b2ef789dfcf`
**Kyrei baseline:** `d191596db7fe`
**Method:** read-only source audit; credential values were not inspected

`Port` means transfer the behavior closely, `Adapt` means keep the product idea behind Kyrei's local-first boundaries, and `Reject` means deliberately exclude it.

## Settings surface

Hermes sources: `apps/desktop/src/app/settings/index.tsx`, `apps/desktop/src/app/settings/constants.ts`, `hermes_cli/config.py:976`, and `hermes_cli/web_server.py:609-824`.

| Area | Hermes capability | Kyrei state | Decision |
|---|---|---|---|
| Import/export/reset | Whole config through Settings footer | Runtime and provider profiles export without secrets | Port versioning, preview diff, section selection |
| Model | Main provider/model, context override, fallbacks, reasoning, fast tier | Unlimited profiles; roles/fallback UI partly dormant | Adapt role routing and scoped fallback profiles |
| Chat | Personality, timezone, reasoning blocks, image mode | Personality/reasoning visibility | Port timezone and image mode |
| Appearance | Language, theme profiles, zoom, translucency, tool view, embed consent | Theme/import, scale, density, tool view, language | Adapt translucency; reject third-party inline embeds |
| Workspace | cwd, project/strict execution, persistent shell, env passthrough, read cap | Workspace jail and read cap | Adapt local PTY/process and optional Docker |
| Safety | approvals, timeout, allowlist, secret redaction, private URLs, checkpoints | Policy modules exist but local tools bypass them | Port first; this is P0 |
| Memory/context | Built-in/external memory, compression thresholds and protected messages | Strong dormant stores, CCR pruning, GBrain/OpenViking | Adapt structured summary and reviewed learning |
| Voice | STT/TTS provider matrix plus local engines | Web Speech | Keep Web Speech; optional Piper/Whisper later |
| Advanced | Toolsets, backend, caps, retries, delegation, updates | Base caps/retries only | Adapt schema-driven UI; hide unsupported controls |
| Notifications | Per-event desktop notifications and approval actions | Completion notification/sound | Port after approval lifecycle |
| Providers/keys | OAuth accounts and dynamic env catalogue | Encrypted unlimited profiles | Add health/catalog; reject account marketplace coupling |
| Gateway | Local, remote, cloud | Loopback local only | Reject remote/cloud gateway |
| Tool keys | Capability/plugin credentials | Model provider secrets only | Adapt capability-scoped vault after skills/MCP |
| Sessions | Default project, archive/restore/delete | Search/pin/export/rename/delete | Port archive/restore and default workspace |
| About/updates | Check/apply/restart/manual fallback/uninstall | Missing | Port after runtime P0 |
| Skills/MCP | Dedicated Capabilities UI and runtime | Missing | Port progressively |

## Provider catalogue

Hermes source: `plugins/model-providers/<slug>/__init__.py`, `providers/__init__.py`, and `providers/base.py`.

Kyrei does not need one transport implementation per brand. Its provider profiles can represent the catalogue as presets while keeping six explicit native protocols.

| Transport | Hermes profiles | Kyrei decision |
|---|---|---|
| OpenAI-compatible | alibaba, alibaba-coding-plan, arcee, azure-foundry, custom, deepseek, gmi, huggingface, kilocode, kimi-coding, kimi-coding-cn, novita, nvidia, ollama-cloud, opencode-zen, opencode-go, openrouter, stepfun, xiaomi, zai | Provider presets on `openai-chat` |
| Anthropic Messages | anthropic, minimax, minimax-cn, minimax-oauth | Native transport; MiniMax presets; reject OAuth coupling |
| Google | gemini | Already native |
| Bedrock | bedrock | Already native |
| Vertex | vertex | Already native |
| Responses-like | xai, openai-codex | xAI preset; reject proprietary ChatGPT/Codex OAuth |
| Account/device auth | nous, qwen-oauth, minimax-oauth | Prefer API-key profiles; reject Hermes/Nous coupling |
| External process | copilot, copilot-acp | Reject ACP core coupling; possible future coding-agent plugin |

Hermes additionally supports profile `.env`, `auth.json`, 1Password, and Bitwarden (`agent/credential_sources.py`, `agent/secret_sources/*`). Kyrei should adapt external secret references without copying resolved values into config.

## Runtime parity

| Capability | Hermes behavior | Kyrei state | Decision |
|---|---|---|---|
| Fallback chain | Provider/model chain with scoped auth | Model IDs pinned to active endpoint | Adapt to provider-profile IDs |
| Auxiliary roles | Vision, extraction, compression, skills, approvals, MCP, title, curator, review, MoA | `default/small/plan` stored but not routed | Typed role router |
| MoA | Reference models plus aggregator | Missing | After bounded delegation |
| Context compression | Compressor at 50%, target 20%, protects last 20/first 3 | Large tool-output pruning only | Add structured summary + CCR pointers |
| External memory | 8 plugins: byterover, hindsight, holographic, honcho, mem0, openviking, retaindb, supermemory | GBrain/OpenViking adapters; built-in SQLite dormant | Keep built-in authoritative; one optional external layer |
| Post-turn learning | Background memory/skill review and curator | Missing live wiring | Proposals with explicit review; never silent self-edit |
| Terminal backends | Local, Docker, Singularity, Modal, Daytona, SSH; PTY/background | One-shot local command | Local PTY + optional Docker; reject cloud/SSH core |
| Approvals | Manual default, once/always/deny, grouped UI, native actions | Event type exists; no pause/respond path | P0 end-to-end gate |
| Agent browser | Search/extract plus click/type/snapshot/CDP/dialogs | Safe text search/fetch | Disposable agent-only browser; reject arbitrary eval/profile reuse |
| Skills | Progressive list/view/manage/install with provenance and AST checks | Missing | Trusted-root list/view first, controlled install second |
| Delegation | Isolated sync/background children, concurrency 3, depth 1 | Reviewer contracts only | Flat read-only workers, single writer, strict budgets |
| Sessions/projects | Archive, branch tree, worktree groups, resume, artifacts | Core session actions only | Archive/resume/lineage first |
| Checkpoints | Once-per-turn snapshots; 20/500 MB/7-day limits; restore UI | Immediate copy snapshot/rollback | History, retention, restore, audit |
| Computer use | Cross-platform CUA, all side effects approved | Missing | Opt-in only after approvals |
| Goals/cron/Kanban | Bounded Ralph, schedules, multi-agent board | Dormant goal verifier | Goals after safety; schedules/Kanban later |
| Updates | 30-minute/focus checks, apply/restart, skew handling | Missing | Local signed update flow after core stability |

## Current Kyrei truth table

| Status | Capabilities |
|---|---|
| Implemented | Electron-only shell, loopback authenticated gateway, provider profiles, six transports, stream/tool loop, workspace tools/jail, safe web search/fetch, project context, project intelligence, GBrain opt-in, session basics |
| Partial | Secret fallback on Linux, active-provider-only fallbacks, terminal safety, audit, OS sandbox, context management, composer, settings, voice |
| Dormant | Role models, approval policy engine, SQLite/vector memory, LTM writer/handoff, OpenViking, reliability modules, reviewer/plans, draft/history helpers |
| Missing live | Image inputs, skills, MCP, subagents, MoA, persistent PTY, LSP, archive/branch lineage, update manager |

The critical defect is that `permissions.terminal`, review mode, and deny rules are visible in Settings but `run_command`, `write_file`, and `edit_file` do not call the permission decision, pre-hook, secret scan, or approval path. Until fixed, these controls can create a false sense of protection.

## Prioritised delivery order

1. End-to-end local-tool safety gate and approval lifecycle.
2. Flat bounded read-only subagents with a single writer.
3. Skills list/view with provenance, then controlled install/manage.
4. Two-stage context compression with structured summaries and reversible CCR recall.
5. Typed auxiliary model router and provider-profile-scoped fallbacks.
6. Session archive/resume/branch lineage and interrupted-run recovery.
7. Disposable agent-only browser automation on the existing SSRF boundary.
8. Persistent local PTY/processes and optional Docker isolation.
9. Checkpoint history, retention, restore, and audit.
10. Bounded post-turn memory/skill proposals with explicit user review.

## Product boundary

Port Hermes runtime contracts, not its cloud ecosystem. Kyrei remains a Windows/macOS/Linux desktop application with no user-facing embedded browser, no remote Hermes gateway, no mass messaging platform layer, no proprietary Hermes provider, and no silent autonomous modification of its own skills or memory.
