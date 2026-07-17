# Agent optimization landscape (2026) → Kyrei

**Date:** 2026-07-17  
**Method:** Parallel web research (academic papers, production harnesses, context engineering, reliability patterns) **plus** code-backed Kyrei inventory.  
**Rule:** Port **patterns**, not product monologs / vendor lock / silent self-mutation.

This supersedes ad-hoc chat summaries for Wave D planning. Related:

- [`external-agent-systems-study.md`](./external-agent-systems-study.md) — Headroom, SkillOpt, ECC, Karpathy, Tolaria, curl.md  
- [`hermes-parity-matrix.md`](./hermes-parity-matrix.md) — Hermes capability matrix  
- [`agent-audit-and-parity.md`](./agent-audit-and-parity.md) — reliability gaps  

---

## 1. Executive synthesis

Five independent research threads converge on one thesis:

> **Agent quality = model × harness.**  
> For long coding sessions the harness (tools, context policy, verification, control) usually moves the needle more than swapping models.

| Lever | Research consensus | Kyrei today | Gap size |
|-------|--------------------|-------------|----------|
| **Observation pruning** | Task-aware prune of tool/file dumps (SWE-Pruner, Squeez, CoACT); 23–90% token cuts without hurt | Shape compress + CCR + caps | **Medium** — missing *goal-conditioned* skim on read |
| **Trajectory hygiene** | Observation masking often > full LLM summarize; pin goals at end | Two-stage compact + middle summary | **Small** — measure + default mask window |
| **Context rot** | Non-uniform degrade as history grows (Chroma); lost-in-middle | Compaction + dual-trigger | **Small** — re-pin state at end of prompt |
| **Scaffold / ACI** | Windowed read, linted edit, structured search beat free-form | Tools + jail + project graph | **Small–medium** — richer ACI (outline-first read) |
| **Plan → build → verify** | Dual-agent / plan-before-edit; tests as “done” | Modes + plan hard-gate + final audit | **Small** — force plan on long auto; goal verifier default |
| **Subagent isolation** | Sidechains / worktrees; children must not bloat parent | Read-only children + team | **Medium** — git worktree deferred |
| **Repo map** | Tree-sitter + importance (~1k tokens) before embeddings (Aider) | Import graph intel | **Medium** — symbol/AST map budget |
| **Metrics** | Keep Rate, tokens/round, false-done, tool-error taxonomy | Usage ledger / budgets | **Large** — harness quality dashboard |
| **Skills** | Progressive disclosure; offline SkillOpt proposals | Progressive + sleep proposals | **Small** — catalog hygiene |
| **Sandbox / cloud** | Docker/default-deny net for autonomous factory | Local jail | **Reject** as core; optional later |

**Do not chase:** free-form multi-agent debate, MoA, dumping whole repos into 200k context, aggressive LLMLingua on code, silent every-turn skill rewrite, becoming Cursor/Claude-only.

---

## 2. Academic & industrial research (2024–2026)

### 2.1 Context compression (highest product ROI)

