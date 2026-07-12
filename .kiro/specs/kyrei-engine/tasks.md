# Implementation Plan: Движок Kyrei (kyrei-engine v2)

## Overview

Стратегия: strangler-fig за флагом `KYREI_ENGINE=v2`; старый движок жив до Фазы 7. Каждая фаза
завершается verification-gate (сборка + `tsc --noEmit` + `node --check` + `vitest --run` = зелёное).
Ссылки `_Требования: N.M_` указывают на requirements.md.

## Tasks

### Фаза 0 — Каркас и зависимости

- [x] 1. Настроить TS-сборку ядра и зависимости
  - Добавить зависимости с ТОЧНЫМ пином (не `^`): `ai@5.0.x` (не бампать до v6 без миграции имён — v6 переименует `stepCountIs→isStepCount`, `MockLanguageModelV2→V3`), `@ai-sdk/openai-compatible@1.0.x`, `zod@3.23.x`, `vitest`, `fast-check`, `@vscode/ripgrep@1.15.x`, `fast-glob`, `gpt-tokenizer`; комментарий в package.json про v6-ренейминги
  - Настроить `tsx`/`esbuild` сборку `core/engine/**` в один бандл, потребляемый `gateway.js`; `tsconfig` для `core/engine`
  - Проверить, что бандл включается в electron-builder пакет (Win/macOS/Linux); `asarUnpack` для `@vscode/ripgrep` и sqlite-vec
  - _Требования: 1.4_

- [x] 2. Создать скелет `core/engine/` и port-интерфейсы
  - Папки: `orchestrator`, `stream-bridge`, `tools`, `apply`, `provider`, `context`, `memory`, `security`, `reliability`, `data`
  - Типы: `KyreiEvent`, `MessagePart`, `EngineConfig`, `ToolResult`, `PatchHunk` (из design.md)
  - Порт-интерфейсы `SessionStore`/`MemoryStore`/`VectorStore` (пока заглушки поверх текущего JSON-store)
  - _Требования: 1.5, 10.3_

- [x] 2.5. Спроектировать system-prompt и tool-descriptions (версионируемо)
  - `core/engine/prompt/`: `system.ts`, описания инструментов; prompt-changelog; snapshot-тест промпта
  - Это прямой драйвер eval-метрик — закладываем с начала
  - _Требования: 4.2, 13.1_

- [x] 2.6. Config schema (Zod) + проводка из настроек UI/gateway в `EngineConfig`
  - Валидация, дефолты, миграция; permissions/roles/fallbackChain из UI в движок
  - _Требования: 7.2, 8.2_

### Фаза 1 — Ядро цикла (паритет с v1)

- [x] 3. Реализовать orchestrator на `streamText`
  - `runKyreiChat(opts)` с сохранённой сигнатурой и возвратом `{text, parts}`
  - Провайдер через `createOpenAICompatible({ baseURL })` — только явный объект, никогда голая строка
  - `stopWhen: stepCountIs(config.maxSteps)`, `abortSignal`, `onError`, `maxRetries`
  - История из `(await result.response).messages` (не `result.responseMessages`)
  - Путь «нет API-ключа» — прежнее guidance-сообщение
  - _Требования: 1.1, 1.2, 1.3, 1.5_

- [x] 4. Реализовать stream-bridge (fullStream → emit)
  - Трансляция актуальных v5-частей: `text-*`, `reasoning-*`, `tool-input-*`, `tool-call`(input)/`tool-result`(output)/`tool-error`, `start-step`/`finish-step`/`finish`(usage), `abort`, `error`
  - Единый источник ошибки (только `error`-часть, `onError` — лог); `abort` → `interrupted`
  - Стабильный `tool_call_id`; сборка `parts` для персиста
  - _Требования: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 4.5. Маппинг сообщений ↔ персист + гидратация
  - `ModelMessage`/`response.messages` ↔ `MessagePart` ↔ session-store; `cleanupIncomplete` при загрузке истории
  - _Требования: 1.5, 9.2_

- [x] 5. Перенести текущие 4 инструмента в `tool()` + Zod
  - `list_dir`, `read_file` (диапазоны + head/tail усечение с маркером по codepoint), `write_file` (+ `inline_diff` через metadata), `run_command`
  - Единый контракт `{title, output, metadata}`; ошибки → `tool-error` (не бросать)
  - Тела `execute` = текущий `executeTool` + `safePath`
  - _Требования: 4.1, 4.2, 4.3, 4.4, 4.6, 4.8, 4.9_

