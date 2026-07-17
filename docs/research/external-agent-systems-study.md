# External agent systems study → Kyrei roadmap

**Date:** 2026-07-17  
**Sources (user-provided):** Headroom, claude-code-harness, ECC, Karpathy skills, Tolaria, curl.md, SkillOpt, Supergoal.  
**Rule:** Port **patterns**, not product monologs / vendor lock / silent self-mutation.

---

## 1. Executive synthesis

Across these projects the same five *levers* show up:

| Lever | What winners do | Kyrei today | Gap |
|-------|-----------------|-------------|-----|
| **Context budget** | Compress tool/web/JSON *before* the model; keep full copy on disk | CCR + summary; web text extract | Smarter compressors (logs/JSON/diff), reversible stubs |
| **Stable prefix / cache** | Unchanging system+skills front; volatile tail | Harness contracts | Explicit cache breakpoints; measure cache hits |
| **Goal → phases → verify** | Adaptive plan on disk, one approve, autonomous loop, 3-strike heal | plan/build modes, pipeline, goal verify, heal handoff | Stronger on-disk phase specs + final audit + cleanliness |
| **Surgical quality rules** | Think / simple / surgical / tests-as-goals | Portable harness | Tighten Karpathy-class rules in contracts |
| **Skills as trainable text** | Validation-gated skill edits from trajectories | Progressive skills + curator | Optional offline skill-opt *proposal* loop (never silent apply) |
| **Web for agents** | URL → low-token markdown | web_fetch | curl.md-class markdown density + size caps |
| **Knowledge vault** | Markdown KB as agent context | Memory layers / LTM | Optional vault index, not a second product |

**Do not port wholesale:** ECC/Claude-Code-Harness monorepo dumps of 100+ host-specific plugins; SkillOpt full training stack as runtime; Tolaria as competing desktop app.

---

## 2. Project dossiers

### 2.1 Headroom — [chopratejas/headroom](https://github.com/chopratejas/headroom) / headroomlabs-ai

| | |
|--|--|
| **Problem** | Tool outputs, logs, JSON, RAG chunks burn tokens before they help. |
| **Technique** | Content-aware compression layer (library / proxy / MCP); claims ~60–95% on JSON, ~15–20% on coding agent traces; **local-first, reversible**. |
| **Port to Kyrei** | **P0–P1:** After tool success, compress by mime/shape (JSON key prune, log tail+errors, stacktrace keep, huge file → outline+hash). Store full blob under `.kyrei/tool-blobs/`; model sees stub + path. |
| **Skip** | Becoming a remote SaaS proxy; opaque middleman rewrite of user intent. |
| **Fits** | Existing CCR / `maxToolOutput` / summary stage. |

### 2.2 SkillOpt — [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt)

| | |
|--|--|
| **Problem** | Hand-written skills plateau; need reproducible improvement without fine-tuning weights. |
| **Technique** | Skill doc = trainable state; rollout → reflect → edit → **held-out validation gate** → `best_skill.md`; Sleep = offline nightly harvest. |
| **Port to Kyrei** | **P2:** Offline “skill sleep” job: from successful/failed sessions propose skill diffs; **proposal-first** (same as memory curator); never auto-apply_all. |
| **Skip** | Online silent skill rewrite every turn; heavy Python training in the hot path. |
| **Fits** | Skills store + curator + gbrain-style memory discipline. |

### 2.3 Claude Code Harness — [Chachamaru127/claude-code-harness](https://github.com/Chachamaru127/claude-code-harness)

| | |
|--|--|
| **Problem** | Raw agents drift: plan in chat, tests optional, review late. |
| **Technique** | **Spec → Plan → Work → Review → Release** loop; skills as verbs; config-driven workflows; evidence for ship. |
| **Port to Kyrei** | **P0–P1:** Map to modes + pipeline: plan artifact on disk; work only after plan; polish = review; optional release checklist (tests green). |
| **Skip** | Host-specific plugin forests; Claude-only identity. |
| **Fits** | coding-mode + pipeline stages + harness-contracts. |

### 2.4 ECC — [affaan-m/ECC](https://github.com/affaan-m/ECC)

| | |
|--|--|
| **Problem** | “Everything Claude Code” — skills, instincts, memory, security, research-first across many hosts. |
| **Technique** | Huge skill/rule/command catalog; research-first; security guides; multi-host shims. |
| **Port to Kyrei** | **P1 selectively:** security checklists as **opt-in skills**; research-first for deepreep; **not** import whole tree. |
| **Skip** | Shipping 1000 skills OOB; Claude-centric monolog. |
| **Fits** | Progressive skills; deepreep mode. |

### 2.5 Karpathy skills — [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)

| | |
|--|--|
| **Problem** | Models assume, overbuild, edit orthogonally, skip verification. |
| **Technique** | Four principles: **Think Before Coding**, **Simplicity First**, **Surgical Changes**, **Goal-Driven Execution** (tests as success criteria). |
| **Port to Kyrei** | **P0:** Fold into `harness-contracts` / system prompt (provider-agnostic wording). Eval: “diff only requested surface”. |
| **Skip** | Branding as Claude-only CLAUDE.md. |
| **Fits** | Portable harness already in flight. |

### 2.6 Tolaria — [refactoringhq/tolaria](https://github.com/refactoringhq/tolaria)

| | |
|--|--|
| **Problem** | Manage large markdown knowledge bases for humans + AI context. |
| **Technique** | Desktop vault, search, MCP server for agents. |
| **Port to Kyrei** | **P2:** Optional “vault root” in project memory (index + search); MCP if user already has Tolaria — integrate, don’t replace. |
| **Skip** | Building a second note-taking product inside Kyrei. |
| **Fits** | Memory search / LTM / workspace context. |

