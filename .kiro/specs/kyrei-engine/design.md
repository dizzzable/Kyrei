# Дизайн — Движок Kyrei (kyrei-engine v2)

## Overview

Движок v2 — тонкий агентный слой поверх **AI SDK v5**, работающий локально в Node-процессе (main/gateway) Electron. Он сохраняет внешний контракт `runKyreiChat({emit, messages, ...}) → {text, parts}` (renderer и gateway не меняются), а внутри заменяет ручной SSE/loop на `streamText` + `stopWhen`, добавляет надёжный apply-движок, слоёную память, провайдер-реестр с фолбэком, безопасность и управление контекстом.

Стратегия внедрения: **strangler-fig** — v2 живёт рядом с v1 за флагом `KYREI_ENGINE=v2`, пока не пройдёт полную верификацию (Требование 1.6, 12).

Ссылки на исследование: `docs/research.md` §20 (движки), §21 (данные), §22 (память), §23 (провайдеры), §24 (harness), §25 (feature-mining), §28 (AI SDK v5).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React) — без изменений                             │
│   слушает SSE события: message.* / tool.* / reasoning.* / …  │
└───────────────▲─────────────────────────────────────────────┘
                │ SSE (/api/events) + JSON POST (/api/prompt,/api/cancel)
┌───────────────┴─────────────────────────────────────────────┐
│ gateway.js (JS, без переписывания)                           │
│   - маршрутизация, сессии, конфиг, файлы                     │
│   - AbortController на сессию (замена isCancelled polling)   │
│   - выбор движка по флагу KYREI_ENGINE                        │
└───────────────▲─────────────────────────────────────────────┘
                │ runKyreiChat({emit, messages, provider, workspace, abortSignal})
┌───────────────┴─────────────────────────────────────────────┐
│ core/engine/ (TypeScript) — НОВОЕ ЯДРО                       │
│                                                              │
│  orchestrator.ts   — runKyreiChat: streamText + stopWhen     │
│  stream-bridge.ts  — fullStream part → emit() (наш формат)   │
│  tools/            — ACI: list_dir/read_file/grep/find_path/ │
│                       edit_file/write_file/run_command/diag  │
│  apply/            — anchor apply_patch + tolerant seek + diff│
│  provider/         — registry, roles, fallback, round-robin  │
│  context/          — token-estimator, compaction, CCR store  │
│  memory/           — layered md + writer + handoff (+ ltm/)  │
│  security/         — jail(realpath), permissions, audit,     │
│                       secret-redaction, net-deny, pre-hook   │
│  reliability/      — cleanup-incomplete, goal-verifier,      │
│                       self-heal, loop-detect, snapshots      │
│  data/             — ports: SessionStore/MemoryStore/Vector  │
│                       impl: sqlite (default) / postgres (opt)│
└──────────────────────────────────────────────────────────────┘
                │ HTTP (OpenAI-compatible)
                ▼
   Локальный inference (Ollama/LM Studio/llama.cpp) ИЛИ внешний API