- [x] 6. Включить движок за флагом и проверить паритет
  - В `gateway.js` выбор движка по `KYREI_ENGINE=v2` (v1 по умолчанию)
  - Ручной smoke: чат, tools, дифф видны, история гидратируется
  - _Требования: 1.6_

- [x]* 6.1 Integration-тесты на штатных `ai/test`-утилитах
  - `MockLanguageModelV2` + `simulateReadableStream` (без сети/сервера): стрим text/reasoning, multi-step (≥2 хода), tool lifecycle, usage, детерминированная отмена (fake timers) → `interrupted`
  - Отдельный provider-contract тест: `createOpenAICompatible({ baseURL, fetch })` с recorded fixtures — usage-матрица (полный/частичный/нет), no-tools-fallback на 400/404/422
  - No-egress/telemetry-off enforcement: перехват глобального `fetch`/`http` — доказать, что сеть идёт ТОЛЬКО на сконфигурированный `baseURL`, телеметрия выключена, обращений к Vercel Gateway нет
  - _Требования: 12.1, 12.2, 12.8, 1.3_

- [x]* 6.2 Unit-тесты stream-bridge
  - part→event для всех типов; частичные `tool-input-delta` (фрагментированные args); `reasoning-delta`; read_file усечение
  - _Требования: 2.1, 2.2_

### Фаза 2 — Надёжный apply-движок

- [x] 7. Реализовать парсер контекст-якорного патча
  - `parse-patch.ts`: формат `*** Update/Add/Delete File`, `@@`-якоря, `-/+`; lenient (heredoc/лишние пробелы)
  - _Требования: 3.1, 3.6_

- [x] 8. Реализовать толерантный seek + apply
  - `seek.ts`: 4 уровня (exact → trim trailing → trim all → Unicode-normalize с фикс-списком: en/em-dash, smart quotes, nbsp, zero-width, NFC) — нормализация ТОЛЬКО для сравнения
  - `apply.ts`: применение хунков; reject при 0/неуникальном якоре с actionable-ошибкой; сохранение EOL/BOM/EOF-newline; add/delete/move-file; транзакционная мультифайловая правка; атомарная запись (temp+rename); refuse бинарных; reject no-op
  - `diff.ts`: перенести LCS-дифф → `inline_diff` + счётчик `+N −M` (new/modified/deleted)
  - `snapshot.ts`: обратимый снапшот (git если repo, иначе копия в `.kyrei/snapshots/`) + retention/GC + restore
  - _Требования: 3.2, 3.3, 3.4, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15_

- [x] 9. Добавить инструмент `edit_file` (точечная правка) + разнести с `write_file`
  - `edit_file` использует apply-движок; `write_file` — перезапись <~400 строк
  - _Требования: 3.5, 4.1_

- [x] 10. Перевести отмену на AbortController
  - В gateway: `Map<session, AbortController>`; `/api/prompt` создаёт, `/api/cancel` → `abort()`
  - `run_command.execute` слушает `abortSignal` → `child.kill()`
  - Совместимость с v1 (читать `signal.aborted` как `isCancelled`)
  - _Требования: 2.4, 9.2_