### 2.7 curl.md — [wevm/curl.md](https://github.com/wevm/curl.md) · [docs](https://curl.md/docs)

| | |
|--|--|
| **Problem** | Raw HTML wastes tokens for agents. |
| **Technique** | URL → **agent-optimized markdown**; CLI/SDK/plugin; “supercharge context”. |
| **Port to Kyrei** | **P1:** Upgrade `web_fetch` pipeline: denser markdown, strip chrome, hard maxChars, optional external `curl.md` client as opt-in backend. |
| **Skip** | Hard dependency on cloud curl.md for private/intranet URLs. |
| **Fits** | Existing web tools + browser.ts sanitizer. |

### 2.8 Supergoal — [robzilla1738/supergoal](https://github.com/robzilla1738/supergoal)

| | |
|--|--|
| **Problem** | Plan once, babysit every step; failures thrash. |
| **Technique** | Recon → adaptive phases on disk (`ROADMAP`/`STATE`/`phase-N`) → one human approve → autonomous loop with **3-strike** (retry → fix-spec → handoff) → **final audit** + cleanliness grep vs baseline → memory writeback. |
| **Port to Kyrei** | **P0–P1:** `.kyrei/run/<id>/` phase artifacts; `/goal` already adjacent; strengthen phase VERIFY + final audit; map 3-strike to self-heal FSM. |
| **Skip** | Claude/Codex plugin marketplace only; force-paste UX if we can native-run. |
| **Fits** | plan mode, pipeline, goal verify, heal handoff, LTM. |

---

## 3. Unified Kyrei program (full program, ordered)

### Wave A — Quality loop (like a clock)  ·  **shipped 2026-07-17**

| ID | Work | Sources | Status |
|----|------|---------|--------|
| A1 | **Karpathy principles** in harness contracts (think / simple / surgical / goal-verify) | Karpathy | ✅ `HARNESS_KARPATHY` + prompt **1.25.0** |
| A2 | **On-disk run kit** `.kyrei/run/<id>/` ROADMAP · STATE · phase-N (supergoal-shaped, Kyrei paths) | Supergoal, CCH | ✅ `run-kit.ts` + `run_*` planning tools |
| A3 | **Phase verify + 3-strike** mapped to existing self-heal / heal_handoff | Supergoal, Hermes | ✅ markers + `healStrike` / handoff text |
| A4 | **Final audit** before “done”: re-run tests, checklist, cleanliness | Supergoal, CCH | ✅ `evaluateFinalAudit` + `run_final_audit` tool |

### Wave B — Tokens & reuse  ·  **shipped 2026-07-17**

| ID | Work | Sources | Status |
|----|------|---------|--------|
| B1 | **Tool-output compressors** (JSON/log/diff/file outline) + reversible CCR | Headroom | ✅ `tool-compress.ts` + prune/live clip |
| B2 | **Prompt-cache packing** stable prefix + Anthropic breakpoints | Audit P2 | ✅ `buildSystemPromptParts` + `packSystemForCache` |
| B3 | **Cheap/strong routing defaults** worker=cheap, plan/build=strong | Harness class | ✅ Settings copy + `ROLE_ROUTING_DEFAULTS` |
| B4 | **Read-memo** path@hash: skip full re-read | Headroom-adjacent | ✅ turn-scoped `createReadMemo` |
| B5 | **Web densify** (curl.md patterns) | curl.md | ✅ `densifyWebMarkdown` + lower default cap |

### Wave C — Skills & knowledge  ·  **shipped 2026-07-17**

| ID | Work | Sources | Status |
|----|------|---------|--------|
| C1 | **Skill sleep (proposal-only)** offline from trajectories | SkillOpt | ✅ `skills-sleep.js` + Settings + `/api/skills/sleep` |
| C2 | **Security/research skill packs** curated subset | ECC | ✅ `core/skill-packs/{security,research}` opt-in roots |
| C3 | **Vault index hook** for external markdown KBs | Tolaria | ✅ `memory.vault` + indexer + `memory_search` |

### Wave D — Product polish (already WIP)

Gate green, ship governance/capacity/experimental already in tree; do not block Wave A on experimental auth.

---

## 4. What “works like clockwork” means for Kyrei

```text
User goal
  → Mode (plan hard-gate)
  → Stable system prefix (cacheable) + progressive skills
  → Recon (cheap model) → ROADMAP on disk
  → Human approve (once) when risk high
  → Phase loop: read spec → tools (compressed) → VERIFY
       ↓ fail: 1 retry · 2 fix-spec · 3 handoff
  → Final audit (tests + checklist + cleanliness)
  → Optional memory/skill proposal (never silent apply)
  → Ledger: tokens/$ / phase
```

Success metrics (track in ledger + evals):

- tokens/turn (p50/p90), tool_chars/turn  
- % turns ending with tests green when build mode  
- % tasks needing human re-prompt mid-run (should drop)  
- surgical-diff score (changed lines outside request)  

---

## 5. Explicit non-goals

- Clone ECC/Claude-Code-Harness as a plugin mega-repo  
- Silent SkillOpt training on every chat  
- Replace local web_fetch with only third-party cloud markdown  
- Compete with Tolaria as a PKM product  

---

## 6. Recommended next implementation slice

**Start Wave A1 + A2 + B3** (prompt quality + plan-on-disk + model split) — highest quality-per-week without new native deps.

Then **B1 + B2** for measurable $ savings.

SkillOpt / Tolaria / ECC packs only after the clock loop is boringly reliable.
