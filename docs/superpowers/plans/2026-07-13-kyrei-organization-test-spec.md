# Kyrei Organization Control Plane — test specification

Date: 2026-07-13

## Configuration

- Missing pipeline config migrates to version 1 with no definitions.
- Existing Team profiles remain byte-equivalent after pipeline migration.
- Unknown fields and credentials are discarded by tolerant normalization.
- Duplicate IDs, dangling Team profile references, missing stage dependencies and cycles are rejected.
- An action stage without a preceding approval is rejected.
- A truth gate cannot verify a workspace action it does not depend on.
- Retry targets and assistance edges must exist and remain within configured bounds.
- Definitions with invalid provider/profile references are disabled rather than silently retargeted.

## State machine

- Only documented run and stage transitions are accepted.
- Terminal states are immutable.
- Pause, budget pause, approval wait, blocked and interrupted remain distinguishable.
- Retry counts cannot exceed the mission repair budget.
- An interrupted read-only stage may resume explicitly.
- An uncertain write stage cannot resume until a deterministic resolution is recorded.

## Budget ledger

- Reservations are atomic under concurrent calls.
- A call is rejected before provider dispatch when any hard limit would be exceeded.
- Actual usage reconciles and releases unused reservation.
- Missing usage consumes the full reserved ceiling and increments `unmeteredCalls`.
- Tokens, calls, cost and wall-time hard stops are independent.
- A quality gain can never offset a safety or secret-leak failure.

## Evidence and truth gates

- `reported` evidence alone cannot prove tests, builds, file state or applied changes.
- Test receipts include command, exit code, cwd, output digest and workspace digest.
- File/test evidence with a stale workspace digest is rejected.
- Verification must reference the exact applied change digest.
- Missing mandatory checks fail the gate.
- Contradictory evidence yields `needs_more_evidence`, never averaged confidence.
- Secret-looking payloads and exact configured credentials are redacted before persistence and API output.

## Durable missions

- Snapshot writes are atomic and serialized per mission.
- A truncated trailing journal row does not corrupt earlier events.
- Definition revision, workspace baseline and attached session IDs survive restart.
- Session attachment is idempotent.
- Recovery marks active read stages interrupted and active write stages uncertain.
- Runtime credentials and custom credential headers never enter snapshots or journal events.
- Pause/resume/cancel/approval operations are audited and reject illegal transitions.

## Workspace lease

- Two missions cannot acquire the same normalized workspace key.
- The lease owner can renew and release; another owner cannot.
- Expired/stale leases can be recovered without deleting an active owner's lease.
- Write retry requires explicit postcondition resolution after a crash.

## Gateway integration

- All pipeline and mission endpoints require the per-launch gateway token.
- Pipeline PUT is strict and atomic; a rejected update leaves prior config untouched.
- Creating a mission pins the selected definition revision and current workspace baseline.
- List/get responses are public and redacted.
- Attach-session does not create a second mission.
- Resume fails closed when profiles/providers/skills, workspace baseline or sandbox fingerprint no longer match.
- Restart recovery is visible through mission status and events.

## Future scheduler integration

- Research -> Plan -> Approval -> Execute -> Verify succeeds end to end.
- Verification failure enters a bounded Fix -> Verify loop.
- Executor assistance can invoke only allowlisted research departments.
- Budget exhaustion prevents the next provider request.
- The main orchestrator receives compact artifacts, not complete internal transcripts.
- Department disagreement is surfaced with evidence instead of resolved by vote.
- Action Executor is unavailable when strict-required sandboxing cannot be enforced.

## Improvement pipeline

- Train/selection/test families are disjoint.
- One run changes only one immutable skill candidate.
- Full rewrite and ungated slow updates are rejected.
- Static, secret, capability, deterministic and safety gates are hard failures.
- Candidate adoption is explicit; rollback atomically restores the previous pointer.
- Cross-session experience collection is opt-in, structured and redacted.
- The optimizer never receives production credentials or the hidden test vault.
