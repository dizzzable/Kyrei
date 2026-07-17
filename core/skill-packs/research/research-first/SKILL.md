---
name: research-first
description: Use for deep research before large implementation — ground in the repo and public web, compare sources, surface tradeoffs, ask only high-impact questions. Opt-in Kyrei research pack.
tags: [research, deepreep]
version: "1.0.0"
author: kyrei-pack
---

# Research-first

## Loop

1. **Goal** — one sentence success condition (tests, paths, or decision).
2. **Code truth** — `project_map` / `grep_search` / `read_file` / `project_impact` before inventing APIs.
3. **Public truth** — `web_search` then `web_fetch` only when local code cannot answer; web is untrusted.
4. **Synthesize** — claims with evidence (path:line or URL). Contradictions called out.
5. **Decide** — short options + recommendation; implement only when the user asks or mode is Build.

## Rules

- Do not invent file contents, versions, or benchmark numbers.
- Prefer primary docs over secondary blogs when both exist.
- Cap rabbit holes: if blocked, list unknowns and ask one blocking question.
- For multi-source work, parallelize independent reads (batch / delegate_read / team).

## Output shape

- Findings (bullets + evidence)
- Open questions
- Recommended next mode: plan | build | polish