- [x]* 10.1 Property-based тесты apply + jail
  - `fast-check` (фикс `seed`, `numRuns=1000`, границы времени): свойства уникальности якоря, обратимости, reject≠порча, сохранности EOL/BOM; матрица LF+CRLF; jail не выпускает за папку
  - Windows-пути в jail-генераторе: `..\\`, `\\?\`, UNC, drive-relative, регистр
  - _Требования: 12.3, 12.7, 12.9_

### Фаза 3 — Провайдеры и маршрутизация

- [x] 11. Реестр моделей и роли
  - `registry.ts`: `{id, provider, limits, cost, caps}`; `resolve(role|id)`; роли default/small/plan
  - _Требования: 7.1, 7.2_

- [x] 12. Fallback, ключи, no-tools-fallback
  - `fallback.ts`: цепочка + backoff (reactive/proactive); `keys.ts`: round-robin + session-affinity + circuit-breaker; хранение в keychain/AES
  - `no-tools-fallback.ts`: 400/404/422 на tools → перезапуск без tools (peek первой части `fullStream`, реплей head)
  - Только легальные API/OAuth (никакого browser-bridging); `stream_options.include_usage`
  - _Требования: 7.3, 7.4, 7.5, 7.6, 7.7, 7.9_

- [x] 13. Ollama как локальный дефолт
  - Автодетект `localhost:11434/v1`; настройки провайдера в UI (base/model/ключ) остаются
  - _Требования: 1.2_

- [x]* 13.1 Provider-matrix тесты
  - Mock + (опц.) локальный Ollama: стрим/tools/cancel/usage/fallback-без-tools
  - _Требования: 12.4_

### Фаза 4 — Контекст и надёжность цикла

- [x] 14. Токен-бюджет и двухфазная компакция
  - `tokens.ts`: локальный estimator (per-provider o200k/cl100k + эвристика для Claude/локальных) + `usage`; `isOverflow()`
  - `compaction.ts`: prune tool-outputs → LLM-summary; ранние чекпоинты 20/45/70%
  - Подключить через `prepareStep`; стабильный префикс для prompt-cache
  - _Требования: 5.1, 5.2, 5.3, 5.5, 7.8_

- [x] 15. CCR (обратимое сжатие) + rebuild
  - `ccr.ts`: дисковый store оригиналов по хешу + инструмент `retrieve(hash)`
  - `rebuild.ts`: пересборка из seed с bounded per-section
  - _Требования: 5.4, 5.6_

- [x] 16. Надёжность: cleanup, goal-verifier, verify, loop-detect
  - `cleanup.ts`: срез висячих tool_calls; `goal-verifier.ts`: независимая проверка end-state
  - `verify.ts`: авто-детект сборки/тестов/линта + прогон (evidence-gated); `loop-detect.ts`
  - `self-heal.ts`: probe→retry→fix→handoff, лимит попыток
  - `budget.ts`: лимиты токенов/стоимости/суб-агентов/таймаутов, runaway-стоп
  - _Требования: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

- [x]* 16.1 Тесты контекста и надёжности (закрыть дыру Фазы 4)
  - compaction-пороги 20/45/70% и never-prune набор; CCR round-trip (Property 6); loop-detect без ложных срабатываний; goal-verifier; rebuild bounded
  - _Требования: 12.1, 5.2, 5.4, 9.1_

### Фаза 5 — Память и слой данных

- [x] 17. Слоёная память + writer + handoff
  - `layers.ts`: session→project(`MEMORY.md`/`AGENTS.md`/steering)→global; md=SoT, индекс=SQLite/vec
  - `writer.ts`: writer-роль, single-writer, enforced write-paths; `handoff.ts`: distilled artifact + чистое окно
  - `ltm-bridge.ts`: интеграция с `ltm/`; `consolidate.ts`: idle + held-out gate + bounded edits
  - _Требования: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 18. Слой данных SQLite (default) за портами
  - `sqlite/`: WAL + sqlite-vec + FTS5; JSONL-транскрипт SoT; тяжёлое в worker
  - `postgres/`: заглушка impl за тем же портом (контракт-тесты)
  - _Требования: 10.1, 10.2, 10.4, 10.5_

- [x]* 18.1 Контракт-тесты порта данных
  - Одни и те же тесты против sqlite (и опц. postgres): CRUD сессий/памяти/векторов
  - _Требования: 10.3_

### Фаза 6 — Безопасность и оркестрация

- [x] 19. Безопасность исполнения
  - `jail.ts`: `safePath` с `realpath` + `O_NOFOLLOW`/`lstat` (TOCTOU-митигация) + Windows-пути (UNC/`\\?\`/junction/drive-relative/регистр); честный контракт для `run_command` (CWD + deny-list + approval)
  - `permissions.ts`: allow/ask/deny (deny-wins precedence) + двухосевая автономия; approval через события `approval.request` + POST `/api/approval`; персист грантов (once/session/always)
  - `secrets.ts`: редакция значений во ВСЕХ каналах (чтение/stdout/`inline_diff`/аудит/событие/персист); очищенный env для `run_command`
  - `audit.ts`: лог вызовов вне jail (userData), с редакцией, ротация; `pre-hook.ts`: gate (fail-closed, анти-рекурсия)
  - `untrusted.ts`: пометка контента файлов/вывода/памяти как недоверенного (анти prompt-injection)
  - _Требования: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11_

- [x] 19.1. OS-sandbox port для строгого режима
  - Порт `Sandbox` + опциональная реализация через контейнер/OS-примитивы (Landlock/seccomp/Seatbelt/Job Object) для сетевой/командной изоляции; по умолчанию off, документированный остаточный риск
  - _Требования: 8.4 (honest limits)_

- [x] 20. Инструменты чтения/поиска + batch + bg-process
  - `grep_search` (ripgrep+fallback), `find_path` (glob), `diagnostics` (если LSP), `batch` (partial-success), фоновые команды + kill дерева процессов
  - _Требования: 4.1, 4.5, 4.7, 4.9, 4.10, 4.11_

- [x] 21. Оркестрация: read-рой + ревьюер + plan-as-files
  - Один писатель; read-рой суб-агентов с изолированным контекстом → саммари; ревьюер с чистым контекстом (дифф)
  - План как файлы (`ROADMAP/STATE/phase-N`), адаптивные фазы, end-state; schema-validated результат суб-агента; запрет ре-делегации исполнителю
  - _Требования: 11.1, 11.2, 11.3, 11.4, 11.5_

- [x]* 21.1 Security-тесты
  - jail-escape (симлинк/`..`/абсолют/Windows UNC/`\\?\`/junction), network-deny (в пределах honest limits), секрет-редакция во всех каналах, approval-gate на разрушительное, prompt-injection из недоверенного контента
  - _Требования: 12.7_

### Фаза 7 — Eval, доведение до идеала, дефолт

- [x] 22. Eval-харнесс, метрики, baseline
  - `tests/eval/tasks/*` (E1–E6, temp-workspace + машинный oracle); метрики-калькулятор (edit_success/steps/tokens/wall_time/tool_error_rate)
  - Два режима: CI-gate (recorded/mock, детерминированно) + nightly (Ollama `temperature:0`, медиана 3)
  - `tests/eval/baseline.json` (v1 vs v2) + `tests/eval/report.md`
  - _Требования: 12.5, 13.1, 13.2, 13.6_

- [x]* 22.1 Unit-тесты метрик
  - oracle `edit_success`, агрегатор steps/tokens, детект регрессии >20%
  - _Требования: 12.5, 13.2_

- [x] 23. Verification-gate в CI (matrix) и стабилизация
  - `scripts/check-js.mjs` (обход cmd-глоба); scripts `typecheck`/`check:js`/`lint`/`test`/`test:pbt`/`gate`
  - CI matrix `os:[win,mac,linux] × engine:[v1,v2]`; electron-rebuild при better-sqlite3; smoke sqlite/ripgrep на 3 ОС; `.gitattributes` для fixtures
  - Прогнать eval, устранить регрессии до целевых метрик (Req 13)
  - _Требования: 12.6, 12.9, 13.3, 13.4, 13.5_

- [x] 23.1. Observability/логирование движка
  - Структурные логи шагов/usage/ошибок с корреляцией по session (без секретов); для отладки eval-регрессий
  - _Требования: 8.5, 12.5_
  - _Требования: 12.6_

- [x] 24. Включить v2 по умолчанию и убрать транспорт v1
  - `KYREI_ENGINE=v2` по умолчанию; v1 за флагом ещё релиз; затем удалить ручной SSE/loop-код
  - Обновить `docs/research.md` (журнал решений) и README запуска
  - _Требования: 1.6_

---

## Task Dependency Graph

Фазы идут последовательно (каждая зависит от предыдущей); внутри волны задачи можно параллелить, если не зависят друг от друга.

```json
{
  "waves": [
    { "wave": 0, "tasks": ["1", "2", "2.5", "2.6"], "depends_on": [] },
    { "wave": 1, "tasks": ["3", "4", "4.5", "5", "6", "6.1", "6.2"], "depends_on": [0] },
    { "wave": 2, "tasks": ["7", "8", "9", "10", "10.1"], "depends_on": [1] },
    { "wave": 3, "tasks": ["11", "12", "13", "13.1"], "depends_on": [2] },
    { "wave": 4, "tasks": ["14", "15", "16", "16.1"], "depends_on": [3] },
    { "wave": 5, "tasks": ["17", "18", "18.1"], "depends_on": [4] },
    { "wave": 6, "tasks": ["19", "19.1", "20", "21", "21.1"], "depends_on": [5] },
    { "wave": 7, "tasks": ["22", "22.1", "23", "23.1", "24"], "depends_on": [6] }
  ]
}
```

Критический путь: 1 → 3 → 4 → 5 → 7 → 8 → 11 → 12 → 14 → 17/18 → 19 → 22 → 23 → 24.

## Notes

- `- [ ]` — обязательная задача кодирования.
- `- [ ]*` — опциональная (тесты/полировка), но рекомендуется до включения фазы по умолчанию.
- Каждая фаза завершается verification-gate; v2 включается по умолчанию только после Фазы 7.
