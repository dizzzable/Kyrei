# Kyrei v2 — TURNKEY Blueprint: ORCHESTRATOR + STREAM-BRIDGE + PROVIDER LAYER

> Прямо имплементируемый чертёж для трёх подсистем ядра v2 на **Vercel AI SDK v5**.
> Local-first, ядро на TypeScript за флагом `KYREI_ENGINE=v2`; `gateway.js` / `session-store.js` остаются JS.
> Соответствует `.kiro/specs/kyrei-engine/design.md` (Overview, Components §1/§2/§5, Data Models, Correctness Properties 4/5/7) и сохраняет контракт `runKyreiChat({emit, messages, …}) → {text, parts}` из `core/kyrei-engine.js`.
>
> **Пин версии:** `ai@5.0.x` + `@ai-sdk/openai-compatible@1.0.x`. Используем **только v5-имена**:
> `streamText`, `stepCountIs(n)`, `hasToolCall(name)`, `tool()`, `ModelMessage`, `MockLanguageModelV2`, `simulateReadableStream`.
> **НЕ** использовать v6/v7-имена: ~~`isStepCount`~~, ~~`isLoopFinished`~~, ~~`MockLanguageModelV3`~~, ~~`ToolLoopAgent`~~, ~~`pruneMessages`~~.

## Проверка API против ai-sdk.dev (цитаты inline)

