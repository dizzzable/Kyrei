/**
 * The eval task set.
 *
 * Every task exists because a real defect got through. That is the whole
 * selection rule — tasks invented to look thorough measure nothing, and the
 * public benchmarks cannot substitute: an audit of 168 of them found problems
 * in over a quarter of tasks, and on SWE-bench a model identifies the buggy
 * file from the issue text alone 76% of the time versus 53% off-benchmark, so a
 * score there is partly a memory test.
 *
 * What this harness measures, precisely: the model's decisions are SCRIPTED, so
 * this is a test of the harness — tools, patch application, the path jail, the
 * stream bridge — not of the model's judgement. That is worth measuring on its
 * own terms: with the model held fixed, harness choice has been measured to
 * move end-to-end pass rate by 27 percentage points. It also means the suite is
 * deterministic, so a difference here is a real difference, not run-to-run
 * noise.
 *
 * `rationale` on each task names the defect. Keep it accurate; it is the only
 * thing that stops this file drifting into decoration.
 */

import type { EvalTask } from "./harness.js";
import { fileContains, fileEquals, fileExists, hasImportEdge, readProjectIndex } from "./harness.js";

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function toolCallStep(toolName: string, input: unknown, id = `c-${toolName}`): unknown[] {
  return [
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
  ];
}
function finalStep(text: string): unknown[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ];
}

const THREE_LINES = "line1\nline2\nline3\n";

/**
 * The patch was refused and said so.
 *
 * "The file is unchanged" alone is not evidence a guard fired — a tool that
 * silently did nothing satisfies it too, and so does a tool that was never
 * called. The rejection has to be visible in the result the model reads.
 */
function rejected(run: { toolErrors: number; toolOutputs: string[] }): boolean {
  return run.toolErrors > 0 && run.toolOutputs.some((out) => /Edit rejected \[[A-Z_]+\]/.test(out));
}

/**
 * The action was denied by the path jail and said so.
 *
 * A denial is NOT an exception here: the tools return it as an ordinary result
 * the model can read and recover from, so `toolErrors` stays at zero. Asserting
 * on the error count would therefore be asserting the wrong thing — as it was,
 * until this suite made the difference visible.
 */
function denied(run: { toolOutputs: string[] }): boolean {
  return run.toolOutputs.some((out) => /denied|outside the workspace/i.test(out));
}

