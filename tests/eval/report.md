# Kyrei Engine — Eval Report

Deterministic evaluation of the Kyrei v2 engine (Requirements §12.5, §13). The
harness drives the **real** engine loop (`streamText` + tools + stream-bridge)
with a scripted `MockLanguageModelV4` in a temporary workspace, then checks a
machine oracle. No network, no flakiness — runs as part of `npm run gate`.

## What this measures, and what it does not

The model's decisions are **scripted**. So this suite measures the *harness* —
tool surface, patch application, the path jail, the project index, the stream
bridge — and not the model's judgement. That is worth measuring on its own
terms: with the model held fixed, harness choice has been measured to move
end-to-end pass rate by 27 percentage points.

It also means the suite is **deterministic**. A difference here is a real
difference. On model-in-the-loop benchmarks, single-run pass rates vary by 2–6
points even at temperature 0, which is larger than most changes anyone wants to
detect; none of that noise exists here.

What it therefore cannot tell you: whether the agent chose the right action.
That needs a live-model arm, which is a separate and much noisier instrument.

## Selection rule

**Every task exists because a real defect got through.** Each carries a
`rationale` naming that defect, and a test asserts the rationale is present —
tasks invented to look thorough measure nothing.

Public benchmarks are deliberately not used as the gate: an audit of 168 of them
found problems in over a quarter of tasks, and on SWE-bench a model identifies
the buggy file from the issue text alone 76% of the time versus 53% off
benchmark, so a score there is partly a memory test.

## Categories

| Category | What it guards |
| --- | --- |
| `edit` | A well-formed edit lands, byte-exactly, preserving CRLF and untouched lines |
| `reject` | A malformed, ambiguous or no-op edit is refused **and says so**, workspace unchanged |
| `safety` | Path jail: escapes are denied and the denial is reported |
| `intel` | The import graph the agent reasons about dependencies with — including the absence of phantom edges |
| `search` | Grep and windowed reads return the right region, asserted on the tool RESULT |
| `recover` | A rejected patch leaves the agent able to succeed on the next attempt |

## Tasks

| ID | Category | The defect it would have caught |
| --- | --- | --- |
| `edit-create-file` | edit | Baseline mutation reaches disk |
| `edit-point-edit` | edit | Context-anchored replacement, byte-exact |
| `edit-tolerates-whitespace-drift` | edit | Anchor tolerance (disabling it measured a 9× rise in editing errors) while writing back original bytes |
| `edit-preserves-crlf` | edit | An edit silently normalising line endings would rewrite every line it touched |
| `edit-multi-hunk` | edit | All hunks land, not just the first |
| `reject-ambiguous-context` | reject | Context matching twice → editing the wrong occurrence |
| `reject-context-not-found` | reject | A hallucinated context line must fail loudly |
| `reject-partial-multi-hunk-is-atomic` | reject | A half-applied patch is worse than a rejected one — the model believes it worked |
| `reject-noop-edit` | reject | A no-op usually means the model misread the file |
| `safety-refuse-parent-escape` | safety | Relative escape, **and** the refusal is reported |
| `safety-refuse-absolute-escape` | safety | The absolute form is the one that gets forgotten |
| `intel-nodenext-js-specifier` | intel | 794 of 796 `.js` specifiers unresolvable; `core/engine`, 269 files, had 4 edges |
| `intel-path-alias` | intel | 880 of 8 306 internal imports discarded, all in the renderer |
| `intel-jsonc-tsconfig` | intel | `tsconfig.json` is JSONC; a plain parse fails **silently** |
| `intel-no-phantom-edges` | intel | A resolver that invents edges is worse than one that misses them |
| `search-grep-finds-match` | search | Oracle reads the RESULT — an earlier version checked the seed file and hid a broken call |
| `search-read-window` | search | A wrong offset returns a region the model never saw and then edits against |
| `recover-after-rejected-edit` | recover | One bad guess becomes a fix rather than a dead end |

## Oracle discipline

Two rules the suite learned the hard way while being written:

1. **"Nothing happened" is not evidence a guard fired.** A refusal must be
   visible in the result the model reads. A tool that silently did nothing — or
   was never called — satisfies an "is the file unchanged?" check equally well.
2. **A denial is not an exception.** The tools return jail denials as ordinary
   results so the model can recover from them, which means the tool-error count
   stays at zero. Asserting on the error count asserts the wrong thing.

Both were live bugs in the first draft of this file, caught by inspecting tool
outputs rather than by the tests going red.

## Proving the suite has teeth

A passing suite proves nothing until it is shown to fail. The NodeNext
resolution fallback was removed and the suite re-run: `intel-nodenext-js-specifier`
went red and **every other task stayed green** — the catch is targeted, not a
blanket failure.

Repeat this whenever a task is added.

## Regression gate

`tests/eval/baseline.json` holds the committed baseline. `checkRegression`
fails the build on:

- a drop in overall pass rate,
- a drop in **any category's** pass rate,
- a category **disappearing** from the run (deleting tasks would otherwise be
  indistinguishable from passing them),
- **>20%** growth in median steps or tokens.

The live provider path is validated separately (nightly / manual smoke against a
real OpenAI-compatible endpoint).

_Deterministic artifact regenerated on each run to `tests/eval/out/report.json`._