| Paper / system | Year | Technique | Metrics (reported) | Portable? |
|----------------|------|-----------|--------------------|-----------|
| [SWE-Pruner](https://arxiv.org/abs/2601.16746) | 2026 | Goal hint + line-level neural skim (0.6B) on raw reads | −23–54% tokens on agent tasks; success flat/↑; up to 14.8× single-turn | **Yes** (heuristic first) |
| [Squeez](https://arxiv.org/abs/2604.04979) | 2026 | Task-conditioned tool-output → smallest verbatim evidence | ~92% tokens removed; 0.86 recall / 0.80 F1 | **Yes** |
| [CoACT](https://arxiv.org/abs/2607.02911) | 2026 | Next-Action Preservation: compress must preserve next action | ~−33% tokens, solve rate ~held | **Partial** (criterion yes) |
| [LongCodeZip](https://arxiv.org/abs/2510.00446) | 2025 | Structure-aware 2-stage code compress (training-free) | ~5.6× without degrade on code tasks | **Yes** |
| LLMLingua family | 2023–24 | PPL / token-class prune | Huge compress on prose; **hurts** coding agents when aggressive | **Avoid** as primary for code |
| [ACON](https://arxiv.org/abs/2510.00615) | 2025–26 | Optimize *compression guidelines* via contrast trajectories | −26–54% peak tokens; helps small models | **Yes** (prompt process) |
| [AgentFold](https://arxiv.org/abs/2510.24699) / [Context-Folding](https://arxiv.org/abs/2510.11967) | 2025 | Branch/fold workspace; fold completed subtasks | ~10× smaller active context vs pure ReAct | **Partial** (protocol yes; RL no) |

**Empirical fact:** Mini-SWE trajectories show **~70%+ of tokens** spent on **read/explore**, not edit/execute — pruning observations is the main cost lever.

### 2.2 Memory, planning, multi-agent

| Work | Idea | Portable? |
|------|------|-----------|
| [HiAgent](https://arxiv.org/abs/2408.09559) | Subgoals as working-memory chunks; fold finished | **Yes** |
| Plan-and-Act (ICML 2025) | Separate planner vs executor | **Yes** |
| Mem0 / continuum memory surveys | Extract-store-retrieve across sessions | **Yes** (local store) |
| MetaGPT / AgentCoder / Augment multi-model | Role pipelines + review ensembles | **Yes** as roles+artifacts |
| SWE-agent / Agentless | ACI + localize→repair→validate | **Yes** |

**Finding:** Multi-agent helps via **specialization + verification**, not free-form debate. Extra agents without state hygiene amplify context rot.

### 2.3 Failure modes (design constraints)

1. **Context rot** (Chroma 2025) — performance degrades non-uniformly with length; NIAH overestimates robustness.  
2. **Lost-in-the-middle** — re-pin goals/constraints/open hypotheses at the **end** of context.  
3. **Over-exploration** — no localization budget → thrash files.  
4. **Benchmark illusion** — SWE-bench Verified can overstate real patch quality; prefer private/fresh tasks + differential tests.  
5. **Self-judge reward hacking** — same-context generator+judge; prefer external oracles (tests, linters, separate reviewer).

### 2.4 Top 10 research-backed patterns (implementation rank)

| # | Pri | Pattern |
|---|-----|---------|
| 1 | P0 | Prune tool observations to task evidence; archive full offline (CCR) |
| 2 | P0 | Hard budget + clear old tool bodies; re-pin goals at end |
| 3 | P0 | Localize → edit → test with stop criteria |
| 4 | P0 | ACI tools: windowed/outline read, structured search, linted edit |
| 5 | P1 | Subgoal/fold protocol (`active_goal`, fold summaries) |
| 6 | P1 | Task-aware code skim before full file dump |
| 7 | P1 | Selective retrieval: lexical first, embeddings only when needed |
| 8 | P1 | ACON-style compressor guidelines evolved offline |
| 9 | P2 | Optional local 0.6–2B observation pruner |
| 10 | P2 | Roles + artifacts multi-agent; cap agent count |

---

## 3. Production harness landscape

### 3.1 Definition

**Harness** = everything except the weights: tool loop, permissions, context policy, memory, sandboxes, hooks, subagents, verification, recovery.

Market split 2026:

| Class | Examples | Differentiator |
|-------|----------|----------------|
| Local interactive CLI | Claude Code, Gemini CLI, OpenCode | Pair + long session ritual |
| Async PR factory | Codex cloud | Sandbox VM → PR |
| IDE-deep index | Cursor, Windsurf | Semantic index + rules |
| OSS portable loops | Aider, OpenHands, Mini-SWE | Model-agnostic / research |

### 3.2 Steal matrix (portable only)

| Pattern | Source | Steal for Kyrei? |
|---------|--------|------------------|
| Progress file + JSON feature list (`passes` after real tests) | Anthropic long-running harness | **Yes** — extend run-kit |
| Session boot ritual (cwd → git → progress → smoke) | Claude Code | **Yes** |
| Compaction **+** tool-result offload **+** subagent sidechains | Claude / Anthropic cookbook | **Yes** (partially have) |
| Repo map ~1k tokens (tree-sitter + rank) | Aider | **Yes** P1 |
| Architect/editor dual model | Aider / OpenCode | **Yes** (role models exist) |
| Model-specific edit tool shapes | Cursor | **Partial** later |
| Dynamic context over giant dumps | Cursor | **Yes** |
| Keep Rate / tool-error taxonomy | Cursor | **Yes** as metrics |
| Permission ladder + default-deny net | Codex | Soft local; no cloud core |
| Docker sandbox default | OpenHands | Optional later; not core |
| Force plan (RO) then build | OpenCode / Cline | **Yes** for long auto |
| Portable skills (superpowers / agentic-stack) | Community | **Yes** packs already |
| Trajectory logging | SWE-agent | **Yes** for evals |

### 3.3 Explicit non-goals for Kyrei product identity

- IDE clone (Cursor surface)  
- Cloud-only agent identity (Codex factory as core)  
- Anthropic-only memory/API coupling  
- YOLO / skip-all-permissions default  

---

## 4. Context engineering playbook (actionable)

### 4.1 Four pillars

**Write · Select · Compress · Isolate** (LangChain framing; Anthropic/Cursor practice).

Orthogonal axes:

| Axis | Shrinks | Default method |
|------|---------|----------------|
| Observation | Tool results this turn | Caps, densify, goal skim, CCR stubs |
| Trajectory | Multi-turn history | Mask old observations; compact near limit; NOTES on disk |

JetBrains-class finding: **observation masking** often beats full LLM trajectory summarization (~50%+ cheaper, equal/better solve).

### 4.2 When compression helps vs hurts

| Helps | Hurts |
|-------|-------|
| Logs, HTML chrome, fat JSON, repeated search hits | Exact error lines, imports, applyable diffs |
| Re-fetchable via path/hash | Only copy lived in summarized middle |
| Browse/outline mode | Line-level edit without re-read |

### 4.3 Default stack to ship (any TS agent)

1. Thin system + skill **catalog** (progressive load).  
2. Every tool result: densify → cap → **stash CCR** → model sees stub/summary.  
3. Mask tool **bodies** older than last K turns (keep calls/args).  
4. Write NOTES/plan on disk; re-inject on compact.  
5. Isolate heavy explore in read-only child.  
6. Stable tools/system prefix for cache; volatile at tail.  
7. Compact only near limit; needle-probe after compact.  

### 4.4 Metrics to log

Per session/turn: `input_tokens`, cache read/write, per-tool `bytes_raw`/`bytes_shown`, stub retrieves, mask/compact events, rounds, unique files read, pass@task / user accept, false-done rate.

---

## 5. Planning, multi-agent, reliability

### 5.1 Ideal quality loop (state machine)

```
IDLE
  → INTAKE (goal, constraints, repo facts)
  → SPECIFY (outcomes, non-goals, verify plan)     [gate if medium+]
  → PLAN (read-only → plan.md + tasks)             [gate: accept]
  → DISPATCH (task; optional worktree)
  → BUILD (write-capable; scoped tools)
  → VERIFY (tests/types/lint + optional review agent)
       ├ pass → COMMIT → next task | AUDIT
       └ fail → HEAL (≤3) → else ESCALATE
  → AUDIT (diff vs spec; parallel review optional)
  → LEARN (proposal-only skill/memory notes)
  → MERGE_OR_PR [hard gate if push/main]
  → DONE | IDLE
```

**Invariants:** planner ≠ writer tools; maker ≠ sole judge; “done” = external checks; cost/time/idle stops.

### 5.2 Approval tiers

| Tier | Examples | Default |
|------|----------|---------|
| Auto | read, search, test, lint | allow |
| Soft | write in workspace, local commit | policy |
| Hard | push, secrets, destructive FS | human |
| Block | out-of-jail, known-dangerous | deny |

Experienced users move from per-action HITL to **monitor + interrupt** on irreversible actions only.

### 5.3 Skills

- Progressive disclosure (name → full SKILL → deep refs).  
- Superpowers-style workflows (TDD, review gates) as packs.  
- SkillOpt **offline** proposal edits — never silent apply (Kyrei already aligned).  

### 5.4 Gaps most teams miss (and Kyrei partially closed)

1. Executable success criteria  
2. Maker/checker separation  
3. Bounded heal + escalate  
4. Risk-tiered policy (not micromanage / not allow-all)  
5. Isolation defaults (worktrees)  
6. Skills as product, not mega-rules  
7. Compound memory hygiene  
8. Review bandwidth  
9. Final audit vs spec  
10. Trust calibration / telemetry  

---

## 6. Kyrei inventory (code-backed, 2026-07-17)

### 6.1 Already strong

| Area | Evidence |
|------|----------|
| Two-stage compression + dual-trigger | `core/engine/context/compaction.ts`, `tokens.ts` |
| CCR reversible store | `core/engine/context/ccr.ts` |
| Shape-aware tool compress | `core/engine/context/tool-compress.ts` |
| Read-memo path@hash | `core/engine/context/read-memo.ts` |
| Cache packing + Anthropic ephemeral | `core/engine/prompt/cache-packing.ts` |
| Karpathy harness + run protocol | `core/engine/prompt/harness-contracts.ts` |
| Modes + plan hard-gate | `core/engine/coding-mode.ts`, `orchestrator/run.ts` |
| Run kit on disk | `core/engine/orchestration/run-kit.ts` |
| 3-strike heal + final audit | `reliability/self-heal.ts`, `final-audit.ts` |
| Single-writer + RO children + reviewer | `orchestration/delegate.ts`, `read-child.ts`, `reviewer.ts` |
| Project import graph | `intel/project-index.ts` |
| Skill sleep proposals + packs | `skills-sleep`, `skill-packs/` |
| Pipeline truth-gate | `pipeline/truth-gate.ts` |

### 6.2 Partial

- Aux model role map (compress/title/vision)  
- Goal verifier **not** default end-of-turn  
- Intent pre-router  
- Symbol/AST repo map (import graph only)  
- Harness quality metrics dashboard  
- Mid-turn mode switch edge cases  
- Git worktree isolation  
- Always-on post-edit hooks (lint/test)  

### 6.3 Explicit rejects

Remote/cloud gateway · Computer Use product · silent MEMORY/SKILL rewrite · MoA · ECC mega-dump · YOLO default · parallel writers · vector RAG-by-default · Tolaria clone · full PTY/SSH core as v1  

---

## 7. Recommended Kyrei Wave D (from full landscape)

Ordered by impact × fit to existing architecture:

### D0 — Measure (1 PR)

- Log per-turn: tokens in/out, cache hits (if API), tool raw vs shown bytes, rounds, files read, verify outcomes.  
- Minimal “agent efficiency” section under Settings → Usage or About diagnostics.  
- Without this, every later PR is guesswork.

### D1 — Goal-aware observation prune (1–2 PRs)

- Optional `focus` / task-query on `read_file` / search / large shell.  
- Heuristic skim: keep imports + matched symbols + surrounding N lines; outline for huge files; full via CCR.  
- Aligns with SWE-Pruner / Squeez / Headroom without shipping a 0.6B model first.

### D2 — Trajectory defaults (1 PR)

- Default observation masking for tool bodies older than last K turns.  
- Re-pin: active goal, constraints, open hypotheses, failed approaches at **end** of system/volatile block.  

### D3 — Long-task discipline (1 PR)

- Auto mode: if goal complexity heuristic or user long form → force plan artifact before write tools.  
- Opt-in goal verifier as default for polish / end of run-kit phase.  

### D4 — Repo map v2 (1–2 PRs)

- Tree-sitter (or lightweight TS/JS/Python symbol scan) → top symbols budgeted ~1–2k tokens into project context.  
- Keep grep-first; embeddings remain opt-in.

### D5 — Isolation & cost split (later)

- Optional git worktree for write children.  
- Enforce plan/build/polish model assignments end-to-end (cheap explore / strong build).  

### Out of Wave D

- Trained local pruner weights (optional experiment)  
- Cloud sandbox product  
- MoA / peer dual-writers  

---

## 8. Ideal Kyrei agent (target picture)

```text
User goal
  → Intake + complexity router (short fix vs long feature)
  → Plan on disk if long (RO tools) + accept
  → Build loop:
       localize (map + rg) → goal-skim reads → CCR full store
       surgical edit → lint/test oracle
       3-strike heal with external stderr
  → VERIFY markers · final audit (no empty green)
  → Optional reviewer child on diff
  → Proposal-only learn (skill sleep / memory curator)
  → Metrics: tokens, rounds, false-done, re-read rate
```

**North star metrics:** tokens / successful task · rounds / task · % false “done” · tool bytes waste · user re-prompt rate · cache hit rate.

---

## 9. Source index (primary)

### Papers
- SWE-Pruner https://arxiv.org/abs/2601.16746  
- Squeez https://arxiv.org/abs/2604.04979  
- CoACT https://arxiv.org/abs/2607.02911  
- LongCodeZip https://arxiv.org/abs/2510.00446  
- ACON https://arxiv.org/abs/2510.00615  
- AgentFold https://arxiv.org/abs/2510.24699  
- Context-Folding https://arxiv.org/abs/2510.11967  
- HiAgent https://arxiv.org/abs/2408.09559  
- SWE-agent https://arxiv.org/abs/2405.15793  
- CodeAct https://arxiv.org/abs/2402.01030  
- SWE-Bench Pro https://arxiv.org/abs/2509.16941  

### Industry
- Anthropic: effective context engineering; long-running agent harnesses  
- Cursor: continually improving agent harness; Keep Rate  
- Addy Osmani: agent harness engineering; 2026 coding workflow  
- Chroma: Context Rot  
- Aider repo map docs  
- OpenHands / Mini-SWE / Codex sandbox engineering posts  
- awesome-harness-engineering, agentic-stack, superpowers  

---

## 10. Next step

Write **design doc Wave D** from §7 with PR DAG, acceptance tests, and non-goals — only after product owner prioritizes D0–D5 order.