```

### Ключевые решения дизайна
- **Язык:** ядро `core/engine/**` — TypeScript (собирается через `tsx`/`esbuild` в один бандл, потребляемый gateway). `gateway.js`/`session-store.js` остаются JS. (Req 1.5, §28.4)
- **Транспорт:** не используем UI-протокол AI SDK; итерируем `result.fullStream` и мостим в наш `emit()` (Req 2, §28.4).
- **Провайдер:** только явный объект `createOpenAICompatible({ baseURL })` — никогда голая строка (иначе Vercel Gateway). (Req 1.1, 1.2)
- **Отмена:** `AbortController` на сессию в gateway → `abortSignal` в `streamText` и в `execute` инструментов. (Req 2.4, 9.2, §28.6)

---

## Components and Interfaces

### 1. Orchestrator (`core/engine/orchestrator.ts`)
Точка входа. Сигнатура сохранена:
```ts
export async function runKyreiChat(opts: {
  emit: (e: KyreiEvent) => void;
  messages: ModelMessage[];
  providerBase: string; apiKey: string; model: string;
  workspace?: string;
  abortSignal?: AbortSignal;
  config?: EngineConfig; // permissions, roles, limits
}): Promise<{ text: string; parts: MessagePart[] }>;
```
Логика: собрать провайдера → собрать tools (с jail) → `streamText({ model, system, messages, tools, stopWhen, abortSignal, onError, prepareStep })` → прогнать `stream-bridge` → вернуть `{text, parts}`.

`stopWhen`: `[ stepCountIs(config.maxSteps ?? 12), hasToolCall('attempt_completion')? ]` + кастомное токен-бюджет-условие.

**`prepareStep` — компакция (осторожно, Req 5):** при превышении порога возвращаем скомпактированные `messages`. КРИТИЧНО: нельзя удалять tool-call без парного tool-result (иначе провайдер вернёт 400); never-prune набор = system-prompt, определения инструментов, последние N ходов. Компакция ломает prompt-cache — поэтому запускается редко (на пороге), а не каждый шаг (баланс Req 5.2 ↔ 5.5).

**История:** `stopWhen` сам гоняет multi-step цикл; финальные сообщения для персиста берём из `(await result.response).messages` (`ModelMessage[]`), НЕ из несуществующего top-level `result.responseMessages`.

### 2. Stream Bridge (`core/engine/stream-bridge.ts`)
Чистая функция-трансформер: `for await (part of result.fullStream)` → `emit()`. Отдельно тестируется (Req 12.2, 12.8). Определяет финальный `status` (complete/interrupted/error/max_steps) для `message.complete` (Req 2.3–2.4).

**Актуальные типы частей v5 (не путать с v4):** `start`, `start-step`, `text-start`/`text-delta`/`text-end` (поле `text`), `reasoning-start`/`reasoning-delta`/`reasoning-end`, `tool-input-start`/`tool-input-delta`/`tool-input-end` (живые аргументы для `tool.start`/прогресса), `tool-call` (поле `input`), `tool-result` (поле `output`), `tool-error`, `finish-step`, `finish` (usage; на новых версиях `totalUsage`), `abort`, `error`, `raw`. Маппинг фиксируется в реализации и покрывается тестом.

**Единый источник ошибки:** `streamText` подавляет исключения И кладёт `error`-часть в поток; чтобы не эмитить `error` дважды, обрабатываем ошибку ТОЛЬКО из `fullStream` (`error`-часть), а `onError` используем лишь для логирования. `abort` обрабатывается отдельным путём → `status:"interrupted"` (не `error`).

### 3. Tools (`core/engine/tools/*`)
Каждый инструмент — `tool({ description, inputSchema: z…, execute })`, `execute` возвращает единый контракт:
```ts
interface ToolResult { title: string; output: string; metadata?: Record<string, unknown>; }
```
- Тела `execute` содержат нашу доменную логику + jail. Ошибки → `tool-error` (не бросаем). (Req 4.2, 4.3, 4.6)
- `read_file` — диапазоны строк; усечение head+tail с маркером (Req 4.4).
- `grep_search` — ripgrep (bundled `@vscode/ripgrep` или системный) с фолбэком.
- `run_command` — bg-process manager (start→id/inc-output/kill), слушает `abortSignal` → `child.kill()` (Req 4.7).
- `batch` — параллельный вызов read-only инструментов, partial-success (Req 4.5).

### 4. Apply-движок (`core/engine/apply/*`)
- `parse-patch.ts` — парсер контекст-якорного формата (стиль codex `*** Update File / @@ / -/+`), lenient (heredoc/мусор) (Req 3.1, 3.6).
- `seek.ts` — `seekSequence(haystackLines, needleLines)` с 4 уровнями строгости (exact → trim trailing → trim all → Unicode-normalize) (Req 3.2).
- `apply.ts` — применяет хунки; при >1 совпадении якоря — reject с actionable-ошибкой (Req 3.3).
- `diff.ts` — построчный LCS-дифф для `inline_diff` + счётчик `+N −M` (Req 3.4). (Переносим существующий `lineDiff`.)
- `snapshot.ts` — обратимый снапшот перед правкой (git stash-подобно или копия в `.kyrei/snapshots/`) (Req 3.7).

### 5. Provider (`core/engine/provider/*`)
- `registry.ts` — реестр моделей `{id, provider, limits, cost, caps}`; `resolve(role|id)`.
- `build.ts` — `createOpenAICompatible({ name, baseURL, apiKey, headers, includeUsage:true })`.
- `fallback.ts` — цепочка провайдеров/моделей; reactive (на ошибке/429/5xx) + proactive; backoff. (Req 7.3)
- `keys.ts` — round-robin ключей + session-affinity + circuit-breaker/cooldown; хранение в keychain/AES (Req 7.4, 7.6).
- `no-tools-fallback.ts` — при 400/404/422 на tools перезапуск без `tools` (Req 7.5, §28.7).

### 6. Context (`core/engine/context/*`)
- `tokens.ts` — двойная оценка: локальный estimator (`gpt-tokenizer`/эвристика) + `usage` провайдера. `isOverflow()` (Req 5.1).
- `compaction.ts` — 2 фазы: `pruneToolOutputs()` (пороги) → `summarize()` (LLM, помечает точку) (Req 5.2); ранние чекпоинты 20/45/70% (Req 5.3).
- `ccr.ts` — обратимое сжатие: оригинал в дисковый store по хешу; инструмент `retrieve(hash)` (Req 5.4).
- `rebuild.ts` — пересборка из seed с bounded per-section (Req 5.6).
- Интеграция через `prepareStep` (§28.2): при overflow вернуть скомпактированные `messages`.

### 7. Memory (`core/engine/memory/*`)
- `layers.ts` — session checkpoint → project (`MEMORY.md`/`AGENTS.md`/steering) → global; markdown = SoT, SQLite/vec = индекс (Req 6.1, 6.2).
- `writer.ts` — writer-роль (отдельный шаг), single-writer, enforced write-paths; главный агент пишет только в `notes.md`-scratch (Req 6.3).
- `handoff.ts` — distilled handoff-артефакт + старт чистого окна (Req 6.4).
- `ltm-bridge.ts` — интеграция с существующим `ltm/` (Req 6.5).
- `consolidate.ts` — idle-консолидация с held-out validation-gate + bounded edits (Req 6.6).

### 8. Security (`core/engine/security/*`)
- `jail.ts` — `safePath(workspace, target)` через `realpath` + `relative`; на все инструменты (Req 8.1). (Расширяем текущий `safePath` резолвом симлинков.)
- `permissions.ts` — allow/ask/deny + двухосевая автономия (terminal × review) (Req 8.2, 8.3).
- `net.ts` — network default-deny для команд + allowlist (Req 8.4).
- `audit.ts` — лог каждого вызова (Req 8.5).
- `secrets.ts` — редакция значений секретов, детект чувствительных файлов (Req 8.6).
- `pre-hook.ts` — pre-tool-use gate (блок/скан) (Req 8.7).

### 9. Reliability (`core/engine/reliability/*`)
- `cleanup.ts` — `cleanupIncompleteMessages(messages)`: срезать assistant tool_calls без tool-результатов (Req 9.2).
- `goal-verifier.ts` — независимая проверка end-state перед «done» (Req 9.3).
- `self-heal.ts` — probe→retry → fix → handoff, лимит попыток (Req 9.4).
- `loop-detect.ts` — детект повторов/зацикливания (Req 9.1).
- `verify.ts` — evidence-gated: авто-детект сборки/тестов/линта, прогон, ошибки → в цикл (Req 9.5).

### 10. Data (`core/engine/data/*`)
- Порты: `SessionStore`, `MemoryStore`, `VectorStore` (Req 10.3).
- `sqlite/` — impl по умолчанию (better-sqlite3 или node:sqlite; WAL; sqlite-vec; FTS5); тяжёлое — в worker (Req 10.1, 10.5).
- `postgres/` — опциональная impl (pg + pgvector) за тем же портом (Req 10.4).
- JSONL-транскрипт — SoT, SQLite поверх (Req 10.2).

---

## Data Models

### KyreiEvent (контракт с gateway/renderer — сохранён)
```ts
type KyreiEvent =
  | { type: 'message.start' }
  | { type: 'message.delta';    payload: { text: string } }
  | { type: 'reasoning.delta';  payload: { text: string } }
  | { type: 'tool.start';       payload: { tool_call_id: string; name: string; args: unknown } }
  | { type: 'tool.progress';    payload: { tool_call_id: string; text: string } }
  | { type: 'tool.complete';    payload: { tool_call_id: string; name: string; result?: string;
                                           inline_diff?: string; error?: string; duration_s: number } }
  | { type: 'status.update';    payload: { model?: string; provider?: string; usage?: Usage } }
  | { type: 'approval.request';  payload: { approval_id: string; tool_call_id: string; name: string; args: unknown; reason: string } }
  | { type: 'message.complete'; payload: { text: string; status: 'complete'|'interrupted'|'error'|'max_steps'; usage?: Usage } }
  | { type: 'error';            payload: { message: string } };
// Ответ на approval приходит с renderer через gateway (POST /api/approval): { approval_id, decision: 'approve'|'deny', scope?: 'once'|'session'|'always' }
```

### MessagePart (персист — совместим с текущим)
```ts
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; toolCallId: string; name: string; args?: unknown; result?: string;
      inlineDiff?: string; error?: string; running: boolean; durationS?: number };
```

### EngineConfig
```ts
interface EngineConfig {
  maxSteps: number;               // деф. 12
  commandTimeoutMs: number;       // деф. 60000
  maxToolOutput: number;          // деф. 12000
  contextBudget: { softPct: number; hardPct: number };
  permissions: { terminal: 'off'|'auto'|'turbo'; review: 'always'|'agent'|'request';
                 rules: Array<{ pattern: string; action: 'allow'|'ask'|'deny' }> };
  providerRoles: Record<'default'|'small'|'plan', string>;  // id в реестре
  fallbackChain: string[];
}
```

### PatchHunk (apply-движок)
```ts
interface PatchHunk { file: string; context: string[]; remove: string[]; add: string[]; }
```

---

## Correctness Properties

Инварианты, которые проверяются тестами (см. Testing Strategy) и должны выполняться всегда.

### Property 1: Jail-инвариант
Для любого входного пути результат `safePath(workspace, p)` либо находится внутри `workspace` (после резолва симлинков), либо операция отклоняется — никогда путь снаружи.

**Validates: Requirements 8.1**

### Property 2: Уникальность якоря
`apply` применяет хунк только при ровно одном совпадении якоря; при 0 или >1 совпадениях — reject без изменения файла.

**Validates: Requirements 3.3**

### Property 3: Обратимость правки
После любой правки существует снапшот, восстановление которого возвращает файл к предыдущему состоянию.

**Validates: Requirements 3.7**

### Property 4: Отмена ≠ ошибка
Отменённый ход завершается `status:"interrupted"` и не эмитит событие `error`.

**Validates: Requirements 2.4**

### Property 5: Валидность истории
После отмены/сбоя в `messages` не остаётся assistant-сообщений с `tool_calls` без соответствующих tool-результатов.

**Validates: Requirements 9.2**

### Property 6: Отсутствие безвозвратной потери
Любой скомпактированный/вытесненный фрагмент восстановим по идентификатору (CCR).

**Validates: Requirements 5.4**

### Property 7: Стабильность tool_call_id
Идентификатор одного вызова инструмента одинаков в `tool.start` и `tool.complete`.

**Validates: Requirements 2.2**

### Property 8: Секрет-гигиена
Значения секретов не попадают в контекст модели, логи и события.

**Validates: Requirements 8.6**

### Property 9: Сохранность стиля строк и BOM
Запись файла сохраняет исходные EOL (LF/CRLF/mixed), наличие/отсутствие финального перевода строки и BOM; нормализация применяется только для сопоставления, не для записываемых байтов.

**Validates: Requirements 3.8, 3.9**

### Property 10: Reject ≠ порча
При отказе применить правку (0 или >1 совпадений, no-op, бинарный файл) файл остаётся байт-в-байт неизменным.

**Validates: Requirements 3.12, 3.13, 3.14**

### Property 11: Транзакционность мультифайловой правки
Мультифайловая правка применяется целиком либо откатывается полностью (по снапшоту); промежуточных частично-применённых состояний не остаётся.

**Validates: Requirements 3.11, 3.15**

### Property 12: Windows-jail
На Windows `safePath` корректно отклоняет обход через UNC (`\\server\share`), `\\?\`, junction/reparse-точки, drive-relative (`C:rel`) и регистронезависимость NTFS.

**Validates: Requirements 8.1**

### Property 13: Секрет-редакция во всех каналах
Внедрённый секрет не встречается ни в одном из каналов вывода (чтение файла, stdout, `inline_diff`, аудит, событие, персист); имя ключа может остаться.

**Validates: Requirements 8.10**

### Property 14: Отсутствие висячих tool-пар
После отмены/сбоя в любой момент `cleanupIncomplete(messages)` даёт историю без assistant-сообщений с `tool_calls` без парного tool-result.

**Validates: Requirements 9.2**

## Error Handling

| Класс | Стратегия |
|---|---|
| Ошибка `execute` инструмента | превратить в `tool-error` → модель видит и чинит (не ронять цикл) (Req 4.6) |
| Провайдер не умеет tools (400/404/422) | `no-tools-fallback`: перезапуск `streamText` без `tools` (Req 7.5) |
| Провайдер недоступен/429/5xx | fallback-цепочка + backoff + circuit-breaker (Req 7.3, 7.4) |
| Неполный `usage` от провайдера | `includeUsage:true`; при крахе ретрая — `maxRetries:1` для флэки (§28.7) |
| Ошибка стрима (нефатальная) | `onError` + `error`-часть → `emit error`, продолжить где можно (Req 2.6) |
| Отмена пользователем | `abort` → `message.complete{status:interrupted}`, НЕ `error` (Req 2.4) |
| Якорь правки не уникален | reject с actionable-сообщением «дай больше контекста» (Req 3.3) |
| Выход за jail | throw до исполнения, `tool-error` (Req 8.1) |
| Висячие tool_calls после сбоя | `cleanupIncompleteMessages` перед следующим запросом (Req 9.2) |
| Зацикливание | `loop-detect` → стоп с диагностикой (Req 9.1) |

Принцип: модели возвращаем **actionable-текст**, не сырой traceback; отмена — отдельный путь от ошибки.

---

## Testing Strategy

Раннер: **Vitest** (TS-native, быстрый, `--run` для single-shot). Тесты в `core/engine/**/*.test.ts` + `tests/`.

### Уровни
1. **Unit (чистые функции):** seek (4 уровня), parse-patch (в т.ч. lenient/грязный ввод), apply (уникальность якоря), diff, tokens.estimate, safePath/jail, compaction.prune, cleanupIncompleteMessages, provider.registry.resolve, fallback-выбор. (Req 12.1)
2. **Integration (цикл с mock-провайдером):** локальный fake OpenAI-compatible SSE-сервер отдаёт заготовленные чанки; проверяем: стрим `message.delta`, multi-step tools (2 хода), `tool.start/complete` с стабильным id, отмена→interrupted, fallback-без-tools, usage в complete. (Req 12.2)
3. **Property-based (`fast-check`):**
   - apply: для случайного файла и случайной серии правок — применение даёт ожидаемый результат; повторное применение идемпотентно/reject.
   - jail: для любого сгенерированного пути результат `safePath` либо внутри workspace, либо throw (никогда снаружи). (Req 12.3, 12.7)
4. **Provider-matrix:** прогон против mock + (опц., если доступно локально) Ollama; проверка стрим/tools/cancel/usage. CI-safe через mock по умолчанию. (Req 12.4)
5. **Eval-харнесс (`tests/eval/`):** небольшой набор кодинг-задач (создать файл, точечная правка, многофайловая правка, багфикс) в temp-workspace; метрики: успех, число шагов, токены; сравнение v1 vs v2 и между версиями. (Req 12.5)
6. **Security-тесты:** jail-escape (симлинк/`..`/абсолют), network-deny команды, секрет-редакция, approval-gate блокирует разрушительное. (Req 12.7)
7. **Verification-gate CI:** сборка + `tsc --noEmit` + `node --check` (JS) + `vitest --run` — зелёное до мержа. (Req 12.6)

### Правила окружения
- Не запускать dev-серверы в тестах; провайдер — mock (без сети) по умолчанию.
- Property-тесты помечаем предупреждением при запуске (могут быть долгими).
- Каждый тест-workspace — во временной папке, чистится после.

---

## Порядок реализации (соответствие фазам §28.9)

1. Фаза 0 — deps + TS-сборка одного бандла; каркас `core/engine/` + порты.
2. Фаза 1 — orchestrator + stream-bridge + перенос текущих 4 инструментов в `tool()`; флаг `KYREI_ENGINE=v2`; паритет с v1 (те же события) + тесты 12.1–12.2.
3. Фаза 2 — AbortController в gateway; apply-движок (anchor+seek+snapshot) + `edit_file`; property-тесты apply/jail.
4. Фаза 3 — provider-registry + fallback + no-tools-fallback + Ollama-дефолт; provider-matrix.
5. Фаза 4 — context (tokens+compaction+CCR) + prepareStep; reliability (cleanup/goal-verifier/verify).
6. Фаза 5 — memory (layers+writer+handoff+ltm) + data-порты (sqlite default).
7. Фаза 6 — security (permissions/net-deny/audit/secrets/pre-hook) + оркестрация (read-рой/ревьюер/plan-as-files).
8. Фаза 7 — eval-харнесс, доведение по метрикам, включение v2 по умолчанию, удаление транспортного кода v1.

Каждая фаза завершается verification-gate (сборка+тесты зелёные).

---

## Honest Limits (что НЕ гарантируем без OS-песочницы)

По итогам security-ревью три вещи невозможно гарантировать в чистом Node/Electron без OS-sandbox — формулируем честно:

- **Сдерживание содержимого `run_command`.** Мы джейлим CWD команды и применяем deny-list + approval, но сама команда может использовать абсолютные пути, `cd`, пайпы. Полная изоляция — только через опциональный контейнер/OS-sandbox (Landlock/seccomp/Seatbelt/Job Object). По умолчанию: CWD-ограничение + deny-list + approval + документированный остаточный риск.
- **Network default-deny для команд.** В Node `child_process` сеть не блокируется без OS-механизма. Реализуем best-effort (очистка proxy-env, предупреждение), для строгого режима — контейнер. UI явно сообщает уровень изоляции.
- **Атомарный TOCTOU-джейл.** Между `realpath`-проверкой и операцией возможна подмена симлинка. Митигация: `O_NOFOLLOW`/`lstat` при открытии, повторная проверка, но абсолютной гарантии нет.

Принцип: обещаем ровно то, что обеспечиваем; остальное — документированный остаточный риск + опциональный строгий режим (контейнер) в бэклоге (задача 19.2).

## Token Estimation & Usage

- Токенайзер выбирается пер-провайдер/модель: OpenAI — o200k/cl100k (`gpt-tokenizer`); Claude — локального нет, используем калиброванную эвристику с запасом (~+10–15%); локальные (Llama и т.п.) — эвристика/модельный токенайзер, где доступен.
- Для потокового `usage` OpenAI-совместимых провайдеров включаем `stream_options.include_usage` (иначе `usage=null` и авто-компакция не сработает). Обрабатываем полный/частичный/отсутствующий usage; при отсутствии — опираемся на локальную оценку.
- Двойной триггер: `max(localEstimate, providerUsage) ≥ softPct·window` → компакция.

## Memory layout, дедуп с ltm/, handoff

- Файловый layout: `.kyrei/` в workspace — `memory/MEMORY.md` (проект), `memory/notes.md` (scratch главного агента), `snapshots/` (обратимые снапшоты), `handoff/handoff-<id>.md`. Глобальный слой — в userData.
- **Дедуп с существующим `ltm/`:** НЕ создавать второй параллельный JSONL. Движок пишет через `ltm-bridge`, используя `ltm/`-стор как единый журнал событий/чекпоинтов; `MEMORY.md`-слой — это проекция/семантическая память поверх, не дубль ledger. Один writer на каждый структурный файл; кросс-процессная запись сериализуется через файловый lock.
- **Handoff-артефакт (схема):** `{ intent, done, next_actions[], key_files[], decisions[], open_questions[], constraints }` (md с YAML-фронтматтером). Триггер: приближение к пределу окна ИЛИ завершение фазы плана. Новое окно стартует, читая handoff + план-файлы, а не историю чата.

## Data Layer — конкретика

- **Драйвер:** предпочесть **`node:sqlite`** (встроен в Node ≥ 22, без node-gyp/electron-rebuild — снимает боль упаковки под 3 ОС). Если версия Node в Electron не покрывает нужный API — fallback на `better-sqlite3` с `electron-rebuild` per-OS/ABI в CI.
- **sqlite-vec:** loadable-расширение; в упакованном приложении класть вне `app.asar` (`asarUnpack`) и грузить по абсолютному распакованному пути. Проверить совместимость с выбранным драйвером smoke-тестом на 3 ОС.
- **Concurrency:** WAL + **единственное соединение-писатель** (в gateway/worker процессе); остальные — read-only. Защита от `SQLITE_BUSY` (busy_timeout + сериализация записи).
- **SoT↔индекс:** JSONL-транскрипт — source of truth; SQLite/FTS5/vec — производный индекс, пересобираемый из JSONL (команда rebuild) при рассинхроне.
- **Тяжёлое** (bulk-embedding, миграции, векторный full-scan) — в `worker_threads`.

## Eval Harness

Task-set (`tests/eval/tasks/*`, temp-workspace + машинный oracle):
- **E1 create-file** → oracle: файл существует + содержит маркеры.
- **E2 point-edit** (300-строчный файл) → oracle: целевой diff, компиляция ок.
- **E3 multi-file** (rename symbol в 3 файлах) → oracle: grep старого имени = 0, tsc зелёный.
- **E4 bugfix** (упавший unit-тест) → oracle: конкретный тест зелёный.
- **E5 explore-then-edit** (grep → правка) → oracle: тест зелёный.
- **E6 refuse/jail** (задача требует выйти за workspace) → oracle: отказ, файл вне не тронут.

Метрики на задачу: `edit_success` (bool, главная), `steps`, `tokens` (из usage), `wall_time_ms`, `tool_error_rate`.
Режимы: **CI-gate** — recorded responses (replay через кастомный `fetch`/`mockValues`), флейки=0, порог = не ниже baseline; **nightly** — фиксированная локальная модель Ollama (`temperature:0`, seed), 3 прогона, медиана (метрики качества, не gate).
Baseline: `tests/eval/baseline.json` (метрики v1 и v2, обновляется явным PR). Регресс v2<v1: fail при падении `edit_success` или росте steps/tokens > 20%. Anti-flakiness: изолированный temp-workspace, сеть заблокирована, `TZ=UTC`, `LANG=C`, стабильный PATH.

## Verification Gate (команды)

`package.json` scripts (кроссплатформенно; Windows-cmd не раскрывает глоб — обход через node-скрипт):
- `typecheck`: `tsc --noEmit -p core/engine/tsconfig.json`
- `check:js`: `node scripts/check-js.mjs` (рекурсивный `node --check` по `*.js`)
- `test`: `vitest --run`
- `test:pbt`: `vitest --run tests/pbt --testTimeout=30000`
- `lint`: `eslint . --max-warnings=0`
- `gate`: `typecheck && check:js && lint && test`

Pre-commit (husky/lint-staged): typecheck + related vitest.
CI matrix: `os: [windows-latest, macos-latest, ubuntu-latest]` × `engine: [v1, v2]`; шаги: setup-node → `npm ci` → (если better-sqlite3) electron-rebuild → `gate` → `test:pbt` → (Win-only) jail Windows-path тест.

## Cross-platform Packaging

- **sqlite:** `node:sqlite` предпочтительно (no native); иначе electron-rebuild per-OS/ABI + smoke открытия БД на 3 ОС.
- **ripgrep:** bundling `@vscode/ripgrep` бинарей per-OS + детект системного rg fallback + smoke на 3 ОС.
- **EOL в тестах:** `.gitattributes` → `tests/fixtures/** -text` (запрет autocrlf), иначе apply/seek/diff-тесты падают только на Windows.
- **run_command:** kill дерева — Windows `taskkill /PID <pid> /T /F`, POSIX — kill process group; таймаут кроссплатформенный.

## Reliability — уточнения

- **cleanupIncomplete(messages):** идти с конца; удалить незакрытые `assistant.tool_calls` без парного `tool`-сообщения (и осиротевшие `tool`-сообщения); сохранить формат провайдера.
- **loop-detect:** окно последних K шагов; срабатывает при повторе идентичных (tool_name+args) вызовов ИЛИ отсутствии изменения файлов/прогресса N раз подряд (не по счётчику шагов).
- **goal-verifier:** вызывается ТОЛЬКО при попытке завершения в автономном режиме; дешёвая модель (роль small); анти-рекурсия — не может сам вызывать инструменты.
- **verify (evidence-gated):** авто-детект экосистемы (package.json/pyproject/Cargo…) → прогон build/test/lint с таймаутом; flaky-тесты — ретрай ≤1 + пометка, не бесконечно.
- **self-heal FSM:** `probe → retry(1) → fix-spec+retry(1) → handoff человеку`; лимит фиксирован в EngineConfig.

---

## Implementation Blueprints

Детальные turnkey-чертежи ядра (сигнатуры, псевдокод, алгоритмы, DDL) — в этой же папке:

- `blueprint-orchestrator-provider.md` — orchestrator (`runKyreiChat`), stream-bridge (`fullStream`→события), provider layer (registry/build/fallback/no-tools/keys), abort wiring.
- `blueprint-apply-engine.md` — грамматика патча, `seek` (4 уровня + Unicode-набор), `apply` (EOL/BOM/атомарность/транзакционность), snapshot, diff, инструменты, Windows-специфика.
- `blueprint-context-memory-data.md` — драйвер SQLite (better-sqlite3 ship / node:sqlite roadmap), DDL + FTS5 + vec0, порты, токен-оценка, компакция, CCR, слоёная память + ltm-bridge + handoff, worker.
- `blueprint-security-reliability-testing.md` — jail-алгоритм (Windows), permissions, secrets, audit, cleanup/loop-detect/goal-verifier/verify/self-heal, тест-каркас (ai/test, fast-check, CI-matrix).

Пин версий: `ai@5.0.x` (не бампать до v6 без миграции имён), `@ai-sdk/openai-compatible@1.0.x`, драйвер SQLite = `better-sqlite3` (ship) за портом `SqliteDriver`, `node:sqlite` — roadmap.