export const EVAL_TASKS: EvalTask[] = [
  // ── Editing: a well-formed edit must land, byte-exactly ──────────────────
  {
    id: "edit-create-file",
    category: "edit",
    rationale: "Baseline: the simplest possible mutation must reach disk.",
    prompt: "Создай файл hello.txt с текстом 'привет'.",
    script: [toolCallStep("write_file", { path: "hello.txt", content: "привет" }), finalStep("Готово")],
    oracle: (ws) => fileContains(ws, "hello.txt", "привет"),
  },
  {
    id: "edit-point-edit",
    category: "edit",
    rationale: "Baseline: a context-anchored single-line replacement.",
    prompt: "Замени line2 на LINE2X в a.txt.",
    seed: { "a.txt": THREE_LINES },
    script: [
      toolCallStep("edit_file", { patch: "*** Update File: a.txt\n line1\n-line2\n+LINE2X\n line3\n" }),
      finalStep("Готово"),
    ],
    // Byte-exact: "contains LINE2X" also passes on a file the edit mangled
    // everywhere else, which is the failure mode worth catching.
    oracle: (ws) => fileEquals(ws, "a.txt", "line1\nLINE2X\nline3\n"),
  },
  {
    id: "edit-tolerates-whitespace-drift",
    category: "edit",
    rationale:
      "Models reproduce context lines without trailing whitespace. Anchor tolerance is deliberate — Aider measured a 9× rise in editing errors with flexible matching disabled — so it must keep working.",
    prompt: "Поменяй beta на BETA.",
    seed: { "drift.txt": "alpha   \nbeta\ngamma\n" },
    script: [
      toolCallStep("edit_file", { patch: "*** Update File: drift.txt\n alpha\n-beta\n+BETA\n gamma\n" }),
      finalStep("Готово"),
    ],
    // The file keeps its original trailing whitespace: tolerance is for
    // COMPARING, never for the bytes written back.
    oracle: (ws) => fileEquals(ws, "drift.txt", "alpha   \nBETA\ngamma\n"),
  },
  {
    id: "edit-preserves-crlf",
    category: "edit",
    rationale:
      "This repository is CRLF throughout. An edit that silently normalised line endings would rewrite every line of the file it touched.",
    prompt: "Замени two на TWO.",
    seed: { "crlf.txt": "one\r\ntwo\r\nthree\r\n" },
    script: [
      toolCallStep("edit_file", { patch: "*** Update File: crlf.txt\n one\n-two\n+TWO\n three\n" }),
      finalStep("Готово"),
    ],
    oracle: (ws) => fileEquals(ws, "crlf.txt", "one\r\nTWO\r\nthree\r\n"),
  },
  {
    id: "edit-multi-hunk",
    category: "edit",
    rationale: "Several hunks in one file must all land, not just the first.",
    prompt: "Поменяй первую и последнюю строки.",
    seed: { "multi.txt": "one\ntwo\nthree\nfour\nfive\n" },
    script: [
      toolCallStep("edit_file", {
        patch: "*** Update File: multi.txt\n one\n-two\n+TWO\n three\n@@\n four\n-five\n+FIVE\n",
      }),
      finalStep("Готово"),
    ],
    oracle: (ws) => fileEquals(ws, "multi.txt", "one\nTWO\nthree\nfour\nFIVE\n"),
  },

  // ── Rejection: a bad edit must be refused, and change nothing ────────────
  {
    id: "reject-ambiguous-context",
    category: "reject",
    rationale:
      "Context matching in two places is the classic silent corruption: applying it edits the wrong occurrence. Rejection must leave the file byte-identical.",
    prompt: "Замени dup на DUP.",
    seed: { "amb.txt": "x\ndup\ny\ndup\nz\n" },
    script: [toolCallStep("edit_file", { patch: "*** Update File: amb.txt\n-dup\n+DUP\n" }), finalStep("Не могу — неоднозначно")],
    oracle: async (ws, run) => rejected(run) && fileEquals(ws,"amb.txt", "x\ndup\ny\ndup\nz\n"),
  },
  {
    id: "reject-context-not-found",
    category: "reject",
    rationale: "A hallucinated context line must fail loudly rather than being pattern-matched onto something nearby.",
    prompt: "Замени несуществующую строку.",
    seed: { "nf.txt": "hello\nworld\n" },
    script: [toolCallStep("edit_file", { patch: "*** Update File: nf.txt\n-nonexistent\n+x\n" }), finalStep("Не нашёл контекст")],
    oracle: async (ws, run) => rejected(run) && fileEquals(ws,"nf.txt", "hello\nworld\n"),
  },
  {
    id: "reject-partial-multi-hunk-is-atomic",
    category: "reject",
    rationale:
      "The apply is all-or-nothing by design. If a later hunk fails, the earlier one must NOT be on disk — a half-applied patch is worse than a rejected one because the model believes it succeeded.",
    prompt: "Две правки, вторая невалидна.",
    seed: { "atomic.txt": "one\ntwo\nthree\n" },
    script: [
      toolCallStep("edit_file", {
        patch: "*** Update File: atomic.txt\n one\n-two\n+TWO\n three\n@@\n-nonexistent\n+x\n",
      }),
      finalStep("Отклонено"),
    ],
    oracle: async (ws, run) => rejected(run) && fileEquals(ws,"atomic.txt", "one\ntwo\nthree\n"),
  },
  {
    id: "reject-noop-edit",
    category: "reject",
    rationale:
      "An edit that changes nothing usually means the model misread the file. Reporting success would let it move on believing the work is done.",
    prompt: "Правка, ничего не меняющая.",
    seed: { "noop.txt": "same\n" },
    script: [toolCallStep("edit_file", { patch: "*** Update File: noop.txt\n same\n" }), finalStep("Нечего менять")],
    oracle: async (ws, run) => rejected(run) && fileEquals(ws,"noop.txt", "same\n"),
  },

  // ── Safety: refusal is the correct outcome ──────────────────────────────
  {
    id: "safety-refuse-parent-escape",
    category: "safety",
    rationale:
      "Path jail: a relative escape must not write outside the workspace, and the refusal must be REPORTED. The original version of this task asserted only that no file appeared — which a tool that silently did nothing would also satisfy.",
    prompt: "Запиши файл за пределами рабочей папки.",
    script: [toolCallStep("write_file", { path: "../evil.txt", content: "x" }), finalStep("Не могу выйти за папку")],
    oracle: async (ws, run) => denied(run) && !(await fileExists(ws, "../evil.txt")),
  },
  {
    id: "safety-refuse-absolute-escape",
    category: "safety",
    rationale:
      "The relative form is the obvious escape and the one people test. An absolute path is the one that gets forgotten.",
    prompt: "Запиши по абсолютному пути вне воркспейса.",
    script: [
      toolCallStep("write_file", { path: process.platform === "win32" ? "C:\\kyrei-eval-escape.txt" : "/tmp/kyrei-eval-escape.txt", content: "x" }),
      finalStep("Не могу"),
    ],
    oracle: async (ws, run) => denied(run) && !(await fileExists(ws, "escape.txt")),
  },

  // ── Project intelligence: what the agent reasons about dependencies with ─
  {
    id: "intel-nodenext-js-specifier",
    category: "intel",
    rationale:
      "TypeScript under NodeNext requires the EMITTED extension: `from './b.js'` while the file is `b.ts`. The resolver never tried stripping it — measured on this repository, 794 of 796 such specifiers were unresolvable and core/engine, its largest directory at 269 files, had four import edges in total.",
    prompt: "Построй индекс проекта.",
    seed: {
      "src/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
    },
    script: [toolCallStep("project_index", {}), finalStep("Индекс построен")],
    oracle: (ws) => hasImportEdge(ws, "src/a.ts", "src/b.ts"),
  },
  {
    id: "intel-path-alias",
    category: "intel",
    rationale:
      "Alias imports were discarded entirely because the extractor only accepted specifiers starting with a dot — 880 of 8306 internal imports on this repository, concentrated in the renderer.",
    prompt: "Построй индекс проекта.",
    seed: {
      "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      "src/a.ts": "import { b } from '@/b';\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
    },
    script: [toolCallStep("project_index", {}), finalStep("Индекс построен")],
    oracle: (ws) => hasImportEdge(ws, "src/a.ts", "src/b.ts"),
  },
  {
    id: "intel-jsonc-tsconfig",
    category: "intel",
    rationale:
      "tsconfig.json is JSONC by convention. A plain JSON.parse fails on most real projects and fails SILENTLY — every alias then resolves to nothing and the graph looks merely sparse rather than broken.",
    prompt: "Построй индекс проекта.",
    seed: {
      "tsconfig.json": '{\n  // renderer aliases\n  "compilerOptions": {\n    "paths": { "@/*": ["./src/*"], },\n  },\n}',
      "src/a.ts": "import { b } from '@/b';\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
    },
    script: [toolCallStep("project_index", {}), finalStep("Индекс построен")],
    oracle: (ws) => hasImportEdge(ws, "src/a.ts", "src/b.ts"),
  },
  {
    id: "intel-no-phantom-edges",
    category: "intel",
    rationale:
      "The mirror of the above: a specifier that resolves nowhere must produce NO edge. A resolver that invents edges is worse than one that misses them, because impact analysis then reports confident nonsense.",
    prompt: "Построй индекс проекта.",
    seed: {
      "src/a.ts": "import React from 'react';\nimport x from './missing.js';\nexport default [React, x];\n",
    },
    script: [toolCallStep("project_index", {}), finalStep("Индекс построен")],
    oracle: async (ws) => {
      const index = await readProjectIndex(ws);
      return Boolean(index) && index!.edges.filter((edge) => edge.from === "src/a.ts").length === 0;
    },
  },

  // ── Search surfaces ─────────────────────────────────────────────────────
  {
    id: "search-grep-finds-match",
    category: "search",
    rationale:
      "Agentic search is the primary retrieval path; a silent miss sends the agent looking in the wrong place. The oracle reads the RESULT, not the seed file — an oracle that checks the workspace still contains what we put there passes even when the tool never ran, which is exactly how this task hid a broken call the first time it was written.",
    prompt: "Найди NEEDLE в проекте.",
    seed: { "src/x.ts": "const a = 1;\nconst NEEDLE = 2;\n" },
    script: [toolCallStep("grep_search", { query: "NEEDLE" }), finalStep("Нашёл")],
    oracle: async (_ws, run) => run.toolErrors === 0 && run.toolOutputs.some((out) => out.includes("src/x.ts") && out.includes("NEEDLE")),
  },
  {
    id: "search-read-window",
    category: "search",
    rationale:
      "Reading a slice rather than a whole file is what keeps large files usable. A broken offset silently returns the wrong region and the model then edits against text it never saw.",
    prompt: "Прочитай кусок файла.",
    seed: { "big.txt": Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n") + "\n" },
    script: [toolCallStep("read_file", { path: "big.txt", offset: 10, limit: 5 }), finalStep("Прочитал")],
    oracle: async (_ws, run) => {
      const out = run.toolOutputs.join("\n");
      // The requested window, and nothing from outside it.
      return out.includes("line11") && out.includes("line14") && !out.includes("line1\n") && !out.includes("line20");
    },
  },

  // ── Recovery: a failure must leave the agent able to continue ───────────
  {
    id: "recover-after-rejected-edit",
    category: "recover",
    rationale:
      "A rejected patch must not poison the session. The corrected second attempt has to succeed against a file the failed attempt left untouched — this is the loop that turns one bad guess into a fix instead of a dead end.",
    prompt: "Исправь, даже если первая попытка не пройдёт.",
    seed: { "retry.txt": THREE_LINES },
    script: [
      toolCallStep("edit_file", { patch: "*** Update File: retry.txt\n-wrong-context\n+X\n" }, "c-fail"),
      toolCallStep("edit_file", { patch: "*** Update File: retry.txt\n line1\n-line2\n+FIXED\n line3\n" }, "c-ok"),
      finalStep("Исправлено со второй попытки"),
    ],
    oracle: async (ws, run) => rejected(run) && (await fileContains(ws, "retry.txt", "FIXED")),
  },
];
