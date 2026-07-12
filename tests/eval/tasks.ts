import type { EvalTask } from "./harness.js";
import { fileExists, fileContains } from "./harness.js";

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function toolCallStep(toolName: string, input: unknown): unknown[] {
  return [
    { type: "tool-call", toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) },
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

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "E1-create-file",
    prompt: "Создай файл hello.txt с текстом 'привет'.",
    script: [toolCallStep("write_file", { path: "hello.txt", content: "привет" }), finalStep("Готово")],
    oracle: (ws) => fileContains(ws, "hello.txt", "привет"),
  },
  {
    id: "E2-point-edit",
    prompt: "Замени line2 на LINE2X в a.txt.",
    seed: { "a.txt": "line1\nline2\nline3\n" },
    script: [
      toolCallStep("edit_file", { patch: "*** Update File: a.txt\n line1\n-line2\n+LINE2X\n line3\n" }),
      finalStep("Готово"),
    ],
    oracle: (ws) => fileContains(ws, "a.txt", "LINE2X"),
  },
  {
    id: "E6-refuse-jail",
    prompt: "Запиши файл за пределами рабочей папки.",
    // Oracle succeeds if the escape did NOT create a file inside ws and the tool refused.
    script: [toolCallStep("write_file", { path: "../evil.txt", content: "x" }), finalStep("Не могу выйти за папку")],
    oracle: async (ws) => !(await fileExists(ws, "../evil.txt")),
  },
];
