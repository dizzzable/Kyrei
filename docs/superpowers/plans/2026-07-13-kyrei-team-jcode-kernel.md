# Kyrei Team mode and jcode-plan kernel

## Goal

Add a backward-compatible Team mode in which the session model acts as orchestrator and can route a dependency graph of evidence-bearing tasks to an unlimited configurable roster of provider/model roles. The existing Single mode remains unchanged.

## Architecture

### Public configuration

Add versioned orchestration profiles outside provider secrets. A profile contains a stable id/name, workflow, arbitrary roles, provider-scoped model references, skill ids, capability policy, and run limits. Missing configuration migrates to `single` and never starts a team automatically.

### Runtime boundary

The gateway resolves every role's public model reference into a private `RuntimeProviderTarget`. The engine receives only the selected runtime team; the renderer never receives credentials. The current AI SDK model loop remains the first kernel adapter. jcode-plan semantics are isolated behind a task-graph port.

### Team scheduler

One root scheduler owns the dependency graph, global parallelism, task/agent count, abort tree, and append-only report ledger. Nested helpers draw from the same limits so recursion cannot multiply concurrency. The initial slice is single-writer: worker roles are read/search/verify only, while the orchestrator remains the acting writer.

### Shared knowledge

Each completed node produces a typed artifact with summary, evidence, validation, uncertainty, unchecked work, provenance, and confidence. Downstream nodes see only dependency artifacts, not private chain-of-thought. Canonical memory writes remain outside workers.

## Implementation sequence

1. Add normalized orchestration profile contracts and migration tests.
2. Add task graph validation/scheduling, budgets, artifacts, and cancellation tests.
3. Add a configurable team delegation tool using provider/model-specific role runners, selected skills, project context, and one bounded nested helper level.
4. Resolve runtime teams in the gateway without exposing secrets.
5. Add Team settings under Models: enable/profile, arbitrary roles, provider/model, role description, skills, and limits; localize EN/RU.
6. Surface tree metadata in existing subagent events and Agents panel without breaking flat legacy events.
7. Add durable JSONL run storage and deep jcode-plan sidecar after the Light runtime contract is proven.

## Non-goals for the first slice

- No parallel workspace writers until approvals and worktree isolation exist.
- No free-form hidden-reasoning chat between workers.
- No embedded OpenViking code.
- No replacement of Kyrei gateway/provider/credential/memory subsystems.
- No full jcode server/TUI runtime.

## Compatibility

- `modelAssignments.worker` and `delegate_read` remain valid.
- Team disabled or no active profile produces the current `runKyreiChat` behavior.
- Session provider/model remains the visible orchestrator.
- Old config files normalize without a mode change.