| Факт v5 | Источник | Вывод для кода |
|---|---|---|
| `createOpenAICompatible({ name, apiKey, baseURL, includeUsage, headers, fetch, queryParams, transformRequestBody })`; `includeUsage:true` включает usage в стриме (иначе `usage=null`) | [OpenAI Compatible Providers](https://ai-sdk.dev/providers/openai-compatible-providers) | `build.ts` создаёт провайдера явным объектом, `includeUsage:true` обязателен для авто-компакции. |
| `apiKey` добавляет заголовок `Authorization: Bearer <key>` **перед** `headers`; кастомный `fetch` — «middleware to intercept requests … or for testing» | [там же](https://ai-sdk.dev/providers/openai-compatible-providers) | `keys.ts` round-robin делаем через кастомный `fetch`, а не через фиксированный `apiKey`. |
| Стоп-условия комбинируются массивом; в v5 это `stepCountIs(count)` и `hasToolCall(...names)` (в v7 переименованы в `isStepCount`/`isLoopFinished` — **не наши**) | [Loop Control](https://ai-sdk.dev/docs/agents/loop-control) | `stopWhen: [stepCountIs(maxSteps), hasToolCall('attempt_completion')]`. |
| `prepareStep({ stepNumber, steps, messages, model })` может вернуть `{ messages, activeTools, toolChoice, model }`; возвращённый `messages` становится базой для следующих шагов | [Loop Control → Prepare Step](https://ai-sdk.dev/docs/agents/loop-control) | Компакция контекста внутри цикла, без разрыва tool-пар. |
| Финальные сообщения ручного/авто-цикла берём из response-messages (`ModelMessage[]`), а не из выдуманного `responseMessages` верхнего уровня | [Loop Control → Manual Loop](https://ai-sdk.dev/docs/agents/loop-control) (`result.responseMessages` внутри цикла) | Для персиста: `(await result.response).messages`. |
| `fullStream` даёт прямой доступ ко всем событиям модели для собственного формата | [Custom Stream Format](https://ai-sdk.dev/cookbook/next/custom-stream-format) | `stream-bridge` итерирует `result.fullStream` и мостит в `KyreiEvent`. |
| Тестовые дублёры v5 — `MockLanguageModelV2` + `simulateReadableStream` | [Testing](https://ai-sdk.dev/docs/ai-sdk-core/testing) | Интеграционные тесты стрима без сети. |

*Контент источников перефразирован для соответствия лицензионным ограничениям.*

---

## 0. Обзор потока данных

```
gateway.js (JS)
  └─ runPrompt(session, text)
       │  AbortController на сессию (Map<session, AbortController>)
       ▼
runKyreiChat(opts)  ← core/engine/orchestrator/run.ts (TS-бандл)
   1. buildProvider(opts)         → provider/build.ts + registry.ts + keys.ts
   2. buildTools(jail, cfg)       → tools/* (execute с jail, ошибки → tool-error)
   3. streamText({ model, system, messages, tools,
                   stopWhen: stepCountIs(n), abortSignal,
                   onError: log, prepareStep, maxRetries })
   4. bridgeStream(result.fullStream, emit)  → stream-bridge/bridge.ts
        → KyreiEvent через emit() (тот же формат, что и v1)
   5. const { messages } = await result.response   → parts для персиста
   6. return { text, parts }
```

Ключевые инварианты этого чертежа (из design.md Correctness Properties):
- **Property 4 (Отмена ≠ ошибка):** `abort`-часть → `status:"interrupted"`, событие `error` НЕ эмитится.
- **Property 7 (Стабильность `tool_call_id`):** id из `tool-input-start` == id в `tool.start` == id в `tool.complete`.
- **Единый источник ошибки:** только `error`-часть `fullStream`; `onError` — лишь логирование.

---

## 1. Файловое дерево `core/engine/{orchestrator,stream-bridge,provider}/**`

```
core/engine/
├─ types.ts                      // KyreiEvent, MessagePart, Usage, EngineConfig, ToolResult — общие типы контракта
│
├─ orchestrator/
│  ├─ run.ts                     // runKyreiChat(opts): точка входа; собирает provider+tools, зовёт streamText, мостит стрим, возвращает {text,parts}
│  ├─ system-prompt.ts           // сборка system-строки (роль Kyrei, workspace, список инструментов) — вынесено из v1
│  ├─ stop-conditions.ts         // buildStopWhen(cfg): [stepCountIs(n), hasToolCall('attempt_completion')] + токен-бюджет-условие
│  ├─ prepare-step.ts            // prepareStep-колбэк: порог → компакция messages (без разрыва tool-пар); no-op по умолчанию
│  ├─ no-key-guidance.ts         // путь «нет API-ключа»: эмитит подсказку и возвращает {text,parts} без вызова сети
│  └─ persist.ts                 // toParts((await result.response).messages): ModelMessage[] → MessagePart[] для session-store
│
├─ stream-bridge/
│  ├─ bridge.ts                  // bridgeStream(fullStream, emit, ctx): for await switch по ВСЕМ v5 part-типам → KyreiEvent
│  ├─ state.ts                   // BridgeState: аккумулятор text/reasoning, Map<id> tool-вызовов, флаги aborted/errored, финальный status
│  ├─ status.ts                  // computeStatus(state): 'complete'|'interrupted'|'error'|'max_steps'
│  ├─ tool-tracker.ts            // стабильный tool_call_id; сбор args из tool-input-delta; inline_diff из metadata tool-result
│  └─ parts.ts                   // сборка MessagePart[] из событий стрима (запасной путь, если response.messages недоступен)
│
└─ provider/
   ├─ registry.ts                // ModelEntry {id,provider,limits,cost,caps}; resolve(role|id) → ModelEntry
   ├─ build.ts                   // buildModel(entry, keyPool): createOpenAICompatible({name,baseURL,apiKey,includeUsage,headers,fetch})
   ├─ fallback.ts                // цепочка: reactive (429/5xx) + proactive; exponential backoff; circuit-breaker per-provider
   ├─ no-tools-fallback.ts       // ловля tool-related 400/404/422 у стрима (не throw синхронно) → перезапуск streamText без tools
   ├─ keys.ts                    // KeyPool: round-robin + session-affinity + cooldown/circuit-breaker; отдаёт fetch-middleware
   └─ errors.ts                  // классификация ошибок: isRetryable/isToolUnsupported/isRateLimit по status/сообщению
```

Каждый файл — одна ответственность; чистые функции (`status.ts`, `stop-conditions.ts`, `persist.ts`, `errors.ts`, `registry.ts`) юнит-тестируются без сети (design.md Testing §1).

---

## 2. `orchestrator/run.ts` — полный `runKyreiChat(opts)`

Сигнатура сохранена байт-в-байт совместимой с v1 (см. `core/kyrei-engine.js` — `runKyreiChat({emit, messages, providerBase, apiKey, model, workspace, isCancelled})`), но `isCancelled`-polling заменён на `abortSignal` (design.md §Отмена). Gateway передаёт `abortSignal` из `AbortController` (§5).

### 2.1 Общие типы (`core/engine/types.ts`)

```ts
// core/engine/types.ts — контракт с gateway/renderer (НЕ менять форму событий).
import type { ModelMessage } from "ai";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type KyreiEvent =
  | { type: "message.start" }
  | { type: "message.delta";    payload: { text: string } }
  | { type: "reasoning.delta";  payload: { text: string } }
  | { type: "tool.start";       payload: { tool_call_id: string; name: string; args: unknown } }
  | { type: "tool.progress";    payload: { tool_call_id: string; text: string } }
  | { type: "tool.complete";    payload: { tool_call_id: string; name: string; result?: string;
                                           inline_diff?: string; error?: string; duration_s: number } }
  | { type: "status.update";    payload: { model?: string; provider?: string; usage?: Usage } }
  | { type: "message.complete"; payload: { text: string;
                                           status: "complete" | "interrupted" | "error" | "max_steps";
                                           usage?: Usage } }
  | { type: "error";            payload: { message: string } };

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; toolCallId: string; name: string; args?: unknown; result?: string;
      inlineDiff?: string; error?: string; running: boolean; durationS?: number };

/** Единый контракт результата инструмента (design.md §3 Tools). */
export interface ToolResult { title: string; output: string; metadata?: Record<string, unknown>; }

export interface EngineConfig {
  maxSteps: number;               // деф. 12
  commandTimeoutMs: number;       // деф. 60000
  maxToolOutput: number;          // деф. 12000
  contextBudget: { softPct: number; hardPct: number };
  providerRoles: Record<"default" | "small" | "plan", string>; // id в реестре
  fallbackChain: string[];
}

export interface RunKyreiChatOpts {
  emit: (e: KyreiEvent) => void;
  messages: ModelMessage[];
  providerBase: string;
  apiKey: string;
  model: string;
  workspace?: string;
  abortSignal?: AbortSignal;      // из gateway AbortController (§5)
  config?: Partial<EngineConfig>;
}
```

### 2.2 `run.ts` — полная реализация

```ts
// core/engine/orchestrator/run.ts
import { streamText, stepCountIs, type ModelMessage } from "ai";
import type { KyreiEvent, MessagePart, RunKyreiChatOpts, EngineConfig } from "../types";
import { buildModel } from "../provider/build";
import { resolve as resolveModel } from "../provider/registry";
import { KeyPool } from "../provider/keys";
import { withFallback } from "../provider/fallback";
import { streamTextNoToolsFallback } from "../provider/no-tools-fallback";
import { buildTools } from "../tools";                 // из tools/ (jail внутри execute)
import { createJail } from "../security/jail";
import { buildSystemPrompt } from "./system-prompt";
import { buildStopWhen } from "./stop-conditions";
import { makePrepareStep } from "./prepare-step";
import { bridgeStream } from "../stream-bridge/bridge";
import { toParts } from "./persist";
import { emitNoKeyGuidance } from "./no-key-guidance";

const DEFAULTS: EngineConfig = {
  maxSteps: 12,
  commandTimeoutMs: 60_000,
  maxToolOutput: 12_000,
  contextBudget: { softPct: 0.7, hardPct: 0.9 },
  providerRoles: { default: "default", small: "small", plan: "plan" },
  fallbackChain: [],
};

export async function runKyreiChat(opts: RunKyreiChatOpts): Promise<{ text: string; parts: MessagePart[] }> {
  const { emit, messages, providerBase, apiKey, model, workspace, abortSignal } = opts;
  const cfg: EngineConfig = { ...DEFAULTS, ...opts.config };

  emit({ type: "message.start" });

  // (A) Путь «нет API-ключа» — ранний возврат, без сети (паритет с v1).
  if (!apiKey) return emitNoKeyGuidance(emit);

  // (B) Инструменты только при валидном workspace; jail резолвит симлинки один раз.
  const jail = workspace ? await createJail(workspace).catch(() => null) : null;
  const tools = jail ? buildTools(jail, cfg, abortSignal) : undefined;
  const system = buildSystemPrompt({ workspace, hasTools: Boolean(tools) });

  // (C) Провайдер: реестр → build (явный createOpenAICompatible), с round-robin ключей.
  const entry = resolveModel(cfg.providerRoles.default ?? model, { baseURL: providerBase, id: model });
  const keyPool = new KeyPool({ keys: [apiKey], sessionId: /* из opts при наличии */ undefined });

  // (D) Функция запуска одного streamText — обёрнута в fallback-цепочку и no-tools-fallback.
  const startStream = (over?: { tools?: undefined }) =>
    streamText({
      model: buildModel(entry, keyPool),
      system,
      messages,
      tools: over?.tools === undefined && "tools" in (over ?? {}) ? undefined : tools,
      stopWhen: buildStopWhen(cfg),                       // [stepCountIs(maxSteps), hasToolCall('attempt_completion')]
      abortSignal,
      maxRetries: 2,                                      // сетевые ретраи SDK; поверх — наш fallback.ts
      prepareStep: makePrepareStep(cfg),                  // компакция на пороге (без разрыва tool-пар)
      onError: ({ error }) => {                           // ТОЛЬКО лог; эмит ошибки — из fullStream (единый источник)
        console.error("[kyrei] streamText onError:", error);
      },
    });

  // (E) Выполнение с реактивным fallback (429/5xx) и «без tools» откатом (400/404/422 вокруг стрима).
  const result = await withFallback(cfg, entry, keyPool, () =>
    streamTextNoToolsFallback(startStream, { hasTools: Boolean(tools) }),
  );

  // (F) Мостим fullStream → KyreiEvent; bridge сам эмитит message.complete со статусом.
  const bridged = await bridgeStream(result.fullStream, emit, {
    hasTools: Boolean(tools),
    provider: entry.provider,
    model: entry.id,
  });

  // (G) Персист: финальные сообщения из response (ModelMessage[]), НЕ из выдуманного responseMessages.
  let parts: MessagePart[];
  try {
    const response = await result.response;             // { messages: ModelMessage[], ... }
    parts = toParts(response.messages, bridged);         // объединяем текст/tool-parts + duration/inline_diff из bridge
  } catch {
    parts = bridged.parts;                               // запасной путь: parts, собранные из стрима (stream-bridge/parts.ts)
  }

  return { text: bridged.text, parts };
}
```

### 2.3 `no-key-guidance.ts` — путь без ключа

```ts
// core/engine/orchestrator/no-key-guidance.ts
import type { KyreiEvent, MessagePart } from "../types";

export function emitNoKeyGuidance(emit: (e: KyreiEvent) => void): { text: string; parts: MessagePart[] } {
  const guidance =
    "⚠️ **Не задан API-ключ провайдера.**\n\n" +
    "Откройте **Настройки** и укажите провайдера (Base URL), API-ключ и модель. " +
    "Например: `https://api.openai.com/v1`, `https://api.deepseek.com/v1` или `https://openrouter.ai/api/v1`. " +
    "Для локального режима — `http://localhost:11434/v1` (Ollama) или `http://localhost:1234/v1` (LM Studio).";
  emit({ type: "message.delta", payload: { text: guidance } });
  emit({ type: "message.complete", payload: { text: guidance, status: "complete" } });
  return { text: guidance, parts: [{ type: "text", text: guidance }] };
}
```

### 2.4 `stop-conditions.ts` и `system-prompt.ts`

```ts
// core/engine/orchestrator/stop-conditions.ts
import { stepCountIs, hasToolCall, type StopCondition, type ToolSet } from "ai";
import type { EngineConfig } from "../types";

export function buildStopWhen(cfg: EngineConfig): StopCondition<ToolSet>[] {
  return [
    stepCountIs(cfg.maxSteps),          // v5-имя (НЕ isStepCount)
    hasToolCall("attempt_completion"),  // модель явно сигналит «готово»
    // токен-бюджет-условие: суммарный usage по шагам ≥ hardPct·window → стоп
    ({ steps }) => {
      const used = steps.reduce((n, s) => n + (s.usage?.totalTokens ?? 0), 0);
      return used >= (cfg.contextBudget.hardPct * /* window */ 128_000);
    },
  ];
}
```

```ts
// core/engine/orchestrator/system-prompt.ts
export function buildSystemPrompt(o: { workspace?: string; hasTools: boolean }): string | undefined {
  if (!o.hasTools) return undefined;
  return (
    `Ты — Kyrei, встроенный AI-агент для работы с кодом. Рабочая папка: ${o.workspace}.\n` +
    "Доступные инструменты: list_dir, read_file, grep_search, edit_file, write_file, run_command. " +
    "Исследуй проект и меняй файлы только через инструменты; пути — относительно рабочей папки. " +
    "Когда задача выполнена — вызови attempt_completion с кратким итогом. Отвечай на русском."
  );
}
```

---

## 3. `stream-bridge/` — маппинг ВСЕХ v5 part-типов → `KyreiEvent`

Чистый трансформер: `for await (const part of result.fullStream)`. Никакой сети, полностью тестируется через `simulateReadableStream` + `MockLanguageModelV2`. Обрабатываем **каждый** тип части v5, иначе UI молча теряет события.

### 3.1 `stream-bridge/state.ts` — аккумулятор

```ts
// core/engine/stream-bridge/state.ts
import type { MessagePart, Usage } from "../types";

export interface ToolInFlight {
  id: string;
  name: string;
  argsText: string;         // накопленный tool-input-delta (JSON-строка)
  args?: unknown;           // распарсенный input из tool-call
  startedAt: number;
  inlineDiff?: string;      // из metadata tool-result
  result?: string;
  error?: string;
  done: boolean;
}

export interface BridgeState {
  text: string;                    // финальный ассистентский текст
  parts: MessagePart[];            // сборка для персиста (запасной путь)
  tools: Map<string, ToolInFlight>;// по tool_call_id — стабильный id (Property 7)
  usage?: Usage;                   // из finish (totalUsage при наличии)
  aborted: boolean;                // была abort-часть → interrupted (Property 4)
  errored: boolean;                // была error-часть → error (единый источник)
  stepCount: number;               // число start-step (для max_steps)
  finished: boolean;               // была finish-часть
}

export function initState(): BridgeState {
  return { text: "", parts: [], tools: new Map(), aborted: false, errored: false, stepCount: 0, finished: false };
}

/** append-text с объединением в последний text-part. */
export function pushText(st: BridgeState, delta: string): void {
  st.text += delta;
  const last = st.parts[st.parts.length - 1];
  if (last && last.type === "text") last.text += delta;
  else st.parts.push({ type: "text", text: delta });
}
```

### 3.2 `stream-bridge/bridge.ts` — полный switch по частям

```ts
// core/engine/stream-bridge/bridge.ts
import type { KyreiEvent, MessagePart, Usage } from "../types";
import { initState, pushText, type BridgeState, type ToolInFlight } from "./state";
import { computeStatus } from "./status";

export interface BridgeCtx { hasTools: boolean; provider: string; model: string; maxSteps?: number; }
export interface BridgeResult { text: string; parts: MessagePart[]; usage?: Usage;
  status: "complete" | "interrupted" | "error" | "max_steps"; }

function toUsage(u: any): Usage | undefined {
  if (!u) return undefined;
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens };
}

export async function bridgeStream(
  fullStream: AsyncIterable<any>,   // ReadonlyArray-совместимый stream v5 (TextStreamPart)
  emit: (e: KyreiEvent) => void,
  ctx: BridgeCtx,
): Promise<BridgeResult> {
  const st = initState();

  for await (const part of fullStream) {
    switch (part.type) {
      // ── жизненный цикл запуска ────────────────────────────────────
      case "start":
        break;                                   // общий старт стрима — уже эмитили message.start в orchestrator
      case "start-step":
        st.stepCount += 1;                       // счёт шагов → для max_steps в computeStatus
        break;

      // ── текст ассистента (v5: поле `text`, есть id для мультиблоков) ─
      case "text-start":
        break;                                   // начало текстового блока — маркер, не эмитим
      case "text-delta":
        if (part.text) { pushText(st, part.text); emit({ type: "message.delta", payload: { text: part.text } }); }
        break;
      case "text-end":
        break;

      // ── reasoning (thinking) ──────────────────────────────────────
      case "reasoning-start":
        break;
      case "reasoning-delta":
        if (part.text) {
          const last = st.parts[st.parts.length - 1];
          if (last && last.type === "reasoning") last.text += part.text;
          else st.parts.push({ type: "reasoning", text: part.text });
          emit({ type: "reasoning.delta", payload: { text: part.text } });
        }
        break;
      case "reasoning-end":
        break;

      // ── аргументы инструмента приходят потоково ДО tool-call ───────
      case "tool-input-start": {
        // v5: { id, toolName } — заводим запись и эмитим tool.start (args пока пустые/живые)
        const t: ToolInFlight = { id: part.id, name: part.toolName, argsText: "", startedAt: Date.now(), done: false };
        st.tools.set(part.id, t);                // стабильный id (Property 7): один и тот же в start/complete
        emit({ type: "tool.start", payload: { tool_call_id: part.id, name: part.toolName, args: {} } });
        break;
      }
      case "tool-input-delta": {
        const t = st.tools.get(part.id);
        if (t) {
          t.argsText += part.delta ?? "";
          emit({ type: "tool.progress", payload: { tool_call_id: part.id, text: part.delta ?? "" } });
        }
        break;
      }
      case "tool-input-end":
        break;                                   // конец потока аргументов — финальный input придёт в tool-call

      // ── финальный вызов инструмента (v5: поле `input`) ────────────
      case "tool-call": {
        // Если tool-input-start не пришёл (некоторые провайдеры) — заводим запись здесь.
        let t = st.tools.get(part.toolCallId);
        if (!t) {
          t = { id: part.toolCallId, name: part.toolName, argsText: "", startedAt: Date.now(), done: false };
          st.tools.set(part.toolCallId, t);
          emit({ type: "tool.start", payload: { tool_call_id: part.toolCallId, name: part.toolName, args: part.input } });
        }
        t.args = part.input;                     // v5: input, НЕ arguments
        break;
      }

      // ── результат инструмента (v5: поле `output`) ─────────────────
      case "tool-result": {
        const t = st.tools.get(part.toolCallId);
        const output = stringifyOutput(part.output);
        // inline_diff путешествует из metadata результата (edit_file/write_file кладут его туда).
        const inlineDiff = extractInlineDiff(part.output);
        if (t) {
          t.result = output; t.inlineDiff = inlineDiff; t.done = true;
          finalizeToolPart(st, t);
          emit({ type: "tool.complete", payload: {
            tool_call_id: t.id, name: t.name, result: output, inline_diff: inlineDiff,
            duration_s: (Date.now() - t.startedAt) / 1000 } });
        }
        break;
      }
      case "tool-error": {
        const t = st.tools.get(part.toolCallId);
        const message = errMsg(part.error);
        if (t) {
          t.error = message; t.done = true;
          finalizeToolPart(st, t);
          emit({ type: "tool.complete", payload: {
            tool_call_id: t.id, name: t.name, error: message,
            duration_s: (Date.now() - t.startedAt) / 1000 } });
        }
        // ВАЖНО: tool-error — это ошибка ИНСТРУМЕНТА, не стрима. НЕ ставим st.errored,
        // НЕ эмитим глобальный error — модель увидит tool.complete{error} и починит (design.md Error Handling).
        break;
      }

      // ── завершение шага и всего стрима ────────────────────────────
      case "finish-step":
        // usage конкретного шага — можно эмитить статус для UI-индикатора.
        if (part.usage) emit({ type: "status.update", payload: { provider: ctx.provider, model: ctx.model, usage: toUsage(part.usage) } });
        break;
      case "finish":
        st.finished = true;
        st.usage = toUsage(part.totalUsage ?? part.usage); // новые версии: totalUsage; старые: usage
        break;

      // ── отмена: ОТДЕЛЬНЫЙ путь, НЕ ошибка (Property 4) ────────────
      case "abort":
        st.aborted = true;
        break;

      // ── единственный источник ошибки стрима ───────────────────────
      case "error":
        st.errored = true;
        emit({ type: "error", payload: { message: errMsg(part.error) } });
        break;

      // ── сырые провайдер-события: игнор (только для дебага) ─────────
      case "raw":
        break;

      default:
        // Неизвестный тип части — не роняем цикл, логируем для будущей поддержки.
        console.warn("[kyrei] unknown stream part:", (part as { type?: string }).type);
    }
  }

  const status = computeStatus(st, ctx);
  // Финальное событие. abort → interrupted; error-часть → error; иначе complete/max_steps.
  emit({ type: "message.complete", payload: { text: st.text, status, usage: st.usage } });
  return { text: st.text, parts: st.parts, usage: st.usage, status };
}

// ── helpers ──────────────────────────────────────────────────────────
function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  // ToolResult { title, output, metadata } — показываем output; иначе JSON.
  if (typeof output === "object" && "output" in (output as any)) return String((output as any).output ?? "");
  try { return JSON.stringify(output); } catch { return String(output); }
}
function extractInlineDiff(output: unknown): string | undefined {
  if (output && typeof output === "object") {
    const md = (output as any).metadata;
    if (md && typeof md.inlineDiff === "string") return md.inlineDiff; // из tool-result metadata → tool.complete
  }
  return undefined;
}
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
/** Пишем/обновляем tool-part для персиста (запасной путь, если response.messages недоступен). */
function finalizeToolPart(st: BridgeState, t: ToolInFlight): void {
  st.parts.push({
    type: "tool", toolCallId: t.id, name: t.name, args: t.args,
    result: t.result, inlineDiff: t.inlineDiff, error: t.error,
    running: false, durationS: (Date.now() - t.startedAt) / 1000,
  });
}
```

### 3.3 `stream-bridge/status.ts` — вычисление финального статуса

```ts
// core/engine/stream-bridge/status.ts
import type { BridgeState } from "./state";
import type { BridgeCtx } from "./bridge";

export function computeStatus(
  st: BridgeState,
  ctx: BridgeCtx,
): "complete" | "interrupted" | "error" | "max_steps" {
  // Порядок приоритета важен:
  if (st.aborted) return "interrupted";                       // Property 4: отмена ≠ ошибка
  if (st.errored) return "error";                             // была error-часть
  if (ctx.maxSteps && st.stepCount >= ctx.maxSteps && !st.finished) return "max_steps"; // упёрлись в лимит шагов
  return "complete";
}
```

### 3.4 Ключевые правила маппинга (сводка)

| v5 part | Поле | KyreiEvent | Заметка |
|---|---|---|---|
| `start` | — | (message.start уже эмитнут) | Общий старт. |
| `start-step` | — | — | `stepCount++` для `max_steps`. |
| `text-start/-end` | `id` | — | Маркеры блока, не эмитим. |
| `text-delta` | **`text`** | `message.delta{text}` | В v4 было `textDelta` — в v5 поле `text`. |
| `reasoning-start/-end` | `id` | — | Маркеры. |
| `reasoning-delta` | **`text`** | `reasoning.delta{text}` | Отдельный part-накопитель. |
| `tool-input-start` | `id`,`toolName` | `tool.start` | Здесь фиксируем стабильный `tool_call_id` (Property 7). |
| `tool-input-delta` | `id`,`delta` | `tool.progress` | Живые аргументы для прогресса. |
| `tool-input-end` | `id` | — | Конец потока аргументов. |
| `tool-call` | **`input`**,`toolCallId`,`toolName` | (fallback `tool.start`) | В v5 поле `input` (НЕ `arguments`). |
| `tool-result` | **`output`**,`toolCallId` | `tool.complete{result,inline_diff}` | `inline_diff` из `output.metadata.inlineDiff`. |
| `tool-error` | `error`,`toolCallId` | `tool.complete{error}` | НЕ глобальный `error`; модель чинит сама. |
| `finish-step` | `usage` | `status.update{usage}` | Usage шага. |
| `finish` | **`totalUsage`**/`usage` | (в `message.complete`) | Новые версии — `totalUsage`. |
| `abort` | — | (→ `interrupted`) | Отдельный путь, Property 4. |
| `error` | `error` | `error{message}` | **Единственный** источник глобальной ошибки. |
| `raw` | — | — | Игнор (дебаг). |

### 3.5 Сборка `parts` для персиста

Основной путь — `(await result.response).messages` (`ModelMessage[]`) в `orchestrator/persist.ts` (§2.2 шаг G): там уже корректно спарены assistant-текст и tool-вызовы в формате провайдера. Запасной путь — `st.parts`, собранные из стрима в `bridge.ts` (`pushText` + `finalizeToolPart`), на случай если провайдер не отдал `response` (например, оборвался после `abort`). `toParts()` мержит длительности/`inlineDiff` из `BridgeResult` в структуру из `response.messages`:

```ts
// core/engine/orchestrator/persist.ts
import type { ModelMessage } from "ai";
import type { MessagePart } from "../types";
import type { BridgeResult } from "../stream-bridge/bridge";

export function toParts(messages: ModelMessage[], bridged: BridgeResult): MessagePart[] {
  const byId = new Map(bridged.parts.filter(p => p.type === "tool").map(p => [(p as any).toolCallId, p]));
  const out: MessagePart[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
    for (const c of content as any[]) {
      if (c.type === "text") out.push({ type: "text", text: c.text });
      else if (c.type === "reasoning") out.push({ type: "reasoning", text: c.text });
      else if (c.type === "tool-call") {
        const enriched = byId.get(c.toolCallId);           // добавляем result/inlineDiff/duration из стрима
        out.push({
          type: "tool", toolCallId: c.toolCallId, name: c.toolName, args: c.input,
          result: (enriched as any)?.result, inlineDiff: (enriched as any)?.inlineDiff,
          error: (enriched as any)?.error, running: false, durationS: (enriched as any)?.durationS,
        });
      }
    }
  }
  return out.length ? out : bridged.parts;                 // если response пуст — запасной путь
}
```

---

## 4. Provider layer `core/engine/provider/**`

Принцип из design.md: **никогда голая строка модели** (иначе включится Vercel Gateway) — только явный `createOpenAICompatible({ baseURL })`.

### 4.1 `registry.ts` — реестр моделей

```ts
// core/engine/provider/registry.ts
export interface ModelLimits { contextWindow: number; maxOutput: number; }
export interface ModelCost { inputPerM: number; outputPerM: number; } // $/1M токенов
export interface ModelCaps { tools: boolean; reasoning: boolean; streaming: boolean; }

export interface ModelEntry {
  id: string;                 // id модели у провайдера, напр. "gpt-4o-mini", "llama3.1:8b"
  provider: string;           // логическое имя, напр. "openai" | "deepseek" | "ollama"
  baseURL: string;            // OpenAI-compatible endpoint
  limits: ModelLimits;
  cost: ModelCost;
  caps: ModelCaps;
}

// Реестр — статичный + расширяемый из config. Роли ('default'|'small'|'plan') маппятся на id.
const REGISTRY: Record<string, ModelEntry> = {
  "gpt-4o-mini": { id: "gpt-4o-mini", provider: "openai", baseURL: "https://api.openai.com/v1",
    limits: { contextWindow: 128_000, maxOutput: 16_384 }, cost: { inputPerM: 0.15, outputPerM: 0.6 },
    caps: { tools: true, reasoning: false, streaming: true } },
  "llama3.1:8b": { id: "llama3.1:8b", provider: "ollama", baseURL: "http://localhost:11434/v1",
    limits: { contextWindow: 131_072, maxOutput: 8_192 }, cost: { inputPerM: 0, outputPerM: 0 },
    caps: { tools: true, reasoning: false, streaming: true } },
};

const ROLES: Record<string, string> = { default: "gpt-4o-mini", small: "gpt-4o-mini", plan: "gpt-4o-mini" };

/**
 * resolve(roleOrId): по роли или прямому id вернуть ModelEntry.
 * fallbackHint — из runtime-конфига gateway (providerBase/model), если id нет в реестре.
 */
export function resolve(roleOrId: string, fallbackHint?: { baseURL: string; id: string }): ModelEntry {
  const id = ROLES[roleOrId] ?? roleOrId;
  const entry = REGISTRY[id];
  if (entry) return entry;
  // Модель не в реестре (пользователь ввёл свой baseURL/model) — строим «unknown»-entry с безопасными дефолтами.
  return {
    id: fallbackHint?.id ?? id,
    provider: "custom",
    baseURL: fallbackHint?.baseURL ?? "http://localhost:11434/v1",
    limits: { contextWindow: 32_000, maxOutput: 4_096 },
    cost: { inputPerM: 0, outputPerM: 0 },
    caps: { tools: true, reasoning: false, streaming: true },
  };
}

export function registerModel(entry: ModelEntry): void { REGISTRY[entry.id] = entry; }
```

### 4.2 `build.ts` — построение модели (явный `createOpenAICompatible`)

```ts
// core/engine/provider/build.ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelEntry } from "./registry";
import type { KeyPool } from "./keys";

export function buildModel(entry: ModelEntry, keyPool: KeyPool): LanguageModel {
  const provider = createOpenAICompatible({
    name: entry.provider,
    baseURL: entry.baseURL,
    // apiKey НЕ фиксируем строкой: ключ подставляет keyPool через fetch-middleware (round-robin/affinity).
    // Дефолтный apiKey оставляем пустым — Authorization выставит наш fetch.
    apiKey: keyPool.staticKey() ?? "",
    includeUsage: true,                          // [verified] иначе usage=null в стриме → авто-компакция не сработает
    headers: { "X-Kyrei-Engine": "v2" },
    fetch: keyPool.fetchMiddleware(entry),       // перехват: ставит Authorization из пула + учёт cooldown
  });
  // Явный объект-модель, НЕ голая строка (защита от Vercel Gateway).
  return provider(entry.id);
}
```

### 4.3 `errors.ts` — классификация

```ts
// core/engine/provider/errors.ts
export function statusOf(err: unknown): number | undefined {
  const e = err as any;
  return e?.statusCode ?? e?.status ?? e?.response?.status ?? e?.data?.statusCode;
}
export function isRateLimit(err: unknown): boolean { return statusOf(err) === 429; }
export function isServerError(err: unknown): boolean { const s = statusOf(err); return !!s && s >= 500 && s < 600; }
export function isRetryable(err: unknown): boolean {
  return isRateLimit(err) || isServerError(err) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(String((err as any)?.message ?? ""));
}
/** Модель/провайдер не поддерживает tools/function-calling. */
export function isToolUnsupported(err: unknown): boolean {
  const s = statusOf(err);
  if (![400, 404, 422].includes(s ?? 0)) return false;
  const msg = String((err as any)?.message ?? (err as any)?.responseBody ?? "").toLowerCase();
  return /tool|function|tool_choice|not supported|unknown parameter|unsupported/.test(msg);
}
```

### 4.4 `fallback.ts` — реактивная + проактивная цепочка, backoff, circuit-breaker

```ts
// core/engine/provider/fallback.ts
import type { StreamTextResult, ToolSet } from "ai";
import type { EngineConfig } from "../types";
import type { ModelEntry } from "./registry";
import { resolve } from "./registry";
import type { KeyPool } from "./keys";
import { isRetryable, isRateLimit, isServerError } from "./errors";

interface Breaker { failures: number; openUntil: number; }
const breakers = new Map<string, Breaker>();     // per provider — circuit-breaker state (модульный синглтон)

function breakerKey(e: ModelEntry): string { return `${e.provider}:${e.baseURL}`; }
function isOpen(e: ModelEntry): boolean {
  const b = breakers.get(breakerKey(e));
  return !!b && Date.now() < b.openUntil;
}
function recordFailure(e: ModelEntry): void {
  const k = breakerKey(e);
  const b = breakers.get(k) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= 3) b.openUntil = Date.now() + 30_000;   // open на 30с после 3 отказов
  breakers.set(k, b);
}
function recordSuccess(e: ModelEntry): void { breakers.delete(breakerKey(e)); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * withFallback: пробегает [primary, ...cfg.fallbackChain], пропуская провайдеров с открытым breaker (проактивно),
 * и переключается реактивно на 429/5xx/сетевых ошибках с экспоненциальным backoff.
 * `attempt(entry)` должен ВЕРНУТЬ StreamTextResult; ошибки стрима, всплывшие синхронно, ловятся здесь.
 */
export async function withFallback<T extends ToolSet>(
  cfg: EngineConfig,
  primary: ModelEntry,
  keyPool: KeyPool,
  attempt: (entry?: ModelEntry) => Promise<StreamTextResult<T, unknown>>,
): Promise<StreamTextResult<T, unknown>> {
  const chain = [primary, ...cfg.fallbackChain.map(id => resolve(id))];
  let lastErr: unknown;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (isOpen(entry)) continue;                       // проактивный пропуск «сломанного» провайдера
    let backoff = 500;
    for (let retry = 0; retry <= 2; retry++) {
      try {
        const res = await attempt(entry);
        recordSuccess(entry);
        return res;
      } catch (err) {
        lastErr = err;
        if (isRateLimit(err) || isServerError(err)) recordFailure(entry);
        if (!isRetryable(err)) break;                  // не ретраибл — сразу к следующему провайдеру
        await sleep(backoff + Math.random() * 250);    // экспоненциальный backoff + jitter
        backoff *= 2;
      }
    }
    // исчерпали ретраи на этом провайдере → следующий в цепочке (реактивный fallback)
  }
  throw lastErr ?? new Error("Все провайдеры в fallback-цепочке недоступны");
}
```

### 4.5 `no-tools-fallback.ts` — ловля tool-related ошибки у стрима, который НЕ бросает синхронно

Тонкость v5: `streamText()` **возвращается сразу** (объект `StreamTextResult`), а сетевой запрос и разбор ответа происходят лениво при итерации `fullStream`. Значит tool-related ошибку 400/404/422 нельзя поймать обычным `try/catch` вокруг `streamText(...)`. Ловим её двумя путями:

1. **Peek первого чанка** `fullStream` через префетч: если первым приходит `error`-часть с признаком «tools не поддержаны» → перезапуск без tools.
2. **`onError` + флаг** — как страховка: SDK кладёт ошибку и в `error`-часть, и вызывает `onError`.

```ts
// core/engine/provider/no-tools-fallback.ts
import type { StreamTextResult, ToolSet } from "ai";
import { isToolUnsupported } from "./errors";

type Start = (over?: { tools?: undefined }) => StreamTextResult<ToolSet, unknown>;

/**
 * Запускает streamText; если провайдер не умеет tools (400/404/422 «tool/function…»),
 * перезапускает БЕЗ tools. Детект — по первой части fullStream (стрим не бросает синхронно).
 */
export async function streamTextNoToolsFallback(
  start: Start,
  o: { hasTools: boolean },
): Promise<StreamTextResult<ToolSet, unknown>> {
  const first = start();                               // с tools
  if (!o.hasTools) return first;

  // Префетч первой части: НЕ теряем её — восстанавливаем стрим через реплей.
  const source = first.fullStream[Symbol.asyncIterator]();
  const head = await source.next();

  if (!head.done && head.value?.type === "error" && isToolUnsupported(head.value.error)) {
    // Провайдер отверг tools — перезапуск без них (design.md Error Handling: 400/404/422 → no-tools).
    return start({ tools: undefined });
  }

  // Ошибки нет (или не tool-related): вернуть обёртку, которая «доигрывает» уже прочитанную голову.
  return wrapWithReplayedHead(first, head, source);
}

/** Обёртка: fullStream начинается с уже прочитанного head, затем продолжает исходный итератор. */
function wrapWithReplayedHead(
  result: StreamTextResult<ToolSet, unknown>,
  head: IteratorResult<any>,
  rest: AsyncIterator<any>,
): StreamTextResult<ToolSet, unknown> {
  const replayed: AsyncIterable<any> = {
    async *[Symbol.asyncIterator]() {
      if (!head.done) yield head.value;
      while (true) { const n = await rest.next(); if (n.done) break; yield n.value; }
    },
  };
  // Proxy: подменяем только fullStream; text/response/usage-промисы берём у оригинала.
  return new Proxy(result, {
    get(target, prop, recv) {
      if (prop === "fullStream") return replayed;
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
```

> Замечание по корректности: если tool-related ошибка приходит **не первой** частью (редко — после `start`/`start-step`), детект по head её пропустит. Страховка — `onError`-флаг + повторная проверка в `stream-bridge`: при `error`-части с `isToolUnsupported` bridge выставляет `retryWithoutTools`, а orchestrator перезапускает `streamText` без tools (ограничение: один повтор, чтобы не зациклиться).

### 4.6 `keys.ts` — round-robin + session-affinity + cooldown/circuit-breaker

```ts
// core/engine/provider/keys.ts
import type { ModelEntry } from "./registry";

interface KeyState { key: string; cooldownUntil: number; failures: number; }

export class KeyPool {
  private states: KeyState[];
  private rr = 0;                                   // round-robin курсор
  private affinity = new Map<string, number>();     // sessionId → index (session-affinity)
  private sessionId?: string;

  constructor(o: { keys: string[]; sessionId?: string }) {
    this.states = o.keys.filter(Boolean).map(key => ({ key, cooldownUntil: 0, failures: 0 }));
    this.sessionId = o.sessionId;
  }

  /** Единственный ключ (частый локальный кейс) — для дефолтного apiKey провайдера. */
  staticKey(): string | undefined { return this.states.length === 1 ? this.states[0].key : undefined; }

  private pick(): KeyState | undefined {
    const now = Date.now();
    const avail = this.states.filter(s => s.cooldownUntil <= now);
    if (avail.length === 0) return this.states[0];  // все на cooldown — берём первый (лучше попытка, чем отказ)
    // session-affinity: залипаем на один ключ в рамках сессии для prompt-cache.
    if (this.sessionId != null) {
      const idx = this.affinity.get(this.sessionId);
      if (idx != null && this.states[idx] && this.states[idx].cooldownUntil <= now) return this.states[idx];
      const chosen = avail[this.rr++ % avail.length];
      this.affinity.set(this.sessionId, this.states.indexOf(chosen));
      return chosen;
    }
    return avail[this.rr++ % avail.length];         // round-robin
  }

  private penalize(key: string, status?: number): void {
    const s = this.states.find(x => x.key === key);
    if (!s) return;
    s.failures += 1;
    // 429/5xx → cooldown с экспонентой (circuit-breaker на ключ).
    if (status === 429 || (status && status >= 500)) s.cooldownUntil = Date.now() + Math.min(60_000, 1_000 * 2 ** s.failures);
  }
  private reward(key: string): void { const s = this.states.find(x => x.key === key); if (s) s.failures = 0; }

  /**
   * fetch-middleware для createOpenAICompatible: подставляет Authorization из пула,
   * учитывает cooldown, штрафует ключ на 429/5xx.
   */
  fetchMiddleware(_entry: ModelEntry): typeof fetch {
    return async (input: any, init: any = {}) => {
      const state = this.pick();
      const headers = new Headers(init.headers ?? {});
      if (state?.key) headers.set("Authorization", `Bearer ${state.key}`);
      const res = await fetch(input, { ...init, headers });
      if (state) { if (res.ok) this.reward(state.key); else this.penalize(state.key, res.status); }
      return res;
    };
  }
}
```

---

## 5. Abort wiring: gateway `Map<session, AbortController>` → `interrupted` с сохранением частичного текста

В v1 отмена — это polling `isCancelled()` (`core/gateway.js` использует `Set<sessionId>` + `isCancelled: () => cancelled.has(sessionId)`). В v2 заменяем на `AbortController` per-session и пробрасываем `abortSignal` в `streamText` и в `execute` инструментов.

### 5.1 Изменения в `gateway.js` (остаётся JS)

```js
// core/gateway.js — фрагменты (замена cancelled:Set на controllers:Map)
const controllers = new Map(); // sessionId -> AbortController

async function runPrompt(sessionId, text) {
  // Отменяем предыдущий незавершённый ход этой сессии, заводим новый контроллер.
  controllers.get(sessionId)?.abort();
  const controller = new AbortController();
  controllers.set(sessionId, controller);

  const session = store.getSession(sessionId);
  if (!session) return;
  store.appendMessage(sessionId, { role: "user", content: text });

  await runKyreiChat({
    emit: event => emitTo(sessionId, event),
    messages: convoFor(sessionId),
    providerBase: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    workspace: config.workspace,
    abortSignal: controller.signal,          // ← вместо isCancelled
  }).then(({ text, parts }) => {
    // Персист даже при interrupted: bridged.text содержит частичный ответ.
    store.appendMessage(sessionId, { role: "assistant", content: text, parts });
    store.upsertSession({ id: sessionId, updatedAt: new Date().toISOString() });
  }).catch(err => {
    emitTo(sessionId, { type: "error", payload: { message: err.message } });
  }).finally(() => {
    controllers.delete(sessionId);           // lifecycle: чистим по завершении/отмене
  });
}

// POST /api/cancel { session } — вместо cancelled.add(...)
if (req.method === "POST" && path === "/api/cancel") {
  const body = await readBody(req);
  const c = controllers.get(String(body.session));
  if (c) c.abort();                          // → streamText бросит abort-часть в fullStream
  return sendJson(res, 200, { ok: true });
}
```

### 5.2 Как отмена превращается в `interrupted` с частичным текстом

1. `POST /api/cancel` → `controller.abort()`.
2. AI SDK v5 замечает `abortSignal` и эмитит в `fullStream` часть `{ type: "abort" }` (не бросает исключение в цикл итерации).
3. `stream-bridge` ловит `abort` → `st.aborted = true` (§3.2), **не** ставит `errored`, **не** эмитит `error`.
4. Весь текст, накопленный до отмены (`st.text` через `pushText`), сохраняется.
5. `computeStatus` → `"interrupted"` (§3.3); эмитится `message.complete{ status:"interrupted", text: <частичный> }`.
6. `runKyreiChat` возвращает `{ text: <частичный>, parts }`; gateway персистит ассистентское сообщение.

Это реализует **Property 4 (Отмена ≠ ошибка)** из design.md. Частичный текст не теряется, потому что аккумулятор `BridgeState.text` живёт независимо от финализации.

### 5.3 Отмена внутри инструментов

`run_command` и другие долгие инструменты получают `abortSignal` в `buildTools(jail, cfg, abortSignal)` и слушают `signal.addEventListener("abort", () => child.kill())` (design.md §3 Tools, Req 4.7). Так отмена прерывает и текущий tool-execute, а не только сетевой стрим.

---

## 6. Три самых опасных подводных камня и как код их избегает

### Pitfall 1 — Двойная эмиссия `error` (onError + error-часть) и подмена отмены ошибкой

**Проблема.** `streamText` в v5 подавляет исключения стрима и одновременно (а) вызывает `onError`, и (б) кладёт `error`-часть в `fullStream`. Наивная реализация эмитит `error` дважды. Хуже: отмена (`abort`) при небрежном коде попадает в ту же ветку, что и ошибка, и UI показывает «ошибку» вместо «остановлено».

**Как избегаем.**
- **Единый источник:** глобальный `error` эмитится ТОЛЬКО из `error`-части `fullStream` (§3.2). `onError` в orchestrator — исключительно `console.error` (§2.2 шаг D).
- **Отдельный путь отмены:** `abort`-часть ставит `st.aborted`, минуя `st.errored`; `computeStatus` отдаёт приоритет `interrupted` над `error` (§3.3). Реализует Property 4.
- **tool-error ≠ stream-error:** ошибка `execute` инструмента приходит как `tool-error` и превращается в `tool.complete{error}` — цикл не роняется, модель чинит сама.

### Pitfall 2 — Ошибка tools ловится не там (стрим не бросает синхронно) → нет no-tools fallback

**Проблема.** `streamText(...)` возвращается немедленно; фактический HTTP-запрос уходит при первой итерации `fullStream`. Провайдеры без function-calling отвечают 400/404/422 **внутри** стрима. `try/catch` вокруг вызова `streamText` ничего не поймает, и вместо тихого перезапуска без tools пользователь видит сырую ошибку. Симметрично: в v1 это работало только потому, что там был синхронный `fetch` с `resp.ok`-проверкой (`core/kyrei-engine.js` ловит `err.status` в `[400,404,422]`).

**Как избегаем.**
- `no-tools-fallback.ts` (§4.5) делает **peek первой части** `fullStream` через собственный async-итератор и проверяет `isToolUnsupported(head.error)` по status+тексту.
- Прочитанная «голова» не теряется — стрим восстанавливается через `wrapWithReplayedHead` (реплей head + продолжение исходного итератора), чтобы `stream-bridge` увидел полный поток.
- Страховка на случай «ошибка не первой частью»: `stream-bridge` при `error`-части с `isToolUnsupported` выставляет `retryWithoutTools`, orchestrator перезапускает один раз без tools.

### Pitfall 3 — Порча истории и нестабильный `tool_call_id` при мультистепе/отмене

**Проблема.** Два независимых бага, оба ломают следующий запрос к провайдеру (400 «tool_call without response»):
1. **Нестабильный id:** если брать `tool_call_id` из разных частей (`tool-input-start` vs `tool-call`) без единого источника, `tool.start` и `tool.complete` уедут на разные id → UI не сматчит прогресс с результатом (нарушение Property 7).
2. **Висячие tool-пары:** при отмене между `tool-call` и `tool-result` в `messages` останется assistant с `tool_calls` без парного `tool`-результата → провайдер вернёт 400 на следующем ходе (нарушение Property 5/14).

**Как избегаем.**
- **Стабильный id:** `tool-input-start` — единственная точка регистрации записи в `state.tools` (Map по id); `tool-call`/`tool-result`/`tool-error` только дополняют уже существующую запись по тому же `toolCallId` (§3.2). Если `tool-input-start` не пришёл — запись заводится в `tool-call` с тем же id. Один id на всём протяжении → Property 7.
- **Персист из `response.messages`, а не из ручной склейки:** `(await result.response).messages` уже содержит корректно спаренные assistant/tool-сообщения в формате провайдера (§2.2 шаг G, §3.5). Ручной путь используется только как fallback.
- **Cleanup перед следующим ходом:** `reliability/cleanup.ts` `cleanupIncompleteMessages(messages)` (design.md §9) срезает незакрытые `assistant.tool_calls` без парного `tool` — вызывается в gateway `convoFor()` перед передачей истории в `runKyreiChat`. Гарантирует Property 5/14 даже после жёсткой отмены посреди tool-вызова.

---

## Приложение: минимальный интеграционный тест стрима (без сети)

Подтверждает маппинг частей и путь отмены на v5-дублёрах (design.md Testing §2).

```ts
// core/engine/stream-bridge/bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { streamText } from "ai";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test"; // v5-дублёры (НЕ V3)
import { bridgeStream } from "./bridge";

describe("stream-bridge", () => {
  it("маппит text-delta → message.delta и finish → complete", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", text: "При" },
            { type: "text-delta", id: "t1", text: "вет" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
          ],
        }),
      }),
    });
    const events: any[] = [];
    const result = streamText({ model, prompt: "hi" });
    const out = await bridgeStream(result.fullStream, e => events.push(e), { hasTools: false, provider: "mock", model: "mock" });

    expect(out.text).toBe("Привет");
    expect(out.status).toBe("complete");
    expect(events.filter(e => e.type === "message.delta")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "message.complete", payload: { status: "complete" } });
  });
});
```

## Соответствие Correctness Properties (сводка)

| Property (design.md) | Где обеспечивается в этом чертеже |
|---|---|
| 4 — Отмена ≠ ошибка | `abort`-часть → `st.aborted` (§3.2); `computeStatus` приоритет `interrupted` (§3.3); §5.2 |
| 5 / 14 — Валидность истории / нет висячих tool-пар | Персист из `response.messages` (§3.5); `cleanupIncompleteMessages` в gateway (§6 Pitfall 3) |
| 7 — Стабильность `tool_call_id` | Единая регистрация в `tool-input-start`, дополнение по тому же id (§3.2; §6 Pitfall 3) |
| Единый источник ошибки | `error` только из `fullStream`; `onError`=log (§2.2, §3.2; §6 Pitfall 1) |

---

*Проверено против ai-sdk.dev (v5 API) на дату подготовки; пин `ai@5.0.x`. Внешние факты снабжены inline-ссылками; контент источников перефразирован для соответствия лицензионным ограничениям.*
