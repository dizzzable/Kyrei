# Kyrei Team mode test specification

## Configuration and secrets

- Legacy v2 config migrates with Team disabled.
- Profiles accept arbitrary role ids/names/descriptions and bounded limits.
- Every role model reference must resolve to an enabled, credential-ready provider/model before activation.
- Removing/disabling a provider reconciles affected profiles without exposing or moving credentials.
- Public config, events, reports, and persisted ledgers never contain API keys or private credential fields.

## Graph and scheduler

- Missing dependencies, duplicate task ids, self-dependencies, and cycles are rejected before any model call.
- Independent tasks run up to one root `maxParallel`; dependencies run only after all prerequisites complete.
- A failed prerequisite blocks dependants and is visible to the orchestrator.
- Results remain deterministic in task declaration order even when completion order differs.
- Root abort stops running children and prevents queued descendants from starting.
- Limits for depth, tasks, agents, steps, time, and nested children cannot be exceeded under concurrent calls.

## Roles, tools, skills, and memory

- Each role uses its own provider/model without leaking another provider's headers or credentials.
- Role instructions and only assigned enabled skill ids enter its isolated prompt.
- Worker capability selection is deny-by-default and never exceeds global permission policy.
- Initial Team workers cannot write workspace files, run terminal commands, approve, message, or update canonical memory.
- Nested helpers inherit a strict subset and cannot nest past the profile depth.
- Project AGENTS/steering/memory context is available as untrusted context to every role.

## Evidence and events

- Task artifacts include producer role/provider/model, evidence/validation, uncertainty, unchecked work, and confidence.
- Downstream tasks receive accepted dependency artifacts but not private transcripts.
- Events contain run/task/role, correct parent/depth, provider/model, usage, and exactly one terminal state.
- Existing legacy `subagent.*` consumers continue to work.

## UI and localization

- Team mode/profile/role controls have EN and RU strings with no user-facing hardcoded copy.
- Roles can be added and removed without a fixed role list.
- Provider/model selectors show only configured enabled providers and their models.
- Saving is atomic and error state does not replace the last valid profile.

## Regression gate

- engine and renderer typechecks
- engine bundle
- JS syntax check
- i18n catalog check
- full Vitest suite
- renderer production build
- desktop smoke: Single mode and Team settings persistence
