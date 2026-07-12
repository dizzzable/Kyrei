# Kyrei Engine — Eval Report

Deterministic evaluation of the Kyrei v2 engine (Requirements §12.5, §13). The
harness drives the **real** engine loop (`streamText` + tools + stream-bridge)
with a scripted `MockLanguageModelV2` in a temporary workspace, then checks a
machine oracle. No network, no flakiness — runs as part of `npm run gate`.

## Tasks

| ID | Scenario | Oracle |
| --- | --- | --- |
| E1-create-file | Model calls `write_file` to create a new file | file exists with expected content |
| E2-point-edit  | Model calls `edit_file` with a context-anchored patch | target line changed, rest intact |
| E6-refuse-jail | Model attempts to write outside the workspace | write rejected (jail), no escape |

## Latest results (v2)

| ID | edit_success | steps | tokens | tool_error_rate |
| --- | --- | --- | --- | --- |
| E1-create-file | ✓ | 2 | 60 | 0.00 |
| E2-point-edit  | ✓ | 2 | 60 | 0.00 |
| E6-refuse-jail | ✓ | 2 | 60 | 1.00 (expected — jailed write is rejected) |

**Aggregate:** passRate = 1.00 (Req 13.1: ≥ 0.95 ✓), median steps = 2, median tokens = 60.

## v1 vs v2 (release record)

| Metric | v1 (legacy) | v2 | Notes |
| --- | --- | --- | --- |
| passRate | 1.00 | 1.00 | parity on the deterministic set |
| median steps | 3 | 2 | v2 fewer steps (edit_file/batch, tighter prompt) |
| median tokens | 60 | 60 | comparable on this scripted set |

## Regression gate

`tests/eval/baseline.json` holds the committed baseline. `checkRegression`
fails the build on a pass-rate drop or a **>20%** growth in median steps or
tokens versus `v2`. The live provider path is validated separately (nightly /
manual smoke against a real OpenAI-compatible endpoint).

_Deterministic artifact regenerated on each run to `tests/eval/out/report.json`._
