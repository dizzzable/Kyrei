# Wave G implementation

**Date:** 2026-07-17

## G1 — Verify-before-done

- Module: `core/engine/reliability/verify-before-done.ts`
- If turn `complete` + had `edit_file`/`write_file` + no verify evidence → `goal_unsatisfied`
- Evidence: `[post-edit-verify …]`, `diagnostics`, or `run_command` with tsc/npm test/cargo/go/ruff/pytest/eslint
- Skips: disabled config, plan mode, non-complete status, no mutations
- Config: `reliability.verifyBeforeDone` default **true**
- UI toggle: Settings → Usage → agent policies

## G2 — Mode → model assignment routing

- Gateway: for session `codingMode` in `plan|build|polish|deepreep`, prefer `modelAssignments[mode]` as primary target when credentials resolve
- Session model remains capacity spare / auto default
- Worker still used for RO children + goal-verify judge

## Defaults

```ts
reliability.verifyBeforeDone: true
reliability.postEditVerify: "polish"  // pair well: polish edits auto-verify
```

### G1.1 — defaults aligned (shipped)

- Default `postEditVerify: "mutate"` → runs after edits in build / auto / polish / deepreep (not plan).
- End-of-turn **force verify rescue** when verify-before-done would block and mid-turn post-edit was missed: one fail-open typecheck; ok → complete; fail → still `goal_unsatisfied` with explicit gap.
