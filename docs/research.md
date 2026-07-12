# Kyrei — исследование и проектирование ИИ-агента

> Живой документ. Здесь мы фиксируем результаты исследований, сравниваем готовые
> инструменты, решаем что берём/строим сами и — отдельно — какие **проблемы чужих
> решений мы сознательно НЕ повторяем**. Обновляется по ходу работы.

- Статус: черновик v1 (исследовательская база)
- Дата последнего обновления: 2026-07-12
- Контекст проекта: Node/TypeScript + Electron, кросс-платформенный десктоп (Win/macOS/Linux)
- Цель: собственный ИИ-агент для работы с кодом («движок Kyrei») + GUI

---

## 0. TL;DR (если читать только это)

- **Цикл агента:** начинать с простого tool-calling loop (ReAct). Модель предлагает вызовы
  инструментов — исполняет наш код. Жёсткие условия остановки и бюджет контекста обязательны.
- **Мульти-агенты:** записи/правки — **строго одним агентом**. Рой — только для чтения
  (поиск/исследование). Плюс **ревьюер с чистым контекстом** на дифф. Паттерн — «map-reduce-and-manage».
- **Правки кода:** файл целиком до ~400 строк, дифф — для больших; «терпимый» apply; после правки — verification loop (тесты/линт/сборка).
- **Ретрив:** grep + чтение файлов на лету по умолчанию. Вектора/AST — только когда grep перестаёт хватать.
- **Память:** JSONL-транскрипт на сессию + SQLite/FTS5. Вектора (LanceDB / sqlite-vec) + локальные эмбеддинги (Transformers.js) — фаза 2.
- **Безопасность:** джейл рабочей папки (realpath), уровни разрешений, дифф-превью, OS-песочница для команд, сеть по умолчанию запрещена. MCP — как клиент, за гейтом.
- **Стек:** TS-native. Ядро цикла — **Vercel AI SDK v5** (рекомендация) либо **Mastra**. LangGraph для кодинг-агента избыточен.

---

## 1. Цикл рассуждений агента (agent loop)

- Паттерны: **ReAct** (reason+act, дефолт), **Plan-and-Execute** (сложные многошаговые), **Reflexion** (само-рефлексия), **tool-calling loop**. Консенсус 2025–2026: начинать с ReAct, усложнять только по данным.
- Управление циклом: perceive → plan → act → observe → repeat. Явные условия остановки: терминальное сообщение, достижение цели, **max-steps**, таймаут по времени, неустранимая ошибка, детект зацикливания/повторов, human-in-the-loop.
- Восстановление после ошибок: возвращать модели **поучительный текст ошибки** («используй такой-то формат/фильтр»), а не сырой traceback; таймауты на вызов; идемпотентность.
- Промпт: system-prompt «на правильной высоте»; описания инструментов = документация для новичка (в т.ч. чего инструмент НЕ делает); аккуратное форматирование результатов; scratchpad/заметки; выгрузка длинных выводов.
- Практика: бюджет токенов и «context rot» (внимание деградирует по мере заполнения окна); prompt caching через стабильный префикс истории; мульти-агент ~4–15× токенов.

## 2. Мульти-агентная оркестрация (важнее всего для «роя»)

- Паттерны: single-agent; **supervisor/orchestrator-worker** (доминирующий); sequential pipeline; parallel fan-out (map-reduce); swarm/handoff; event-driven.
- **Когда рой помогает:** чтение-ориентированные, параллелящиеся задачи с чёткими критериями успеха (исследование, поиск по коду/вебу). Каждый суб-агент получает свежий контекст.
- **Когда вредит:** задачи с общими неявными решениями (стиль кода, обработка краёв) — параллельные «писатели» конфликтуют → хрупкий результат.
- Правило 2026 (Cognition/Anthropic): **мульти-агент для чтения и вклада интеллекта; одно-поточно для записей и решений.**
- Рабочая форма: **map-reduce-and-manage** + **ревьюер с чистым контекстом** (видит только дифф, ловит баги именно потому, что не тащит накопленный контекст).
- Провалы: «испорченный телефон» (потеря контекста между агентами), конфликтующие решения, взрыв стоимости, накладные расходы координации. Митигейшн: делиться полным планом/контекстом; одно-поточные записи; сильный трейсинг; дешёвые модели для узких read-only воркеров.

## 3. Инструменты, function-calling, правки

- Tool calling: модель эмитит структурированный вызов (имя + аргументы по JSON Schema), наш код исполняет, результат — обратно. `strict: true` / structured outputs гарантируют валидность аргументов. Схемы через Zod (TS).
- Дизайн инструментов (Anthropic): **немного высокоуровневых** инструментов вместо тонких обёрток над API; возвращать осмысленный контекст (не сырые UUID/дампы); пагинация/фильтры/усечение (Claude Code режет ответ ~25k токенов); неймспейсы; **actionable-ошибки**; описания = prompt engineering.
- Набор для кодинг-агента (ACI, идея SWE-agent — «малый, LM-дружелюбный набор бьёт множество ad-hoc»): `read_file` (диапазоны), `list`/`glob`, `grep_search`, `write_file`, `apply_edit`/`apply_patch`, `run_command` (за гейтом), `run_tests`.
- **Применение правок:** переписывать файл целиком **< ~400 строк**, дифф — для больших (граница повторяется у Aider/Cursor/Morph). Unified diff падает в ~20–30% на «живых» файлах из-за сдвигов контекста/пробелов → нужен **терпимый apply** (fuzzy, порядок-независимый, форматы маркеров под конкретную модель — приём Cline, +15–25% успеха).
- **Verification loop:** после правок авто-прогон тестов/линта/сборки, ошибки — обратно в цикл до «зелёного» или лимита. git-native (коммит на каждую принятую правку, лёгкий undo — приём Aider).

## 4. MCP (Model Context Protocol)

- Открытый протокол (Anthropic, ноя 2024): серверы отдают tools/resources/prompts, клиенты (агенты) их потребляют — «HTTP для ИИ». Одна интеграция работает с любым совместимым клиентом.
- Быстро стал де-факто стандартом (OpenAI, Google, MS, AWS…); в дек 2025 передан в Linux Foundation (снят вопрос вендор-лока). Реестр ~2000 серверов.
- Безопасность: спека 2025-06-18 — серверы как OAuth 2.1 Resource Servers, привязка audience токена, structured output, **elicitation** (сервер спрашивает пользователя посреди сессии). Серверы — реальная поверхность атаки.
- **Вывод для Kyrei:** поддержать как **клиент** (мгновенный доступ к экосистеме), но **за тем же слоем разрешений и песочницы**, с allowlist серверов/инструментов.

## 5. Память и контекст

- Управление окном: truncation/sliding window (грубо) → **суммаризация/компакция** (сжать старое, продолжить с саммари + недавние файлы) → **очистка результатов инструментов** → **заметки** (`NOTES.md`, живут вне окна) → **суб-агенты** (исследуют с чистым окном, возвращают ~1–2K саммари).
- Ретрив по коду: **grep-first** (Cursor/Claude Code/Devin). Причина — экономика: индекс дорог в сборке/поддержке и приблизителен; grep точен и бесплатен, стоимость на запрос ~не зависит от размера репо. Вектора добавлять для семантических запросов; большие репо — символьный граф.
- Чанкинг кода: токен/строчный — «структурно катастрофичен». Лучше **AST-aware (tree-sitter)** по границам функций/классов, размер в символах.
- Долгая память: episodic (нарратив) vs semantic (факты). Встраиваемые хранилища: **LanceDB** (лучший для Node, дисковый, версионирование), **sqlite-vec** (крошечный, SQL + вектора в одном файле). Лёгкие фреймворки: **Mem0** (есть JS SDK, pluggable), **Letta/MemGPT** (само-редактируемая tiered-память, Python).
- Сессии (десктоп): **append-only JSONL на сессию**, связь `parentUuid`, resume/форк/крэш-рекавери; поверх — SQLite+FTS5 для поиска по прошлым сессиям.

## 6. Безопасность выполнения

- Песочница — **спектр под модель угроз**, не вкл/выкл. Уровни: subprocess (0) → Docker (1, общий kernel) → seccomp/AppArmor (2) → gVisor (3) → Firecracker microVM (4) → WASM (5).
- Для одно-пользовательского десктопа microVM избыточен: ценнее **OS-примитивы** — Seatbelt (macOS) / Bubblewrap (Linux) / job object или WSL/контейнер (Windows), как делает Claude Code для bash-инструмента.
- Ограничивать 4 измерения: ФС (read-only корень + writable workspace/tmp), сеть (**default-deny** + allowlist), syscalls (блок ptrace/mount/unshare/bpf), процессы (pids.max).
- Векторы побега, которые часто упускают: docker.sock, **symlink-обход** проверок пути (резолвить `realpath`!), отравление `~/.gitconfig`/хуков, prompt-injection через слой диалога (песочница это не ловит).
- Гардрейлы реальных агентов: read-only по умолчанию, спрашивать на запись/команды, allow/ask/deny-правила (версионируемые), дифф-превью, human-in-the-loop на необратимое, аудит каждого вызова, гигиена секретов (не читать `.env` в контекст). **Усталость от подтверждений** — реальный провал: не делать «YOLO-режим» дефолтом.

## 7. Стек (TypeScript/Node)

| Слой | Вариант | Заметки |
|---|---|---|
| Ядро цикла | **Vercel AI SDK v5** | `ToolLoopAgent`, типобезопасность, стриминг, tool-calling, смена провайдера строкой. Легко и гибко. ← рекомендация |
| Ядро (альт.) | **Mastra** (1.0, янв 2026) | «Батарейки»: агенты, workflow, память, RAG, evals, Studio-UI. Больше рамок фреймворка |
| Оркестрация (тяж.) | LangGraph.js | Мощно, но избыточно для «одного писателя»; много концепций |
| RAG-слой | LlamaIndex.TS | Если понадобится индексирование репо |
| Память-слой | Mem0 (JS) / свой на LanceDB+SQLite | Свой = 0 внешних зависимостей, всё локально |
| Локальные модели | Ollama / LM Studio / llama.cpp | OpenAI-совместимый API; цель ≥32–64K контекста |
| Десктоп | Electron | `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`; привилегии — в main-процессе за минимальным IPC |

---

## 8. Рекомендованная архитектура Kyrei (черновик)

Мы уже движемся правильно: `core/kyrei-engine.js` — это tool-calling loop, `core/session-store.js`
делает атомарную запись + версионирование схемы. Дорастить по чек-листу:

- **Оркестратор-писатель** (все правки — он) + **read-only суб-агенты** (grep/символы/веб) как инструменты + **ревьюер с чистым контекстом** (видит только дифф).
- **ACI:** `read_file` (диапазоны) · `grep_search` (ripgrep) · `list`/`glob` · `apply_edit` (rewrite-small / diff-large + терпимый apply) · `run_command` (песочница) · `run_tests`.
- **Verification loop:** авто-детект `package.json`/сборки/тестов, прогон после правок.
- **Память:** JSONL на сессию + SQLite/FTS5; вектора (LanceDB) — фаза 2.
- **Безопасность:** джейл (realpath) + уровни разрешений + дифф-превью + OS-песочница + MCP-клиент за гейтом.

### Развилки, которые надо решить (см. журнал решений §11)
- **A. Фундамент движка:** A1 Vercel AI SDK v5 (реком.) · A2 Mastra · A3 свой hand-rolled.
- **B. Приоритет фазы 1:** B1 надёжные правки+verification · B2 ретрив · B3 безопасность · B4 память · B5 read-only суб-агенты+ревьюер.
- Предложение: **A1 + B1+B3** (надёжные правки в безопасной песочнице), рой — на шаге B5.

---

## 9. Проблемы чужих решений, которые мы НЕ берём

> Явный список анти-паттернов. Всё, что здесь, — сознательно избегаем.

- ❌ **Параллельные «писатели».** Несколько агентов, одновременно правящих код, → конфликтующие
  решения о стиле/архитектуре и хрупкий результат (Cognition, 2025–2026). У нас — один писатель.
- ❌ **Неструктурированный «swarm».** Хаотичное P2P-общение агентов трудно удержать когерентным.
  Берём структурный map-reduce-and-manage.
- ❌ **Векторный RAG «по умолчанию».** Дорогая поддержка индекса + приблизительный поиск там, где
  нужен точный. Начинаем с grep; вектора — только по необходимости.
- ❌ **Токен/строчный чанкинг кода.** Ломает структуру. Только AST-aware, если чанкать.
- ❌ **Unified diff как единственный формат правок.** Падает на «живых» файлах. Нужен rewrite-small +
  терпимый apply.
- ❌ **Сырые ошибки/дампы обратно в модель.** Только actionable-сообщения.
- ❌ **Docker как «достаточная» изоляция для недоверенного кода.** Общий kernel. На десктопе — OS-примитивы; контейнер/microVM только для стороннего недоверенного кода.
- ❌ **Проверка пути по префиксу строки.** Обходится симлинками. Только `realpath`.
- ❌ **Сеть без ограничений в песочнице.** Риск эксфильтрации ключей. Default-deny + allowlist.
- ❌ **«YOLO-режим» / skip-all-permissions по умолчанию.** Ведёт к усталости от подтверждений и небезопасности. Разрешения по уровням; опасное — всегда подтверждать.
- ❌ **Раздутый фреймворк не по задаче** (напр. LangGraph ради простого одно-писательского цикла) —
  тащит лишние концепции. Берём минимально достаточное.
- ❌ **Мега-контекст вместо управления им.** Большое окно не отменяет «context rot». Бюджетируем контекст: очистка tool-результатов → компакция → заметки → суб-агенты.
- ⚠️ **Осторожно с быстро-умирающими проектами** (напр. статус Roo Code менялся) — проверять актуальность перед тем как на что-то опираться.

---

## 10. Трекер оценки готовых инструментов (изучаем дальше)

> Легенда статуса: 🔬 изучаем · ✅ берём/учимся · 🚫 не подходит · ⏳ отложено

| Инструмент | Категория | Что берём / чему учимся | Что НЕ берём | Статус |
|---|---|---|---|---|
| Vercel AI SDK v5 | TS-фреймворк цикла | ToolLoopAgent, стриминг, типы, роутинг провайдеров | — | 🔬 кандидат A1 |
| Mastra | TS-фреймворк «всё-в-одном» | память/RAG/evals/Studio из коробки | рамки фреймворка | 🔬 кандидат A2 |
| LangGraph.js | оркестрация | идеи графа состояний | избыточность для 1 писателя | ⏳ |
| Aider | кодинг-агент (Py) | repo-map, architect/editor split, git-native, rewrite<400 | Python-стек | ✅ идеи |
| OpenHands | кодинг-агент (Py) | event stream Action/Observation, pluggable sandbox | вес/Python | ✅ идеи |
| Cline | кодинг-агент (VS Code, TS) | plan/act, терпимый multi-diff, форматы под модель, HITL | привязка к VS Code | ✅ идеи |
| SWE-agent | ресёрч | ACI: малый LM-дружелюбный набор инструментов | — | ✅ идеи |
| Continue | ассистент (TS) | config-as-router, локальные модели | — | 🔬 |
| MCP | протокол интеграций | клиентская поддержка за гейтом | сервер как дыра в безопасности | 🔬 фаза 2 |
| LanceDB | встраиваемые вектора | Node-first, дисковый, версионирование | — | 🔬 фаза 2 |
| sqlite-vec | встраиваемые вектора | один файл, SQL+вектора | ниже потолок производительности | 🔬 фаза 2 |
| Transformers.js | локальные эмбеддинги | приватность, $0, в worker-процессе | — | 🔬 фаза 2 |
| Ollama / LM Studio | локальные LLM | OpenAI-совместимый API | — | 🔬 |

---

## 11. Журнал решений (ADR-lite)

| # | Решение | Статус | Дата | Примечание |
|---|---|---|---|---|
| 1 | Ребрендинг Hermes → Kyrei | ✅ принято | 2026-07-12 | выполнено в коде |
| 2 | Штатный движок — нативный tool-calling loop (не завязка на OMP-бинарник) | ✅ принято | 2026-07-12 | `core/kyrei-engine.js` |
| 3 | Фундамент движка: A1 (AI SDK v5) / A2 (Mastra) / A3 (свой) | 🕓 открыто | — | ждём выбора |
| 4 | Приоритет фазы 1: B1..B5 | 🕓 открыто | — | предложение: B1+B3 |
| 5 | Ретрив: grep-first, вектора позже | 🕓 предложено | — | §5, §9 |
| 6 | Модель мульти-агента: один писатель + read-only рой + ревьюер | 🕓 предложено | — | §2 |
| 7 | Безопасность: джейл+разрешения+дифф-превью+OS-песочница | 🕓 предложено | — | §6 |

---

## 12. Источники

### Цикл агента
- Anthropic — Effective context engineering for AI agents (2025-09): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic — Effective harnesses for long-running agents (2025-11): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

### Мульти-агенты
- Cognition — Don't Build Multi-Agents (2025-06): https://cognition.ai/blog/dont-build-multi-agents
- Cognition — Multi-Agents: What's Actually Working (2026-04): https://cognition.ai/blog/multi-agents-working
- Anthropic — How we built our multi-agent research system (2025-06): https://www.anthropic.com/engineering/multi-agent-research-system
- jxnl.co — Why Cognition does not use multi-agent systems (2025-09): https://jxnl.co/writing/2025/09/11/why-cognition-does-not-use-multi-agent-systems/
- composio.dev — OpenAI Agents SDK vs LangGraph vs Autogen vs CrewAI: https://composio.dev/blog/openai-agents-sdk-vs-langgraph-vs-autogen-vs-crewai
- OpenAI Agents SDK (TS) — Handoffs: https://openai.github.io/openai-agents-js/guides/handoffs/
- Mastra — framework: https://mastra.ai/framework
- Google — Introducing ADK for TypeScript (2025-12): https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/

### Инструменты / function-calling / MCP
- OpenAI — Function calling guide (2025-08): https://developers.openai.com/api/docs/guides/function-calling
- OpenAI — Introducing Structured Outputs (2024-08): https://openai.com/index/introducing-structured-outputs-in-the-api/
- Anthropic — Writing effective tools for agents (2025-09-11): https://anthropic.com/engineering/writing-tools-for-agents
- MCP — One Year of MCP / Nov 2025 spec (2025-11-25): https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/
- MCP — 2025-06-18 specification: https://modelcontextprotocol.io/specification/2025-06-18

### Песочница / безопасность
- Tian Pan — Agent Sandboxing and Secure Code Execution (2026-03): https://tianpan.co/blog/2026-03-09-agent-sandboxing-secure-code-execution
- Anthropic — Beyond permission prompts (2025-10-08): https://claude.com/blog/beyond-permission-prompts-making-claude-code-more-secure-and-autonomous
- Anthropic — Claude Code permissions: https://docs.anthropic.com/en/docs/claude-code/permissions
- Northflank — How to sandbox AI agents (2026): https://northflank.com/blog/how-to-sandbox-ai-agents

### Память / контекст / ретрив
- harrisonsec — Agent Retrieval Is a Cost Curve Problem (2026-05): https://harrisonsec.hashnode.dev/agent-retrieval-is-a-cost-curve-problem-why-claude-code-doesn-t-use-rag
- LlamaIndex — Is grep all you need? (2026): https://www.llamaindex.ai/blog/is-grep-all-you-need-lexical-vs-sematic-search-for-agents
- tianpan.co — Code-Specific RAG (2026-05-07): https://tianpan.co/blog/2026-05-07-code-specific-rag-general-retrieval-fails-codebases
- cAST — Structural Chunking via AST (arXiv 2506.15655): https://arxiv.org/abs/2506.15655
- aloa.co — Best Embedded Vector Databases 2025: https://aloa.co/ai/comparisons/vector-database-comparison/best-embedded-vector-databases
- vectorize.io — Mem0 vs Letta (2026-03-15): https://vectorize.io/articles/mem0-vs-letta
- Anthropic Agent SDK — session storage: https://code.claude.com/docs/en/agent-sdk/session-storage

### Существующие агенты / TS-стек / десктоп
- Aider — Edit formats: https://aider.chat/docs/more/edit-formats.html
- Aider — Unified diffs: https://aider.chat/docs/unified-diffs
- anishgandhi — Why AI tools rewrite full files instead of diffs (2026-01): https://anishgandhi.com/why-ai-tools-dont-use-diffs
- OpenHands — paper (arXiv 2407.16741): https://arxiv.org/html/2407.16741v3
- Cline — Improving Diff Edits: https://cline.bot/blog/improving-diff-edits-by-10
- SWE-agent — ACI paper (arXiv 2405.15793): https://arxiv.org/abs/2405.15793
- Vercel — AI SDK 5 (2025-07): https://vercel.com/blog/ai-sdk-5
- Mastra — 22k stars overview (2026-04): https://www.decisioncrafters.com/mastra-build-production-ready-ai-agents-in-typescript-with-22-3k-github-stars/
- Electron — security tutorial: https://github.com/electron/electron/blob/main/docs/tutorial/security.md
- 1Password — electron-secure-defaults: https://github.com/1password/electron-secure-defaults
- DataCamp — Run LLMs locally (Ollama OpenAI compat): https://www.datacamp.com/tutorial/run-llms-locally-tutorial

> Примечание: содержимое источников перефразировано и сжато для соответствия лицензионным
> ограничениям; цифры и детали приведены по состоянию на даты источников и могут меняться.

---

## 13. Разбор GUI локального Hermes (рой саб-агентов)

> Источник: копия реального Hermes в `hermes/hermes-agent/`. Изучены `web/`, `apps/desktop/`,
> `apps/shared/`, `tui_gateway/` (секреты не читались).

### 13.1 В Hermes ДВА фронтенда
- **`web/`** — React-дашборд управления (страницы: sessions, files, models, config, cron, skills,
  plugins, mcp, channels, webhooks, pairing, profiles, env, logs, docs). Стек: React 19,
  react-router v7, Vite 8, Tailwind v4, **приватный `@nous-research/ui`**, lucide, xterm.
  **Чат = встроенный xterm-терминал**, гоняющий `hermes --tui` через PTY-WebSocket (`/api/pty`).
- **`apps/desktop/src`** — нативное Electron-приложение. React 19 + **shadcn/ui** +
  `@assistant-ui/react` + CodeMirror + shiki + mermaid + katex + nanostores. Чат ведёт по
  **JSON-RPC `/api/ws`** (не PTY). Это полированный нативный чат-UI.
- **`apps/shared`** — общий код (`JsonRpcGatewayClient`, `buildHermesWebSocketUrl`, типы событий).

### 13.2 Бэкенд-контракт (что реализовать, чтобы GUI ожил)
- Python FastAPI, дефолт `127.0.0.1:9119`.
- **REST `/api/*`** — ~40+ эндпоинтов (см. `web/src/lib/api.ts`): sessions, files, model(info/options/set/moa),
  config(raw), env(+reveal), cron(+blueprints), skills/toolsets, mcp, messaging, profiles, ops, analytics.
- **WS `/api/ws`** — newline-delimited **JSON-RPC 2.0**:
  - Методы: `session.create/resume/list/title/delete/interrupt`, `prompt.submit` (→`{status:"streaming"}`),
    `slash.exec`, `command.dispatch`, `approval.respond`, `model.options`, `complete.slash`.
  - События (notification `method:"event"`, `params:{type,session_id,payload}`):
    `gateway.ready`, `session.info`, `message.start`, `message.delta{text}`, `message.complete{text,status,usage}`,
    `thinking.delta`, `reasoning.delta`, `tool.start/progress/complete`, `clarify.request`,
    `approval.request`, `sudo.request`, `secret.request`, `error`.
  - Стриминг: `prompt.submit` → `message.start` → серия `message.delta` → `message.complete`;
    delta-фреймы коалесятся (~33мс) + TCP_NODELAY.
- **PTY `/api/pty`** — сырой байтовый поток для терминального чата в дашборде (xterm).
- **Auth (в desktop не нужна):** loopback `?token=`; gated OAuth `?ticket=` (одноразовый, TTL~30с);
  заголовок `X-Hermes-Session-Token`; сервер инжектит `window.__HERMES_SESSION_TOKEN__/__BASE_PATH__/__AUTH_REQUIRED__`.

### 13.3 Ценные паттерны (перенять)
- **Разделение транспортов:** PTY (сырой терминал) vs JSON-RPC (управляющие вызовы) vs pub/sub события.
  В Electron PTY проще делать через `node-pty` + IPC, без WebSocket-ticket-возни.
- **Встроенный терминал на xterm** (`ChatPage.tsx`) — эталон: resize `\x1b[RESIZE:cols;rows]`, реконнект с
  backoff, keep-alive `?attach=` токен, вставка/дроп картинок, OSC 52 clipboard. Чистые функции
  `pty-reconnect.ts` копируются как есть.
- **Единый сервисный слой `api.ts`** — одна точка доступа к бэкенду (в Electron → тонкая обёртка над IPC).
- **Context-only состояние** (Profile/Theme/i18n/PageHeader) — без Redux/Zustand; паттерн
  `ProfileKeyedRoutes` (ремонт дерева по ключу скоупа).
- **JSON-RPC поверх стрима** (`JsonRpcGatewayClient`) + пайплайн слэш-команд (`slashExec.ts`).
- **Плагины со слотами + SDK на `window`** (`plugins/registry.ts`) — с SRI-проверкой.

### 13.4 Проблемы чужого решения (НЕ берём — дополняет §9)
- ❌ **Приватный `@nous-research/ui` + проприетарные шрифты Nous** — весь `web/` завязан; чистый лифт невозможен.
  → Берём shadcn/ui (как `apps/desktop`) + переносим слой тем из `web/src/themes`.
- ❌ **Чат-как-PTY-терминал** в дашборде — сложная механика (ticket/attach/reconnect) ради «терминала в браузере».
  → Нам нужен нативный чат по JSON-RPC (как `apps/desktop`), PTY-терминал — опционально и позже.
- ❌ **Жёсткая связка с Python FastAPI** и ~40 REST-эндпоинтами — тащить весь дашборд не нужно.
- ❌ **WS-аутентификация (ticket/token/base-path/401-reload)** — в desktop через IPC не требуется.
- ❌ **Два React-приложения с двумя дизайн-системами** (web=@nous-research/ui, desktop=shadcn) — источник расхождений (иконки lucide vs tabler и т.п.). Держим одну DS.

### 13.5 Решение по переносу GUI
- **Не** лифтить весь `web/` дашборд.
- Взять **форму нативного чата из `apps/desktop/src`** (shadcn/ui, `@assistant-ui/react`) как ориентир,
  реализовать её на нашей одной дизайн-системе.
- В нашем Node-бэкенде реализовать **минимальный JSON-RPC контракт `/api/ws`**: `session.create`,
  `prompt.submit` + события `message.start/delta/complete` (+ опц. `tool.*`, `error`). Это ложится прямо
  на текущий стриминг движка Kyrei (`core/kyrei-engine.js`).
- Оценка: минимальный чат-контракт ~1–2 дня; полный дашборд — инкрементально и по необходимости.

### 13.6 Замеченная проблема в нашем текущем коде
- Наш `electron/preload.js` выставляет `window.desktop`, но `electron/main.js` его **не подключает**
  (нет `preload:` в `webPreferences`, нет `ipcMain.handle`). Сейчас не критично (GUI ходит через
  локальный HTTP-сервер по `fetch`), но если перейдём на IPC-транспорт — это надо будет исправить.

### 13.7 Обновление трекера/решений
- Трекер (§10): + `apps/desktop/src` (shadcn+assistant-ui, JSON-RPC) — ✅ ориентир для чата;
  `web/` дашборд — 🚫 не лифтим целиком (приватные зависимости, PTY-чат, Python-связка).
- Журнал (§11): #8 «GUI: взять форму нативного чата (shadcn/assistant-ui) + JSON-RPC `/api/ws` контракт в Kyrei» — 🕓 предложено.

---

## 14. Глубокий разбор нативного чата `apps/desktop/src` (рой + чтение эталонов)

### 14.1 Слои и стек
- **Рендеринг чата:** `@assistant-ui/react` (примитивы `ThreadPrimitive`/`MessagePrimitive`/`ComposerPrimitive`/`ActionBarPrimitive`/`BranchPickerPrimitive`).
  - Тред: `components/assistant-ui/thread/*` — `list.tsx` (без виртуализатора: «render budget» 300 частей + turn-группы + `use-stick-to-bottom`), `assistant-message.tsx` (плоский, без бабла, футер copy/reload/tts), `user-message.tsx` (sticky-бабл), `message-parts.tsx` (карта Text/Reasoning/ToolGroup).
  - Markdown: `assistant-ui/markdown-text.tsx` на **streamdown** (`@assistant-ui/react-streamdown` + `@streamdown/code`); перф-хаки: LRU блоков, `tailBoundedRemend`, `useSmoothReveal`, `DeferStreamingText`, лимит 200k. `compact-markdown.tsx` — для тел тулколов.
  - Код: `components/chat/shiki-highlighter.tsx` (**react-shiki**, тема github-dark-dimmed/light, бюджеты, `defer` при стриминге) в `code-card.tsx`. `code-editor.tsx` — **CodeMirror 6** (правка файлов, не чат).
  - Тулколы: `assistant-ui/tool/fallback.tsx` (`ToolEntry`/`ToolGroupSlot`, `buildToolView`) — статус-глиф + `ActivityTimerText` + `DisclosureRow`; success молчит; окно с авто-скроллом при ≥3 вызовах; `approval.tsx` (inline Run/Allow/Reject).
  - Diff: `components/chat/diff-lines.tsx` — Cursor-style (цвет+гуттер), Shiki-трансформер тинта, overview-ruler, виртуализация `fixed-row-window.ts`.
  - Спец-блоки: `assistant-ui/embeds/registry.tsx` — `mermaid`/`svg` ленивыми чанками; `katex-memo.ts`; `ansi-text.tsx` (+`lib/ansi.ts`).
- **Оболочка:** `app/shell/app-shell.tsx` (кастомный titlebar `titlebar-controls.tsx` + statusbar), `components/pane-shell/pane-shell.tsx` (своя CSS-grid система: `PaneShell`/`Pane`/`PaneMain`, resize, hover-reveal, bottom-row, flip сторон), `app/desktop-controller.tsx` (корневой оркестратор, `<Routes>` внутри `<PaneMain>`).
- **Экран чата:** `app/chat/index.tsx` (`ChatView`) — `Backdrop` + `ChatHeader` + `ChatRuntimeBoundary(Thread + ScrollToBottom + ChatBar)`. `ChatRuntimeBoundary` — единственный подписчик на `$messages` (изоляция стриминга).
- **Composer:** `app/chat/composer/index.tsx` (`ChatBar`, ~1000 строк, логика в `composer/hooks/*`): **contentEditable** rich-editor (не textarea, ради перфа), очередь, история ввода, слэш/@, голос, pop-out, вложения. `ComposerPrimitive.Input` спрятан (sr-only) — только для биндинга состояния.
- **Правый рельс:** `app/chat/right-rail/*` — это **превью** (Electron webview), не «модель/тулколы». Сайдбар `app/chat/sidebar/*` — список сессий + поиск (FTS) + Pinned/Projects/Messaging/Cron + мульти-профиль + DnD.
- **Состояние:** **nanostores** (`store/*`), подписка `@nanostores/react` `useStore`; per-session срезы через `useSessionSlice` (`useSyncExternalStore`); персист через `lib/persisted`/`lib/storage`; cross-window через `BroadcastChannel`.
- **Дизайн-система:** `components/ui/*` — shadcn new-york через единый **`radix-ui`** пакет + `cmdk` + CVA; `codicon.tsx` (`@vscode/codicons`), `tool-icon.tsx` (inline Phosphor SVG), `glyph-spinner` (`unicode-animations`). Токены в `styles.css`: **Tailwind v4 `@theme inline`** (нет `tailwind.config.js`), 3 слоя `--theme-*`→`--ui-*`→`--dt-*`, `--shadow-nous`/`--stroke-nous`. Темы `themes/*`: 6 пресетов + импорт VS Code (`vscode.ts`), `.dark` по WCAG-люминансу фона.

### 14.2 Контракт «событие gateway → UI» (что реализовать в Kyrei)
- **WS JSON-RPC** (клиент `HermesGateway extends JsonRpcGatewayClient` из `@hermes/shared`):
  - Методы: `session.create`→`SessionCreateResponse`, `session.resume`, `prompt.submit` (**fire-and-forget**, до 1800с), cancel/interrupt, `model.options`.
  - Ошибка неизвестного метода — код **-32601** (клиент детектит `isMissingRpcMethod`).
- **Поток событий** `RpcEvent{type, payload, session_id}` (типы полей — `GatewayEventPayload` в `chat-messages.ts`):
  - Текст: `message.start` → `message.delta{text}` → `message.complete{text,status,usage}` (**завершение хода — этим событием, не возвратом RPC**).
  - Reasoning/thinking: дельты `{text}` (не тримить пробелы).
  - Тулы: `tool.start`/`tool.complete` c `tool_id`/`tool_call_id`/`id`, `name`, `args`/`arguments`/`input`, `context`, `preview`; на complete — `result`, `summary`, `inline_diff`, `duration_s`, `error`, `todos`. **Стабильный `tool_call_id` от начала до конца.**
  - `status.update` (`running`,`model`,`provider`,`cwd`,`branch`,`usage`,…), `session.title`, интерактив (`approval.request`,`clarify.request`,`secret.request`), `agent.terminal.output`, `subagent.*` (**обязательно с `session_id`**), `moa.*`.
- **REST-over-IPC** через `window.hermesDesktop.api({path,method,body,timeoutMs,profile})` — огромная поверхность (~80 методов в `hermes.ts`). Для чат-MVP минимум: `/api/sessions/{id}/messages`, `/api/status`, `/api/config`, `/api/model/options|info`. Транскрипт парсится `toChatMessages`. Также нужен `window.hermesDesktop.getGatewayWsUrl()`.

### 14.3 Что переносимо as-is / что переписать / что бросить
- **As-is (чистые функции, копируются):** `lib/chat-messages.ts` (редьюсеры событие→части), `lib/chat-runtime.ts` (`toRuntimeMessage`, `coalesceToolOnlyAssistants`, `coerceThinkingText`), `lib/incremental-external-store-runtime.ts`, `lib/gateway-events.ts`, `lib/ansi.ts`; UI-примитивы `components/ui/*` (shadcn), `components/chat/{code-card,expandable-block,disclosure-row,diff-lines,terminal-output,zoomable-image}`, `ansi-text.tsx`, слой тем `themes/*` + `styles.css`.
- **Переписать под Kyrei:** WS JSON-RPC сервер + `RpcEvent`-поток в нашем `core/`; мост `window.hermesDesktop` в Electron preload (`api` REST-прокси + `getGatewayWsUrl`); nanostores-слайсы завязанные на gateway (`store/gateway.ts` мульти-профиль-пул — упростить до одного сокета/IPC).
- **Бросить (не тащить):** приватный `@nous-research/ui` + шрифт `Collapse`; PTY-терминал web-дашборда; мульти-профильный пул сокетов; pet/starmap/cron/messaging; rich contentEditable-композер целиком (MVP — textarea + `ComposerPrimitive`); ~80 REST-методов (подключать лениво по мере экранов).

### 14.4 Конкретный план переноса (поэтапно)
- **Фаза 1 — Chat MVP (цель: рабочий нативный чат):**
  1. Каркас Vite+React+Tailwind v4 в новом рендере (или рядом с текущим `public/`), перенести `styles.css` + одну тему + `components/ui/*` (shadcn).
  2. Скопировать `chat-messages.ts` + `chat-runtime.ts` + `incremental-external-store-runtime.ts` + `gateway-events.ts` как есть; тред `assistant-ui/thread/*` + `markdown-text` + `shiki-highlighter`/`code-card` + `tool/fallback` (упрощённый).
  3. Композер — минимальный: `ComposerPrimitive` + textarea + onSubmit (без pop-out/voice/queue).
  4. Бэкенд Kyrei: WS JSON-RPC (`session.create`,`prompt.submit`,cancel) + `RpcEvent`-поток, маппинг из `core/kyrei-engine.js` (текущий стриминг → `message.*`, вызовы инструментов → `tool.*`); preload-мост `window.hermesDesktop` (минимальный REST: `/api/sessions/{id}/messages`, `/api/status` + `getGatewayWsUrl`).
- **Фаза 2:** `PaneShell` + сайдбар сессий + правый рельс; полноценный diff; katex/mermaid lazy; больше типов тулколов; nanostores-слайсы (`session`,`composer`,`tool-*`).
- **Фаза 3:** rich-композер (очередь/история/@-slash/voice/pop-out), суб-агенты/статус-стек, память, темы+импорт VS Code, MCP.

### 14.5 Обновление трекера/журнала
- Трекер (§10): + `@assistant-ui/react` (✅ ядро треда — принимаем рантайм-модель), `streamdown`+`react-shiki` (✅), `radix-ui`+`cmdk`+CVA (✅ shadcn-база), `@vscode/codicons`+`@tabler/icons-react` (✅), `nanostores`+`@nanostores/react` (🔬 для чат-состояния), CodeMirror/mermaid/katex (⏳ фаза 2, lazy).
- Журнал (§11): #8 уточнено — GUI = порт нативного чата `apps/desktop/src` (assistant-ui + shadcn) + контракт §14.2 в Kyrei. #9 (новое): фундамент рендера — Vite+React+Tailwind v4 отдельным окном/бандлом. #10 (новое): переиспользовать `chat-messages.ts`/`incremental-external-store-runtime.ts` as-is. Все — 🕓 предложено, ждут старта фазы 1.

---

## 15. Перестройка проекта — Фаза 1 (Chat MVP) выполнена

Проект пересобран начисто (старый одностраничный GUI и OMP-мост удалены).

**Стек рендера:** Vite 6 + React 19 + TypeScript + Tailwind v4 (`@theme` в `src/index.css`, без `tailwind.config`) + lucide-react + react-markdown/remark-gfm + shiki (ленивая подсветка) + clsx/tailwind-merge.

**Структура:**
- `src/` — рендер: `App.tsx` (оркестратор), `components/{Sidebar,Thread→Message,Markdown,CodeBlock,ToolRow,Composer,Settings}.tsx`, `lib/{gateway,chat-messages,types,utils}.ts`. `chat-messages.ts` — портированные из Hermes чистые редьюсеры (appendText/appendReasoning/toolStart/toolComplete).
- `core/kyrei-engine.js` — движок переведён на событийную модель (`emit`): `message.start/delta/complete`, `tool.start/complete`, `error`. Инструменты (list_dir/read_file/write_file/run_command) с джейлом рабочей папки.
- `core/gateway.js` — локальный HTTP-сервер: **SSE** для потока событий (`/api/events?session=`) + JSON POST для команд (`/api/prompt`, `/api/cancel`), REST для сессий/конфига/выбора папки. Конфиг (provider/apiKey/model/workspace) в `userData/kyrei/kyrei-config.json` (ключ наружу не отдаётся). Сессии — через `core/session-store.js`.
- `electron/main.js` — стартует gateway, отдаёт порт рендеру через `?port=`, грузит `dist/renderer`. `preload.js` — минимальный мост (`openExternal`).

**Контракт (упрощён под собственный фронт):** SSE-события `{type,payload}` вместо WS JSON-RPC (проще, без внешних зависимостей; смысл тот же, что §14.2). Завершение хода — по `message.complete`.

**Проверено:** `npm run build` (vite) — успешно; `node --check` всех модулей ядра — чисто; автономный smoke-тест gateway — health/config/сессия/SSE-стрим/подсказка-без-ключа/персист сообщений; Electron стартует, gateway отвечает `engine:kyrei`.

**Запуск:** `npm start` (собирает рендер + запускает Electron) или `npm run dev:renderer` + `KYREI_RENDERER_URL=http://localhost:5174` для hot-reload. Первый шаг в приложении — Настройки: указать провайдера, API-ключ, модель, (опц.) рабочую папку.

**Дальше (Фаза 2, §14.4):** реальный streaming от провайдера, diff-рендер правок, `PaneShell`-раскладка, богаче тулколы, история с частями (не только текст), темы. Журнал (§11): #8–#10 — ✅ принято/выполнено (Фаза 1).

---

## 16. Фаза 2 — стриминг, диффы, структурная история (выполнено)

- **Реальный токен-стриминг:** `core/kyrei-engine.js` переписан на `stream: true` — SSE от провайдера парсится, `message.delta` эмитятся по мере поступления токенов; `tool_calls` аккумулируются по `index` across чанков. Фолбэк на не-стрим без инструментов при 400/404/422.
- **Диффы правок:** `write_file` вычисляет построчный дифф (LCS) старого и нового содержимого и отдаёт `inline_diff` в `tool.complete`. Новый компонент `DiffView` в `ToolRow` рисует дифф в стиле Cursor (зелёный `+`/красный `−`, левый бордер) + счётчик `+N −M` в шапке строки.
- **Структурная история:** движок возвращает `{ text, parts }`; gateway сохраняет ассистентское сообщение с `parts` (текст+тулколы+дифф). При перезагрузке сессии история гидратируется из `parts` (не только текст) — тулколы и диффы видны и после перезапуска.
- **Живой каретка** при стриминге, авто-переключение диффа в раскрытый вид.

**Проверено:** `npm run build` — успешно; `node --check` ядра — чисто; стриминг-smoke с фиктивным SSE-провайдером — 4 delta-токена, агентный цикл (2 хода), `write_file` + корректный дифф, `parts=[text,tool,text]`, файл реально обновлён; Electron стартует, gateway отвечает.

**Дальше (Фаза 3):** `PaneShell`-раскладка + правый рельс/превью, темы (несколько + переключатель), богаче тулколы (поиск/ANSI), rich-композер (очередь/история/@-slash), суб-агенты/статус-стек, MCP-клиент.

---

## 17. Фаза 3 — темы, файловый обозреватель, история ввода (выполнено)

- **Темы:** токены в `src/index.css` переведены на `@theme inline` → runtime CSS-переменные `--k-*`, переключаемые через `data-theme` на `<html>`. Три темы: Тёмная, Светлая, Полночь (`src/lib/theme.ts`, применяется в `main.tsx` до рендера, персист в localStorage). Переключатель `ThemeSwitcher` в футере сайдбара.
- **Файловый обозреватель (правый рельс):** gateway-эндпоинты `GET /api/files?path=` (листинг с джейлом рабочей папки, папки сверху, скрытые файлы отфильтрованы) и `GET /api/file?path=` (чтение текста, лимит 500КБ). Компонент `FileExplorer` — хлебные крошки, навигация по папкам, предпросмотр файла с подсветкой (shiki по расширению). Кнопка-переключатель `PanelRight` в шапке.
- **История ввода:** в `Composer` — стрелки Вверх/Вниз листают отправленные сообщения (не затирая черновик).

**Проверено:** `npm run build` — успешно; `node --check` gateway — чисто; smoke файловых эндпоинтов — листинг root/подпапки, чтение файла, блокировка `../` выхода за пределы папки; Electron стартует, `/health` отвечает.

**Дальше (Фаза 4):** переключение темы Shiki вместе с темой приложения; resizable правый рельс (PaneShell); `/`-slash-команды в композере; суб-агенты/статус-стек; MCP-клиент; сужение бандла Shiki до нужных языков.

---

## 18. Фаза 4 — подсветка по теме + slash-команды (выполнено)

- **Shiki по теме приложения:** `src/lib/highlighter.ts` — singleton `createHighlighter` с курируемым набором грамматик (~35 языков) и двумя темами (`github-dark-dimmed`/`github-light-default`). В рантайме грузятся только нужные языки + 2 темы (раньше `codeToHtml` тянул полный бандл). `CodeBlock` реагирует на смену темы через `useThemeId()` (событие `kyrei-theme-change` из `applyTheme`) и перекрашивает код; светлая тема → светлая подсветка. `normalizeLang` с алиасами (ts/js/py/…), неизвестные → `text`.
- **Slash-команды:** `src/lib/commands.ts` + попап в `Composer` (фильтр по префиксу, стрелки/Tab/Enter/Esc). Команды: `/new`, `/clear`, `/model <название>`, `/theme dark|light|midnight`, `/settings`, `/help`. Обработчик `runCommand` в `App` (смена модели через gateway, смена темы, открытие настроек, новый диалог, вывод справки транзиентным сообщением).

**Проверено:** `npm run build` — успешно (2187 модулей); Electron стартует, `/health` отвечает.

**Дальше (Фаза 5):** resizable панели (PaneShell); суб-агенты/статус-стек; MCP-клиент; реальная сборка `electron-builder` под Win/Mac/Linux; тонкая настройка Shiki через `shiki/core` для уменьшения числа dist-чанков.

---

## 19. Фаза 5 — resizable-панели и персист UI (выполнено)

- **Resizable-панели:** `src/components/ResizeHandle.tsx` (pointer-drag, min/max, курсор col-resize). Сайдбар (200–420px) и файловый обозреватель (240–560px) теперь тянутся за границу; ширины сохраняются (`usePersistentNumber`). Сами панели перешли на `w-full` внутри обёрток фиксированной ширины.
- **Персист UI:** `src/lib/persist.ts` — `usePersistentNumber`/`usePersistentBool` + `getStored`/`setStored` (localStorage). Сохраняются: ширина сайдбара/обозревателя, открытость обозревателя, **последняя активная сессия** (при старте открывается последний диалог, если он ещё существует).

**Проверено:** `npm run build` — успешно; Electron стартует, `/health` отвечает.

**Дальше (Фаза 6):** суб-агенты/статус-стек над композером; MCP-клиент; реальные инсталляторы `electron-builder`; dev-режим с hot-reload (`KYREI_RENDERER_URL`).

---

## 20. Разбор чужих движков coding-агентов (рой саб-агентов, backend-фокус)

> Изучены (read-only, через web) движки/бэкенды: **kilocode**, **opencode**, **openai/codex**,
> **zed**, **kimi-code**, **MiMo-Code**, **Mini-Agent**, **Antigravity**, **Kiro**. Фокус — agent
> loop, tools, apply-правок, стриминг/протокол, провайдеры, песочница, память/контекст. Секреты не
> читались; ничего не клонировалось. Пометки достоверности сохранены (verified / unverified / comm.).

### 20.1 Сводная таблица (движок → чему учимся)

| Проект | Стек | Транспорт UI↔engine | Apply-правок | Песочница | Память/контекст | Главный урок |
|---|---|---|---|---|---|---|
| kilocode | TS (моно, bun) | HTTP+SSE (`kilo serve`), WS | `apply_diff` fuzzy + line-hints | sandbox-toggle, **network default-deny** (Linux/macOS) | per-dir index (Qdrant опц.), snapshots | apply c line-hints; sandbox+deny-сеть; tool-слой ≠ model-слой |
| opencode | Bun/TS, Hono | REST+SSE+**ACP(JSON-RPC/stdio)** | `edit`(exact/regex/diff)+`patch`, `@pierre/precision-diffs` (4 уровня fuzzy) | allow/deny/ask, per-cmd bash, audit, realpath | file-store + parts, git-snapshot, **двухфазная компакция** | 2-фазная компакция; git-snapshot undo; единый tool-контракт `{title,output,metadata}`; `batch`/`question`; LSP-verify |
| codex | Rust (60+ крейтов) | JSON-RPC/JSONL (app-server) | **`apply_patch`**: контекст-якоря `@@` (без номеров строк) + `seek_sequence` (4 уровня, Unicode-норм.) | OS-native (Seatbelt/Bubblewrap+seccomp/Win tokens), **`execpolicy`** (argv без shell) | rollout/message-history/memories (JSONL) | контекст-якорный дифф + толерантный seek; streaming-парсер патчей; execpolicy argv-allowlist |
| zed | Rust (GPUI) | **ACP** (JSON-RPC/stdio) | `edit_file`(replace)/`write_file` разнесены; checkpoints+review-diff | OS-sandbox только для `terminal`/`fetch`; git-метаданные RO; net default-deny | grep/find_path, автокомпакция (summary у порога), `@`-context | ACP-протокол (`stopReason`, tool lifecycle, `usage_update`, cancel≠error); гранулярные тулы; checkpoints; `spawn_agent` |
| kimi-code | TS (Node≥22)+Rust ядро | **ACP**/stdio; `wire.jsonl` event-log | отдельные read/edit | градация аппрувов + allow/deny rules | сессии `state.json`+`wire.jsonl`, автокомпакция+`/compact hint`, `/fork` | append-only `wire.jsonl` + request-trace; Plan mode; градация аппрувов |
| MiMo-Code | Bun/TS (форк opencode) | (как opencode) | LSP + TDD-скиллы, git worktrees | external_dir prompt; skip-perms опасен | **4-слойная память** (checkpoint→MEMORY→global→SQLite FTS), writer-subagent, checkpoints 20/45/70% | ранние инкрем. checkpoints + rebuild ≤65K; writer-subagent (single-writer, code-enforced paths); Goal-verifier; workflow как код |
| Mini-Agent | Python | CLI (SSE нет) | `write_file`/`edit_file`(str.replace — дефектный) | **path-jail нет** (антипример) | tiktoken+API двойной учёт токенов, summary между user-парами | двойной токен-триггер; `_cleanup_incomplete_messages` при отмене; bg-process manager; tool-exception→result |
| Antigravity | форк VS Code | не публичен; `transcript.jsonl`, reactive wakeup | multi-file edits + **Artifacts** (plan/walkthrough) | terminal policy Off/Auto/Turbo × review policy | Projects/Workspaces/Knowledge Base, skills/plugins | **Artifacts как объекты верификации**; двухосевая автономия; single core → many surfaces |
| Kiro | (AWS Bedrock) | — | Supervised per-hunk accept/reject | Autopilot/Supervised, Pre-Tool-Use hook-gate | **Steering** (inclusion modes) + AGENTS.md; spec-файлы | **spec-driven** (requirements→design→tasks); `tasks.md` **DAG-волны**; hooks (event-типы+категории); steering как persistent memory |

### 20.2 Кросс-срез: на чём сошлись зрелые движки (сильные сигналы)

- **Архитектура «сервер-мозг + тонкие клиенты».** kilocode (`kilo serve`), opencode (Hono server), codex (app-server), zed/kimi (ACP), Antigravity («один Core Engine → 4 surfaces»). **Наш `core/kyrei-engine.js` + SSE-gateway уже в этой парадигме** — закрепляем как принцип: движок не знает про Electron.
- **Протокол-стандарт ACP** (JSON-RPC/stdio, «LSP для агентов») — у opencode/zed/kimi/codex. Даёт совместимость с редакторами почти бесплатно. Наш SSE-контракт стоит **расширить до ACP-подобной модели**: `stopReason` (end_turn/max_tokens/max_turn_requests/refusal/cancelled), lifecycle тул-колла `pending→in_progress→completed` со стабильным id, `usage_update` (токены/стоимость), **отмена ≠ ошибка**.
- **Толерантный apply вместо LCS-line-diff.** codex `apply_patch` (контекст-якоря `@@`, без номеров строк) + `seek_sequence` (exact → trim trailing WS → trim all WS → Unicode-нормализация); opencode `@pierre/precision-diffs` (exact → normalized-WS → line-fuzzy → contextual); kilocode `apply_diff` (fuzzy + line-hints). **Это самый быстрый выигрыш в надёжности правок для Kyrei.**
- **Управление контекстом — не одноразовое summary, а система.** opencode: prune tool-outputs (пороги 20k/40k) → LLM-summary (`summary:true`), `isOverflow()` по факт. токенам. MiMo: инкрем. checkpoints на **20/45/70%** окна (не у предела!) + rebuild ≤~65K с bounded per-section. Mini-Agent: **двойной токен-триггер** (tiktoken + API-reported). zed/kimi: автокомпакция у порога + ручной `/compact`.
- **git-snapshot перед каждой правкой** (opencode `Snapshot.track→restore/revert`, zed checkpoints, MiMo worktrees) — дешёвый надёжный undo. Ложится на наш `session-store`.
- **Безопасность = уровни разрешений + OS-песочница + network default-deny.** allow/deny/ask (opencode/kimi/kilo), двухосевая автономия (Antigravity terminal×review), execpolicy argv-allowlist (codex). YOLO/Turbo/skip-perms **все помечают как небезопасные** — не дефолт.
- **Ретрив: grep/LSP, не обязательный vector-RAG.** Все ядра стартуют с grep/glob + LSP-диагностика; вектор — опционально (kilo Qdrant, MiMo — сознательно FTS вместо вектора ради reviewability).

### 20.3 Уникальные идеи (берём точечно)

- **Kiro — spec-driven + DAG-волны + steering + hooks.** requirements→design→tasks с approval-gates; `tasks.md` исполняется по графу зависимостей волнами (внутри волны — параллельно); steering-файлы с inclusion-modes (`always`/`fileMatch`/`manual`/`auto`) + AGENTS.md как persistent memory; hooks на event-типы с категориями инструментов (read/write/shell/web/spec), Pre-Tool-Use как security-gate.
- **MiMo — writer-subagent для памяти.** Главный агент **не ведёт свою память** (деградирует обе задачи); отдельный writer со своим бюджетом пишет checkpoint фиксированной структуры (11 полей); **single-writer инвариант, write-пути enforced в коде**; главный агент — read-only к структурным файлам, единственный write-канал — append в `notes.md`. Плюс **Goal-verifier** (независимая проверка условия завершения против «оптимистичных стопов»).
- **Antigravity — Artifacts как first-class объекты верификации.** plan.md/walkthrough.md с diff'ами + результатами тестов, стримятся отдельным типом события; закрывают «Trust Gap». **Reactive wakeup** (система будит агента на событие subagent/фона) вместо polling.
- **opencode — `batch` (до 25 тулов параллельно, partial-success) и `question`** (структурированные уточнения); единый tool-контракт `{title(UI), output(model), metadata}`; кастомные тулы как файлы `.opencode/tool/*.ts`.
- **kimi — `wire.jsonl`**: append-only event-log на агента + request-trace (схемы тулов, MCP-список) для replay/отладки.
- **Mini-Agent — `_cleanup_incomplete_messages()`**: при отмене/ошибке срезать висячий assistant+tool хвост, чтобы история осталась валидной; bg-process manager (start→id, инкрем. output c regex-фильтром, kill); tool-exception→`ToolResult(error=traceback)` для self-heal.
- **codex — streaming-парсер патчей** (применять/показывать дифф до конца ответа) + lenient-парсинг (прощать heredoc-обёртки и мусор слабых моделей).

### 20.4 Анти-паттерны (дополняют §9 — НЕ берём)

- ❌ **LCS/наивный line-diff и `str.replace` без проверки уникальности** (дефект Mini-Agent `edit_file` — молчаливая множественная замена). → контекст-якорный apply + подсчёт совпадений якоря, fail при >1.
- ❌ **Отмена, всплывающая как `error`** (предупреждение ACP/zed) → отдельная стоп-причина `cancelled`, не error-событие.
- ❌ **Инлайновая компакция тем же основным циклом** (Mini-Agent) — блокирует, усиливает recency, теряет старое («дилемма Mamba», критика MiMo) → отдельный шаг/subagent, explicit storage.
- ❌ **Главный агент ведёт структурную память сам** (MiMo) — деградирует и задачу, и лог → writer-subagent + single-writer.
- ❌ **YOLO / Turbo / `--dangerously-skip-permissions` / auto-approve как дефолт** (все проекты помечают опасным) → restrictive by default.
- ❌ **Отсутствие path-jail, приём абсолютных путей, bash без allowlist** (Mini-Agent) → наш workspace-jail на ВСЕ тулы (file И command).
- ❌ **Своя OS-песочница на 3 ОС с нуля** (codex/zed — очень дорого) → один надёжный механизм (jail + ограниченный child_process + network default-deny), OS-примитивы точечно.
- ❌ **«God-module» сборки контекста** (opencode `session/prompt.ts` 1700+ строк) → модульная сборка с самого начала.
- ❌ **Регекс-детект «опасных команд» как основная защита** (обходится) → сигнал, но основа — jail + deny-сеть.
- ❌ **Иллюзия безопасности песочницы** (zed честно перечисляет side-channels: hooks/proc-macros/Makefile вне jail) → документировать ограничения, не обещать гарантий.
- ❌ **Облачный Share/upload сессий** (opencode share, Kilo Cloud) — эксфильтрация приватного кода; на десктопе выключено.
- ❌ **Две линии движка / две дизайн-системы** (kilocode extension-native vs opencode-based) — расхождения; держим ОДИН движок.
- ❌ **Жёсткое принуждение к спекам для тривиальных задач** (риск Kiro) → «vibe»-режим дефолт, спеки — для сложных фич/багфиксов.
- ❌ **Привязка к одному провайдеру** (Kiro→Bedrock, Antigravity→Gemini, codex→Responses API) → сохраняем OpenAI-compatible + реестр моделей.

### 20.5 Приоритетный backlog для движка Kyrei (по выводам §20)

1. **Apply-правок (highest ROI):** заменить/дополнить LCS на контекст-якорный `apply_patch` (`@@`-якоря, без номеров строк) + толерантный `seek_sequence` (4 уровня + Unicode-норм.); streaming-парсер; проверка уникальности якоря.
2. **Протокол:** расширить SSE-gateway до ACP-подобной модели (`stopReason`, tool-lifecycle `pending→in_progress→completed`, `usage_update`, cancel≠error). Опционально — ACP/stdio-адаптер для совместимости с Zed/JetBrains.
3. **Контекст:** двухфазная компакция (prune tool-outputs → LLM-summary) + ранние инкрем. checkpoints (20/45/70%) + rebuild с bounded per-section; двойной токен-триггер (локальный tiktoken-аналог + API-reported).
4. **Надёжность цикла:** `cleanup_incomplete_messages` при отмене/ошибке; tool-exception→result (self-heal); Goal-verifier для автономного режима; явные max-steps/timeout.
5. **Тулы (ACI):** разнести `edit_file`(replace)/`write_file`(rewrite); добавить `grep`(ripgrep)/`find_path`/`diagnostics`(LSP); `batch` (параллельные read-only); единый контракт `{title,output,metadata}`; token-based head+tail truncation с маркером; bg-process manager.
6. **Память:** файловая слоёная (session `checkpoint`→project `MEMORY.md`/steering→global) + SQLite FTS как fallback; writer-subagent + single-writer + code-enforced write-paths; поддержка `AGENTS.md`. (Наш LTM `ltm/` — стартовая база.)
7. **Безопасность:** workspace-jail (realpath) на все тулы; уровни allow/ask/deny + двухосевая автономия (terminal × review); network default-deny; Pre-Tool-Use hook-gate (скан секретов/блок команд); git-snapshot undo перед правками.
8. **Оркестрация (позже):** spec-режим (requirements→design→tasks) как опция + `tasks.md` DAG-волны; read-only рой + ревьюер с чистым контекстом (§2); Artifacts (plan/walkthrough) как тип события; reactive wakeup вместо polling.

### 20.6 Обновление трекера (§10) и журнала решений (§11)

**Трекер — добавить:**

| Инструмент | Категория | Что берём | Что НЕ берём | Статус |
|---|---|---|---|---|
| codex `apply-patch`/`seek_sequence` | apply-движок | контекст-якорный дифф + толерантный seek + Unicode-норм. | Rust/60 крейтов | ✅ берём идею (замена LCS) |
| opencode | TS-движок | 2-фазная компакция, git-snapshot, tool-контракт, `batch`/`question`, LSP-verify | Bun/SolidJS, cloud share, yolo | ✅ ключевой ориентир |
| ACP (Zed/opencode/kimi/codex) | протокол | `stopReason`/tool-lifecycle/`usage_update`/cancel≠error, опц. stdio-адаптер | — | ✅ расширяем свой контракт |
| MiMo-Code | контекст/память | checkpoints 20/45/70%, rebuild ≤65K, writer-subagent, Goal-verifier, FTS-память | test-time N-сэмплов (дорого), Bun | ✅ идеи памяти/контекста |
| kilocode | TS-движок | apply_diff line-hints, sandbox+net-deny, tool≠model слои | облако Kilo, 2 линии движка | ✅ идеи |
| kimi-code | TS+Rust | `wire.jsonl` event-log + request-trace, Plan mode, градация аппрувов | связка с TUI | ✅ идеи |
| Mini-Agent | Python demo | двойной токен-триггер, cleanup-incomplete, bg-process mgr, tool-exc→result | нет path-jail, наивный edit | ✅ точечные идеи |
| Antigravity | agentic IDE | Artifacts (plan/walkthrough), двухосевая автономия, reactive wakeup | browser-subagent+видео, Turbo-дефолт | ✅ идеи (осторожно) |
| Kiro | agentic IDE | spec-driven, `tasks.md` DAG-волны, steering (inclusion modes), hooks (event-типы) | принуждение к спекам, Bedrock-lock | ✅ идеи (опц. режим) |

**Журнал решений — добавить (все 🕓 предложено, ждут старта backend-фазы):**

| # | Решение | Статус | Дата | Примечание |
|---|---|---|---|---|
| 8 | Заменить LCS-diff на контекст-якорный apply_patch + толерантный seek (codex/opencode) | 🕓 предложено | 2026-07-12 | §20.2, §20.5#1 — highest ROI |
| 9 | Расширить SSE-контракт до ACP-подобного (`stopReason`/tool-lifecycle/`usage_update`/cancel≠error) | 🕓 предложено | 2026-07-12 | §20.2, §20.5#2 |
| 10 | Система управления контекстом: 2-фазная компакция + чекпоинты 20/45/70% + двойной токен-триггер | 🕓 предложено | 2026-07-12 | §20.5#3 |
| 11 | Writer-subagent для памяти (single-writer, code-enforced paths) + слоёная файловая память + FTS | 🕓 предложено | 2026-07-12 | §20.3, §20.5#6 |
| 12 | ACI: разнести edit/write + grep/find_path/diagnostics + batch + единый tool-контракт | 🕓 предложено | 2026-07-12 | §20.5#5 |
| 13 | Безопасность: уровни allow/ask/deny + двухосевая автономия + net default-deny + git-snapshot undo | 🕓 предложено | 2026-07-12 | §20.5#7 |
| 14 | Опц. spec-режим (requirements→design→tasks) + `tasks.md` DAG-волны + steering/hooks | 🕓 предложено | 2026-07-12 | §20.3, §20.5#8 |

> Источники §20: kilo.ai/docs, docs.roocode.com, github.com/anomalyco/opencode (+ community open-docs),
> github.com/openai/codex (`apply-patch/parser.rs`, `seek_sequence.rs`, крейт-листинг), zed docs
> (zed-agent/tools/sandboxing.md + agentclientprotocol.com), moonshotai.github.io/kimi-code,
> github.com/XiaomiMiMo/MiMo-Code (+ mimo.xiaomi.com long-horizon blog), github.com/MiniMax-AI/Mini-Agent
> (`agent.py`/`file_tools.py`/`bash_tool.py`), antigravity.google + Google Dev Blog, kiro.dev/docs.
> Часть внутренних деталей помечена unverified (community-доки / leaked prompts) — сверять с исходниками
> перед реализацией. Контент перефразирован и сжат для соответствия лицензионным ограничениям.

---

## 21. Слой данных и персистентности: SQLite vs PostgreSQL 18 (вердикт)

> Прямой ответ на вопрос «зачем SQLite, если есть асинхронный PostgreSQL 18».

**Ключевое различие классов.** SQLite — встраиваемая in-process библиотека (нет сервера, порта, ролей, каталога данных). Postgres — client-server СУБД (постоянный процесс, `initdb`, роль/пароль, порт). Для приложения, которое ставит **обычный пользователь на свой ноут**, это решающий фильтр.

**Что реально даёт async I/O в PG18.** AIO/io_uring ускоряет **серверные disk-bound операции**: sequential/bitmap scans, VACUUM (заявлено «до 3×» на чтении с хранилища). Это польза для крупной БД на сервере, где данные не помещаются в кеш. Для **локальной single-user памяти** (мелкая БД, один писатель, всё в page-cache, короткие point-lookup) выигрыш практически нулевой. Прямых бенчей «PG18 AIO на маленькой single-user БД» нет — вывод логический, помечен как inference.

**«Async» — это про драйвер, а не про сервер.** Неблокирование Node event-loop определяется драйвером: `better-sqlite3` синхронный (но настолько быстрый, что для типичных запросов выгоднее async-оверхеда; тяжёлые операции → `worker_threads`); `node:sqlite` — встроен в Node, без node-gyp (проще сборка под 3 ОС); `pg`/`postgres.js` async по сети — но «async» тут = сетевой I/O к внешнему серверу со всей его операционной ценой.

**Вектор/FTS (всё free & self-hostable):**
- **sqlite-vec** (MIT/Apache-2, один C-файл, npm) — вектора в том же файле SQLite; brute-force сейчас, ANN для vec0 подъезжает.
- **LanceDB** — embedded, disk-native, IVF/IVF-PQ, отличный Node — если векторов станет много (сотни тыс.+).
- **pgvector** (IVFFlat/HNSW) — только если пользователь уже на Postgres.
- **FTS5** (SQLite) закрывает reviewable keyword-память полностью и бесплатно; PG tsvector+pg_trgm — только на Postgres-бэкенде.

**ВЕРДИКТ для Kyrei:**
- **Default (ship, embedded):** SQLite в WAL (`better-sqlite3`, тяжёлое в worker; либо `node:sqlite` чтобы убрать node-gyp) + **sqlite-vec** (вектора) + **FTS5** (keyword). JSONL-транскрипт на сессию остаётся source of truth, SQLite — индекс/срез поверх.
- **Optional (power-user/команда):** PostgreSQL 18 + pgvector + tsvector за интерфейсом репозитория; LanceDB — опц. векторный слой при росте объёма.
- **Migration path заложить сразу:** доступ за port-интерфейсами (`MemoryStore`/`SessionStore`/`VectorStore`), schema-agnostic миграции, абстракция вектор/FTS (sqlite-vec↔pgvector, FTS5↔tsvector), контракт-тесты против обоих бэкендов.
- **Суть ответа:** SQLite не «проще-и-хуже», а **архитектурно правильнее для local-first single-user desktop**. PG18 решает проблемы, которых у нас нет (высокая конкурентность записи, большие сканы), и создаёт те, что мы избегаем (сервер/порт/роли/bundling под 3 ОС). Postgres — отличный опциональный апгрейд ровно когда пользователь выходит за рамки local-first.

**Журнал решений — #15:** «Слой данных: SQLite(WAL)+sqlite-vec+FTS5 by default; Postgres18+pgvector — optional за repo-интерфейсом» — ✅ принято (2026-07-12).

## 22. Память / контекст / знания (headroom · gbrain · graphify · SkillOpt)

- **headroom** (Python, `pip`, offline, MCP/proxy) — «context optimization layer». Взять идеи (портировать на TS):
  - **CCR (Compress-Cache-Retrieve):** любое сжатие **обратимо** — оригинал в store по SHA-256, в контекст инжектится тул `retrieve(hash)`; модель сама достаёт, если не хватило. Устраняет главный риск компакции — потерю нужного. (Для десктопа заменить их TTL-5-мин на дисковую персистентность.)
  - **Live-zone-only компакция:** жать только новейший блок, не трогать system-prompt/старые turn'ы → prefix-cache горячий.
  - **Иерархические скоупы памяти user/session/agent/turn + bubbling** важного вверх + temporal `supersede` (версионирование фактов).
  - **Детерминированная статистическая компакция tool-output** (constants-extraction, change-points) ДО всякого LLM-summary.
- **gbrain** (TS/Bun, MIT, MCP, PGLite/pgvector) — «brain layer». Взять:
  - **Markdown-git как source of truth, БД — лишь индекс** (human-readable, git-версионируемо, портируемо) — идеально для local-first.
  - **Self-wiring типизированный граф на wikilinks `[[...]]` без LLM** — детерминированно, +31 п. P@5 над vector-only.
  - **Гибрид retrieval:** vector + BM25 + **RRF** + rerank, с `--explain`; локальный fallback-эмбеддер ради офлайна.
  - **«Dream cycle»** — фоновая idle-консолидация: дедуп, поиск противоречий, salience-scoring, починка ссылок.
  - **`think` с gap-analysis** («чего я НЕ знаю / что устарело / где противоречия»).
- **graphify** (Python, tree-sitter, локально) — код→граф знаний. Взять:
  - **Детерминированный AST-слой первым (tree-sitter, 25 языков), LLM только для того, что нельзя распарсить** — режет стоимость и галлюцинации; код в LLM не шлётся.
  - **Confidence-tag на рёбрах** (EXTRACTED=1.0 / INFERRED 0.55–0.95 / AMBIGUOUS).
  - **SHA-256 контент-кэш** для инкрементального переиндексирования.
  - **Граф-как-компрессия:** отвечать из компактного графа вместо сырого чтения (десятки× экономии на больших репо; на мелких — не включать).
- **SkillOpt** (Microsoft, MIT, offline batch) — «навыки как обучаемые параметры». Взять:
  - **Validation-gate на любую самоправку памяти/навыка** — изменение принимается только если измеримо улучшает held-out метрику (защита от «уверенной деградации»).
  - **Bounded add/delete/replace edits** вместо переписывания (git-diff-friendly), + rejected-edit buffer.
  - **Sleep-паттерн `harvest→mine→replay→consolidate`** для idle-самоулучшения steering/skill-файлов (синергия с gbrain dream cycle).
- **Курс-ориентир:** DeepLearning.AI «LLMs as Operating Systems: Agent Memory» (MemGPT/Letta — memory-tiers/paging) — каркас для нашего слоя памяти. Поддержать открытый стандарт **Agent Skills** как формат переносимого знания.

**Сквозной анти-паттерн:** не терять данные безвозвратно при сжатии (headroom CCR) и не менять память/навыки без измеримой валидации (SkillOpt gate).

## 23. Провайдеры / роутинг / микс аккаунтов (OmniRoute · Mysti · ECC · AWS toolkit)

- **OmniRoute** (TS 6, Node 22/24, better-sqlite3, Electron, MIT, self-hostable) — **единственный прямой референс для провайдер-слоя Kyrei; тот же стек.** Взять:
  - **BaseExecutor→DefaultExecutor+override** паттерн; OpenAI↔Anthropic↔Gemini↔Responses трансляция; реестр моделей с лимитами/стоимостью (models.dev + LiteLLM); ключи **AES-256-GCM**.
  - **3-слойная устойчивость:** circuit-breaker → cooldown → model-lockout; **combos с 4-уровневым fallback**; cost-aware routing.
  - **Quota-Share:** Deficit-Round-Robin по весам между ключами одного аккаунта + **session-affinity ради prompt-cache**.
  - **Легальная мульти-аккаунт-ротация** (несколько своих API-ключей/OAuth) — берём.
- ⚠️ **Account-mixing (браузерные/не-API аккаунты) — ПОДТВЕРЖДЁН, но НЕ берём.** OmniRoute реально заворачивает cookie-session провайдеров (ChatGPT Web, Claude Web, grok-web и др.) через TLS-fingerprint spoofing (JA3/JA4) + MITM/TPROXY-перехват. Это **нарушение ToS, бан-риск, хрупкость, юр/репутационный риск**. Для Kyrei — ограничиться официальными OAuth + API-ключами; browser-bridging НЕ копировать (в §9 анти-паттернов).
- **Mysti** (DeepMyst) — не роутер, а VS Code-расширение поверх 12 внешних CLI. Взять: brainstorm/multi-agent debate с **convergence detection**, @-mention роутинг с чейнингом. Избегать: «обёртка над чужими CLI» как провайдер-слой (нет failover/cost-routing).
- **ECC** (affaan-m) — «agent harness OS» (skills/agents/hooks/rules). Взять: secret-detection хуки, **GateGuard** (гейт деструктивных команд), cost-aware-llm-pipeline. Звёзды/метрики неправдоподобны — скептично.
- **AWS agent-toolkit** — MCP-серверы + skills для доступа к AWS. Взять: **IAM-разграничение agent-vs-human + CloudTrail-аудит каждого запроса**, on-demand SKILL.md (Kiro-совместим), пиннинг версий против supply-chain. Избегать: managed-cloud привязку.

**Модель провайдер-слоя Kyrei (синтез):** реестр моделей (лимиты/стоимость/возможности) → роли моделей по интенту (default/smol/plan/commit) → proactive+reactive fallback-цепочки → round-robin ключей с session-affinity → circuit-breaker/cooldown → cost/observability (токены/стоимость на ход). Ключи в OS-keychain или AES-256-GCM. Только легальные аккаунты.

## 24. Харнессы / loop (claude-code-harness · SocratiCode · supergoal · Webwright · shannon · tolaria)

> 2 из 6 — НЕ harness'ы: **SocratiCode** = context-engine (AGPL, локально, Qdrant+Ollama), **Tolaria** = markdown-KB desktop (Tauri2). Релевантны по context/memory, не по loop.

- **claude-code-harness** (Go, MIT, обвязка над Claude Code). Взять:
  - **`spec.md`+`Plans.md` как source of truth** с явными `stop conditions` и `unknown`-полями.
  - **Фазовые gate'ы** (Investigate→Plan→Work→Review→PR→Release), «review отделён от implementation, major = blocker».
  - **Machine-checked claims** («written != working»): ворот проверяет, что код реально wired/ребилдится, а не «агент сказал done».
- **supergoal** (skill для Claude Code/Codex, MIT). Эталон long-horizon. Взять:
  - **Adaptive phase-count** (число фаз выводится из задачи, не фикс).
  - **План как файлы на диске** (`ROADMAP/STATE/phase-N.md`) + end-state-условие вместо длинного prompt-тела → нет char-budget, нет хрупкой inter-session цепочки.
  - **3-strike self-healing:** probe→retry → fix-spec → handoff (человек за руль).
  - **FINAL AUDIT против baseline sha по всему working-tree** + cleanliness-grep — сильнейший анти-«fake-done».
  - **Memory writeback на границе каждой фазы**; honest «audit coverage %».
- **Webwright** (Microsoft Research, Python ~1.5k LoC). Взять:
  - **Code-as-action:** агент пишет скрипт, а не дёргает микро-тулы по одному → меньше раундов/накопления ошибок.
  - **Workspace-as-state, не сессия-as-state:** персистентный артефакт = код+логи+скриншоты на диске; окружение эфемерно.
  - **Lazy-observation** (снимать состояние только когда нужно); минимализм ядра (~450-строчный loop); `craft` — превращать успешный прогон в переиспользуемый параметризованный инструмент.
- **shannon** (Node, AGPL, Docker) — автономный пентестер (multi-agent phased). Взять (игнорируя offensive):
  - **Phased pipeline с параллельным fan-out специализированных агентов** (recon→parallel workers→verify).
  - **Proof-by-execution:** результат принимается только с воспроизводимым доказательством.
  - **Эфемерный контейнер + read-only mount источника** как дефолт sandbox; **resumable workspaces** (skip завершённых суб-агентов).
  - **Rules-of-engagement/authorization + предупреждение о prompt-injection из читаемого чужого кода** — критично для coding-агента, который ест чужие репо. `llms.txt` как машинная карта проекта.
  - ⚠️ Мигрирует на «**Pi Harness (beta)**» — совпадает с окружением `pi cli`; изучить отдельно.
- **SocratiCode** (context-engine). Взять: **AST-aware chunking + resumable/checkpointed indexing** (crash-safe, hash-skip); **shared index + cross-process lock** (несколько агентов делят индекс); принцип **«search-before-read»** в системный промпт; context-artifacts (DB-схема/OpenAPI/ADR с полем «когда обращаться»). Избегать: обязательный Docker (нужен embedded-fallback sqlite-vec).
- **Tolaria** (Tauri2 desktop KB). Взять: манифест **files-first + git-first + offline-first + zero lock-in**; markdown+YAML-frontmatter vault как memory-backend через MCP; инженерный процесс (ADR + ARCHITECTURE-доки). Подтверждает Tauri как альтернативу Electron (см. §26).

## 25. Feature-mining крупных агентов (Kiro · Hermes · opencode · pi/omp · Claude Code · Codex · oh-my-openagent · Kilo · Warp)

**Kiro** (углублённо): spec = 3 артефакта в `.kiro/specs/{feature}/` (**EARS**-требования `WHEN…THE SYSTEM SHALL…`), approval-gates, типы спеков (bugfix/design-first/requirements-first/fast); **Run all Tasks** — авто-граф зависимостей, конкурентный запуск.
- **«Чистое окно с перенесённым знанием»** (то, что просил пользователь): спек + статусы задач = persistent state, переживающий смену окна → новое окно **перечитывает спек+статус, а не историю чата**. **Ralph-loop**: после задачи контекст выбрасывается, следующая стартует в новой сессии. Subagents с изолированным контекстом. Индустриальный принцип: **полный reset окна + структурированный distilled handoff-артефакт > лоссовая compaction** (борьба с «context anxiety»). → **берём: чистое-окно-на-задачу + distilled handoff-артефакт.**

**Hermes** (non-GUI, из локального исходника — секреты не читались):
- **Конституция движка:** «prompt caching is sacred» (не мутировать прошлый контекст / не свопать toolset в середине); «narrow waist» (каждый core-tool в каждом вызове); **Footprint Ladder** (extend → CLI+skill → service-gated tool → plugin → MCP-в-каталоге → new core-tool крайний случай).
- **Composable toolsets** (`includes` + cycle-detection); **service-gated tools через check_fn** (в схеме только если сконфигурен prerequisite); **webhook-safe урезанный toolset** против prompt-injection.
- **MoA-как-режим** (`/moa`): fan-out reference-моделей (cap 8) → aggregator; per-advisor биллинг; advisory-view (tool_calls→текст).
- **Delegation:** дочерние агенты с изолированным контекстом/toolset; родитель видит только summary; **summary headroom budget** (0.5 окна ÷ N детей — против compression-spiral); blocked-tools для leaf; depth-cap+kill-switch; live pause/interrupt/heartbeat.
- **Единый COMMAND_REGISTRY** генерит все поверхности (CLI/gateway/меню); learning loop (авто-скиллы + FTS5 session-search); cron.

**opencode** (доп): `.opencode/` конфиг + commands-markdown; out-of-process плагины с хуками; **permissions engine** (glob allow/deny/ask, `.env` deny-by-default, **doom-loop detection**); нативная **LSP** (def/refs/hover/symbols); Plan mode; client/server (`opencode serve`=HTTP API); org-конфиг.

**pi cli (π) + oh-my-pi (omp)** — вероятный источник пути воркспейса (`.omp-runtime/` в корне):
- **Pi:** минимальный harness (4 тула, ~200-ток промпт), всё opt-in через TS Extensions/Skills; 4 entry-point из одного движка (TUI/print-JSON/RPC-stdio/SDK); **JSONL-дерево сессий** (id/parentId, `/tree /fork /clone`); message queue (Enter=steering, Alt+Enter=follow-up); **Project Trust**; **25+ in-process TS-хуков** (`input`, `before_agent_start` per-turn prompt, `context` прунинг, `session_before_compact`) — естественно для Node/Electron Kyrei.
- **omp** (Rust форк, batteries-included): **hashline edit** (content-hash якоря, stale→reject, −61% токенов); **LSP в каждый write**; time-traveling stream rules (regex прерывает стрим, инъектит правило, ретраит); schema-validated результат субагентов + advisor-модель; **model-роли по интенту** (default/smol/slow/plan/commit) + fallback + round-robin credentials + path-scoped; **FS-shaped :// схемы** (pr://, issue://, `agent://<id>/findings`); **Hindsight** память (retain/recall/reflect, SQLite); /collab; tool-pinning + BM25-подтяжка.

**Claude Code:** 7 слоёв управления (**CLAUDE.md память ≠ rules ≠ skills ≠ subagents ≠ hooks ≠ output styles ≠ append-prompt**); hooks как детерминированный enforcement (lint на `PostToolUse` там, где CLAUDE.md мягко проваливается); Plan Mode; 4 permission-режима + allowlist bash; `/compact` vs `/clear`, rewind/checkpointing; codemaps (навигация без сжигания контекста).

**Codex** (доп): **иерархический AGENTS.md** (`.override.md` → от git-root к cwd, лимит 32 KiB); **двухосевая безопасность** (`approval_policy` × `sandbox_mode`); named profiles (`--profile ci`) + inline `-c`; `codex exec --json/--ephemeral` (CI/headless); resume/`/fork`/`/side`; org-level `requirements.toml`; Codex сам как MCP-сервер.

**oh-my-openagent** (TS/bun поверх OpenCode): **Category × Skill** (модель/mindset под домен отдельно от инструментов/знаний); **файловый Task System** (`.omo/tasks/*.json`, `blockedBy`/`blocks`, автопараллелизация, переживает рестарт); **runtime-fallback** цепочки моделей на 429/5xx + session recovery (компакция при overflow); **Sisyphus-Junior** (делегату запрещено ре-делегировать); background agents + tmux-панели; hashline-edit; Claude Code compat layer (читает `.claude/*`); `/handoff` + preemptive-compaction.

**Kilo** (доп): **Memory Bank** (markdown-файлы `projectbrief/activeContext/progress...` на cold-start + видимый индикатор `[Memory Bank: Active]`); **checkpoints / «AI time-travel»** (правка сообщения N шагов назад → авто-откат последующих чекпоинтов); custom modes (`.kilocodemodes`, гранулярный tool-access); Marketplace (modes/skills/MCP); **REVIEWS.md** (обучение из PR-фидбэка).

**Warp** (Rust, клиент open-source с 28.04.2026, но AI-бэкенд проприетарен/хостед). Для command-тулинга Kyrei взять:
- **Blocks-модель:** каждая команда+вывод = блок с exit code/duration/ID → агент навигирует/цитирует конкретный блок вместо парсинга «стены» вывода; шаринг блока как артефакта.
- **Active AI-слой** (подсказка next-command / inline-diff на основе exit-кодов); **MCP авто-дискавери** из `~/.claude.json`/`.mcp.json`/`.codex/config.toml`; **Warpify** (сохранять контекст агента через SSH/docker/kubectl); параметризованные версионируемые Workflows.
- Избегать: привязки «open-source»-фич к обязательному хостед-бэкенду; кредитной модели; разнородного лицензирования; GPU-зависимости без fallback.

## 26. Десктоп-шелл: Electron vs Pake/Tauri + UI/дизайн-тулинг + swarm

**Вердикт по шеллу: остаёмся на Electron. Pake — отклонить. Tauri — в бэклог как «фаза оптимизации дистрибутива».**
- **Pake** (Rust/Tauri-обёртка) = упаковщик готовых сайтов **без backend-рантайма** — не может штатно хостить наш Node-движок/gateway, требует живой URL. Не наш сценарий. Взять только *приёмы*: frameless UI, tray, `--inject` CSS/JS, `--use-local-file` (offline).
- **Electron сейчас выигрывает:** Node в main-процессе из коробки (движок/gateway/`child_process`/contextBridge уже работают), единый Chromium (нет фрагментации рендера). Цена — размер/RAM.
- **Tauri (не Pake)** — реальная альтернатива на будущее: крошечный бинарь + низкий RAM, но Node пришлось бы гонять **sidecar-процессом** (через наш же HTTP/SSE — он у нас уже есть) + **фрагментация webview** (WebView2/WKWebView/**WebKitGTK** — слабое звено на Linux). Прототип «Tauri + Node-sidecar» — если размер/память станут болью, с ранним тестом на WebKitGTK.

**UI/дизайн-тулинг:**
- **ui-layouts/ui-tools** (React+Tailwind, copy-paste) — генераторы теней/фонов/clip-path/mesh-gradients для темизации; `cn()`/`useMediaQuery`. Точечно, без завязки на `motion`.
- **DESIGN.md** (Google Labs, Apache-2.0, открытый формат) — YAML design-tokens + markdown-проза-обоснование как переносимый «дизайн-контракт». **Поддержать формат в Kyrei** (читать/уважать при генерации UI) без зависимости от сервисов designmd.supply / styles.refero.design (SaaS, тарифы/лицензии непрозрачны).
- **styles.refero.design** — паттерн «реальный референс + DESIGN.md + CSS-tokens»: давать агенту референс, а не описание вкуса по памяти.

**Swarm/misc:**
- **T3MP3ST** (elder-plinius) — offensive red-team meta-harness от jailbreak-автора. **Прямой релевантности нет; риски (репутация/supply-chain/jailbreak-экосистема).** Максимум — нейтральная идея «meta-harness: единый UI/API над несколькими агентами + install-matrix зависимостей». Код/промпты/интеграции — НЕ брать.
- **Pentest-Swarm-AI** (Go, AGPL) — паттерны роевой координации (offensive отбрасываем). Взять для **read-роя** (§2):
  - **Stigmergy:** координация через общий **blackboard** с **pheromone-weight**, затухающим со временем (stale-пути умирают сами; half-life по типу находки).
  - **Emergence:** порядок работы возникает из состояния доски, а не фикс-пайплайна; **trigger-predicate** у каждого агента (новый агент вступает в рой без переписывания оркестратора).
  - **Cleanup registry** (reverse-order на SIGINT/бюджет); prompt-caching стабильного префикса; единый provider-config на весь рой.
  - Совпадает с нашим §2: рой — только для read/исследования; писатели — строго один. AGPL-код не тащить (копилефт), брать идеи. Ложится на `.omp-runtime/orchestration`.

## 27. Синтез волны 2 + обновление трекера/журнала

### 27.1 Приоритетный backlog памяти/контекста/провайдеров (свод §21–§26)

1. **Слой данных:** SQLite(WAL)+sqlite-vec+FTS5 by default за port-интерфейсами; Postgres18+pgvector — opt. (§21).
2. **Память (слоёная, обратимая, валидируемая):** markdown-git source-of-truth + SQLite-индекс (gbrain); **CCR** обратимое сжатие с `retrieve(hash)` (headroom); иерархия user/session/agent/turn + bubbling; **чистое-окно-на-задачу + distilled handoff** (Kiro); self-wiring граф на wikilinks + гибрид vector+BM25+RRF+rerank; idle-консолидация «dream/sleep» с **held-out validation-gate** (gbrain+SkillOpt).
3. **Контекст-окно:** live-zone-only компакция + prefix-cache-стабильность (headroom); детерминированная статистическая компакция tool-output до LLM-summary; двойной токен-триггер (§20).
4. **Ретрив по коду:** AST-chunking + resumable/checkpointed index + shared-index-lock + search-before-read (SocratiCode); граф-как-компрессия с confidence-тегами + SHA-256 инкрементальность (graphify); embedded-fallback без Docker.
5. **Провайдер-слой:** реестр моделей (лимиты/стоимость) + роли по интенту + proactive/reactive fallback-цепочки + round-robin ключей с session-affinity + circuit-breaker/cooldown/lockout + cost/observability (OmniRoute/omp); ключи в keychain/AES-256-GCM; **только легальные аккаунты** (browser-bridging — анти-паттерн).
6. **Оркестрация/loop:** план-как-файлы (`ROADMAP/STATE/phase-N.md`) + adaptive phases + end-state-условие (supergoal); proof/evidence-gated verification (harness/shannon/supergoal FINAL AUDIT); 3-strike self-healing; delegation с headroom-budget+depth-cap+blocked-tools (Hermes); schema-validated субагенты (omp); Task System с DAG (oh-my-openagent); read-рой на stigmergy-blackboard (Pentest-Swarm).
7. **Расширяемость:** narrow-waist + Footprint Ladder + service-gated check_fn (Hermes); in-process TS-хуки `input/before_agent_start/context/session_before_compact` (pi); commands-markdown + AGENTS.md + steering inclusion-modes; Category×Skill (oh-my-openagent); MCP авто-дискавери чужих конфигов (Warp).
8. **Терминал-тулинг:** Blocks-модель (Warp) — команда+вывод как блок с exit-code/ID; bg-process manager.
9. **Правки:** hashline/content-hash edit (pi/omp) в дополнение к контекст-якорному apply_patch (§20).
10. **Шелл:** Electron сейчас; Tauri+Node-sidecar — бэклог оптимизации; DESIGN.md-формат для генерации UI.

### 27.2 Трекер (§10) — добавить

| Инструмент | Категория | Что берём | Что НЕ берём | Статус |
|---|---|---|---|---|
| SQLite+sqlite-vec+FTS5 | слой данных | embedded default, вектор+FTS в одном файле | — | ✅ default |
| PostgreSQL 18 + pgvector | слой данных | opt. power-user бэкенд, AIO/MVCC для их сценария | сервер/порт/bundling как дефолт | ✅ optional |
| headroom | контекст | CCR (обратимое сжатие), live-zone компакция, скоупы+bubbling | Python-рантайм как дефолт, TTL-5мин, ML-компрессор | ✅ идеи (портировать TS) |
| gbrain | память | markdown-git+индекс, self-wiring граф, vector+BM25+RRF, dream cycle, think+gap-analysis | переусложнение (43 скилла), внешний rerank как дефолт | ✅ ключевой ориентир памяти |
| graphify | ретрив кода | AST-first + LLM-fallback, confidence-теги, SHA-256 кэш, граф-как-компрессия | граф на мелких проектах, полный отказ от векторов | ✅ идеи |
| SkillOpt | самообучение | validation-gate, bounded edits, sleep-консолидация | дорогая frontier-optimizer в hot-path | ✅ идеи |
| OmniRoute | провайдер-слой | executor+override, fallback-combos, quota-share, cost-routing, AES-ключи | **browser account-mixing (ToS/бан)**, маркетинг-цифры | ✅ прямой референс |
| Mysti | мульти-агент | debate+convergence detection, @-mention chaining | обёртка над чужими CLI как провайдер | ✅ идея |
| AWS agent-toolkit | безопасность | IAM agent-vs-human + CloudTrail-аудит, on-demand SKILL.md, пиннинг версий | managed-cloud привязка | ✅ идеи |
| claude-code-harness | loop | spec/Plans как SoT, фазовые gate, machine-checked claims | host-lock (Claude Code), 22-skill поверхность | ✅ идеи |
| supergoal | long-horizon | план-как-файлы+end-state, adaptive phases, 3-strike heal, FINAL AUDIT vs baseline | host-lock, автономность без permission-ворот | ✅ ключевой long-horizon |
| Webwright | executor | code-as-action, workspace-as-state, lazy-observation, craft→tool | нет оркестрации/памяти/sandbox сверху | ✅ идеи |
| shannon / Pi Harness | multi-agent | phased fan-out, proof-by-exec, эфемерный контейнер+RO-mount, resumable, RoE+injection-warning | Claude-lock, обязательный Docker | ✅ идеи (+изучить Pi Harness) |
| SocratiCode | context-engine | AST-chunk+resumable index, shared-index lock, search-before-read | обязательный Docker (Qdrant+Ollama) | ✅ идеи |
| Tolaria | desktop KB | files/git/offline-first манифест, md-vault как memory, ADR-процесс | types-as-lenses без схемы для agent-state | ✅ идеи + Tauri-сигнал |
| Kiro (deep) | workflow | EARS-спеки, чистое-окно+distilled handoff, Run-all-Tasks DAG | принуждение к спекам | ✅ идеи |
| Hermes (engine) | движок | narrow-waist+Footprint Ladder, composable toolsets+check_fn, MoA-режим, delegation+headroom-budget, command-registry | мутация контекста/своп toolset в середине | ✅ конституция движка |
| pi/omp | движок | JSONL-дерево сессий+ветвление, in-process TS-хуки, Project Trust, model-роли+fallback, hashline edit, Hindsight | догм. отказ от MCP/subagents (Pi), YOLO без trust-гейта | ✅ ключевой ориентир |
| oh-my-openagent | оркестрация | Category×Skill, Task System DAG, runtime-fallback+session recovery, no-redelegate | взрыв агентов/hooks без доков, ralph без max-iter | ✅ идеи |
| Kilo (deep) | память/undo | Memory Bank + индикатор, checkpoints/time-travel, custom modes, REVIEWS.md | stale Memory Bank без правил обновления | ✅ идеи |
| Warp | терминал | Blocks-модель, Active AI, MCP авто-дискавери, Warpify, Workflows | хостед-AI-бэкенд, кредиты, GPU-lock | ✅ идеи |
| Pake | шелл | приёмы (frameless/tray/inject/offline) | как продуктовый шелл (нет backend) | 🚫 не шелл |
| Tauri | шелл | крошечный бинарь+низкий RAM (sidecar Node) | webview-фрагментация (WebKitGTK), переписывание | ⏳ бэклог оптимизации |
| DESIGN.md | дизайн-контекст | открытый формат токенов+проза для генерации UI | SaaS-зависимости (designmd/refero) | ✅ поддержать формат |
| Pentest-Swarm | read-рой | stigmergy-blackboard+pheromone-decay, trigger-predicate, cleanup-registry | AGPL-код, offensive-обвязка, стигмергия для писателей | ✅ идеи координации |
| T3MP3ST | — | (максимум идея meta-harness) | код/промпты/jailbreak-экосистема | 🚫 не берём |

### 27.3 Журнал решений (§11) — добавить

| # | Решение | Статус | Дата | Примечание |
|---|---|---|---|---|
| 15 | Слой данных: SQLite(WAL)+sqlite-vec+FTS5 default; Postgres18+pgvector opt. за repo-интерфейсом | ✅ принято | 2026-07-12 | §21 |
| 16 | Память: markdown-git SoT + SQLite-индекс + CCR (обратимое сжатие) + иерархия скоупов | 🕓 предложено | 2026-07-12 | §22, §27.1#2 |
| 17 | Чистое-окно-на-задачу + distilled handoff-артефакт (не лоссовая compaction) | 🕓 предложено | 2026-07-12 | §25 Kiro, §27.1#2 |
| 18 | Idle-консолидация памяти (dream/sleep) с обязательным held-out validation-gate | 🕓 предложено | 2026-07-12 | §22, §27.1#2 |
| 19 | Провайдер-слой: реестр+роли по интенту+fallback-цепочки+round-robin+circuit-breaker+cost/obs | 🕓 предложено | 2026-07-12 | §23, §27.1#5 |
| 20 | Account-mixing браузерных аккаунтов — НЕ реализуем (ToS/бан/юр-риск); только легальные OAuth/API | ✅ принято | 2026-07-12 | §23, §9 |
| 21 | Long-horizon: план-как-файлы + adaptive phases + end-state + FINAL-AUDIT + 3-strike self-heal | 🕓 предложено | 2026-07-12 | §24, §27.1#6 |
| 22 | Расширяемость: narrow-waist+Footprint Ladder+in-process TS-хуки+Category×Skill | 🕓 предложено | 2026-07-12 | §25, §27.1#7 |
| 23 | Шелл: остаёмся на Electron; Tauri+Node-sidecar — бэклог оптимизации; Pake отклонён | ✅ принято | 2026-07-12 | §26 |
| 24 | Ретрив: AST-chunk+resumable index+search-before-read+граф-как-компрессия (embedded, без Docker) | 🕓 предложено | 2026-07-12 | §22/§24, §27.1#4 |

### 27.4 Дополнение к анти-паттернам (§9)

- ❌ **Браузерный account-mixing / bridging cookie-session аккаунтов в API** (OmniRoute) — нарушение ToS, бан-риск, TLS-spoofing/MITM, юр/репутационный риск. Только легальные OAuth + API-ключи.
- ❌ **Postgres-сервер как дефолтный слой данных десктопа** — операционная цена (процесс/порт/роли/bundling) без выгоды для single-user (§21).
- ❌ **Pake как продуктовый шелл** — нет backend-рантайма для нашего Node-движка (§26).
- ❌ **Необратимое сжатие контекста** — терять данные при компакции; всегда обратимость через retrieve/handoff (headroom CCR).
- ❌ **Самоправка памяти/навыков без held-out validation-gate** — «уверенная деградация» (SkillOpt).
- ❌ **Обязательный тяжёлый Docker для «free desktop»** (SocratiCode/shannon) — нужен embedded-fallback.
- ❌ **Интеграция jailbreak/offensive-экосистемы** (T3MP3ST) — репутационный/supply-chain риск; брать максимум нейтральную идею, не код.
- ⚠️ **Догматичный отказ от MCP/subagents/plan** (Pi) — для продукта нужен batteries-included дефолт (omp это исправил форком).

> Источники §21–§26: postgresql.org (release 18.0/beta1/presskit18), sqlite.org, better-sqlite3/node:sqlite,
> asg017/sqlite-vec, lancedb, pgvector; github: chopratejas/headroom, garrytan/gbrain, safishamsi/graphify,
> microsoft/SkillOpt, viveknaskar/everything-ai-ml, diegosouzapw/OmniRoute, DeepMyst/Mysti, affaan-m/ECC,
> aws/agent-toolkit-for-aws, Chachamaru127/claude-code-harness, giancarloerra/SocratiCode, robzilla1738/supergoal,
> microsoft/Webwright, KeygraphHQ/shannon, refactoringhq/tolaria, tw93/Pake, ui-layouts/ui-tools,
> elder-plinius/T3MP3ST, Armur-Ai/Pentest-Swarm-AI, code-yeongyu/oh-my-openagent, warpdotdev/Warp;
> kiro.dev/docs, claude.com/blog, developers.openai.com/codex, kilo.ai/docs, pi.dev; designmd.supply,
> styles.refero.design; локальный `hermes/hermes-agent/` (секреты не читались).
> Часть данных — из community-доков/сниппетов/leaked prompts, помечена unverified; цифры (звёзды, «237 провайдеров»,
> «free unlimited») — маркетинг, проверять. Контент перефразирован и сжат под лицензионные ограничения.

---

## 28. Vercel AI SDK v5 как основа движка Kyrei (глубокий разбор + миграция)

> Фокус-рой из 3 агентов: ядро/agent-loop, локальность/провайдеры/лицензия, миграция нашего `core/kyrei-engine.js`.

### 28.1 Главное: локальность и «не звонит домой»
- **`ai` + `@ai-sdk/*` — это обычные npm-библиотеки (Apache-2.0), исполняются В нашем Node-процессе.** Нет обязательного аккаунта Vercel, нет phone-home. Сетевые запросы идут ТОЛЬКО на тот `baseURL`, который мы указали.
- **Телеметрия в v5 — opt-in, по умолчанию ВЫКЛЮЧЕНА** (`experimental_telemetry:{isEnabled:true}`), основана на OpenTelemetry и никуда не уходит без нашего экспортёра. ⚠️ В v7 она стала opt-out — при будущем апгрейде пересмотреть.
- **AI Gateway — опциональный.** Единственный нюанс: если задать модель голой строкой (`model:'openai/gpt-4o'`) без явного провайдера — по умолчанию резолвится через Vercel Gateway. **Всегда передаём явный локальный провайдер-объект** → Gateway не задействуется.
- **Полный офлайн:** `createOpenAICompatible({ baseURL:'http://localhost:11434/v1' })` → Ollama/LM Studio/llama.cpp/vLLM. Ничего не покидает машину. Лицензии всех ключевых пакетов — Apache-2.0 (безопасно для проприетарного продукта).
- **Вердикт локальности: ДА, работает полностью локально/офлайн**, при условии: (1) явный провайдер, не голая строка; (2) `ollama-ai-provider-v2` пинить `@^3.x` под v5 (4.x — только SDK7) — либо основным путём брать first-party `@ai-sdk/openai-compatible`.

### 28.2 Что SDK даёт из коробки (= убираем из нашего кода)
Наш `kyrei-engine.js` — ручная реализация того же цикла. SDK заменяет самые хрупкие/низкоценные куски:
- **Ручной SSE-парсинг** (`reader/decoder/buffer.split`, `data:`/`[DONE]`) → `for await (part of result.fullStream)`.
- **Аккумуляция `tool_calls[i]` по индексу через чанки** (самый баг-прон кусок) → SDK отдаёт готовые `tool-call` с распарсенным `input`.
- **Ручной multi-step loop** + ручная подача `role:"tool"` обратно → `stopWhen: stepCountIs(8)` + `result.responseMessages`.
- **`JSON.parse` аргументов + валидация** → Zod `inputSchema` + `repairToolCall` (ремонт кривых вызовов).
- **Ручной usage/retry** → честный `result.usage`, `maxRetries` (деф. 2).
- Бонусы: нативные `reasoning-delta` части; `abortSignal` пробрасывается и в вызов, и в `execute` тулов; approvals из коробки (`toolApproval`) под наш «подтвердить run_command»; `prepareStep`+`pruneMessages` для компакции контекста в длинных сессиях.

### 28.3 Что остаётся НАШИМ (SDK этого не делает)
- **Тела `execute` + workspace-jail** (`safePath`/realpath) — `experimental_sandbox` SDK это лишь контракт, НЕ граница безопасности. Джейл обязателен.
- **LCS/anchor line-diff** (`inline_diff`) — внутри `write_file.execute`.
- **Gateway/SSE-мост** (`core/gateway.js`), **`session-store.js`**, permission-политика, provider-registry-политика, память/контекст.

### 28.4 Мост: `fullStream` → наши события (renderer НЕ меняется)
| AI SDK part | наш `emit()` |
|---|---|
| `start` | `message.start` |
| `text-delta` | `message.delta{text}` |
| `reasoning-delta` | `reasoning.delta{text}` |
| `tool-call` | `tool.start{tool_call_id,name,args}` |
| `tool-result` | `tool.complete{...,inline_diff,duration_s}` |
| `tool-error` | `tool.complete{...,error}` |
| `finish` | `message.complete{text,status,usage}` |
| `abort` | `message.complete{status:"interrupted"}` |

Сигнатура `runKyreiChat({emit,messages,...})` и возврат `{text,parts}` сохраняются → `gateway.js`/`session-store.js`/renderer не трогаем. `inline_diff` проводим объектом из `execute` (`{result, inlineDiff}`) до моста.

### 28.5 Нюансы версий/API (перепроверять под конкретную `ai@5.x`)
`stepCountIs` (v5.0) ↔ `isStepCount` (main); `Agent` ↔ `ToolLoopAgent`; `onStepFinish` ↔ `onStepEnd`; `fullStream` ↔ `stream`; `result.toUIMessageStreamResponse()` ↔ standalone-хелперы; `experimental_repairToolCall` ↔ `repairToolCall`. v4→v5: `maxTokens`→`maxOutputTokens`, tool `parameters`→`inputSchema`, `maxSteps`→`stopWhen`.

### 28.6 Электрон/Node gotchas
- ESM (`ai`/`@ai-sdk/*` — ESM; проект уже ESM). Движок крутить в main/gateway-процессе (не в renderer).
- **`streamText` НЕ бросает ошибки** — обязателен `onError` + обработка `error`-части, иначе тихо потеряем сбой.
- **abortSignal:** заменить polling `isCancelled()` на `Map<session, AbortController>`; `/api/cancel` → `ac.abort()`; `run_command` слушает `abortSignal` → `child.kill()`.
- Bundling: включить `ai`,`@ai-sdk/openai-compatible`,`zod`,`@ai-sdk/provider*` в пакет (чистый JS, asar ок).

### 28.7 Что придётся дописать поверх SDK (ручной слой)
1. **Фолбэк «провайдер не умеет tools» (400/404/422 → retry без tools)** — `maxRetries` это не покрывает; ловим ошибку вокруг `streamText`, перезапускаем без `tools`.
2. **Провайдеры с неполным `usage`** (DeepSeek/OpenRouter/локальные) — известный краш ретрая; митигируем `includeUsage:true`/`maxRetries:1`.
3. **Model-fallback цепочки** (A→B→C) — готового примитива нет; своя middleware (`wrapLanguageModel`) с try/catch или `customProvider({fallbackProvider})`.
4. **Tool-calling слабых локальных моделей** — при необходимости `@ai-sdk-tool/parser` (промпт-режим).

### 28.8 Провалы возможностей локальных моделей (честно)
Деградирует не SDK, а модели: tool-calling ненадёжен на мелких/квантованных; structured output требует `supportsStructuredOutputs` + часто `extractJsonMiddleware` (JSON в ```code fences```); reasoning — через `extractReasoningMiddleware`. Известен баг NDJSON-стриминга tool-calls Ollama (лечится `stream:false`). Всё латается middleware.

### 28.9 РЕШЕНИЕ (#25) и фазовый план
**AI SDK v5 как основа — ДА, тонкой обёрткой.** `streamText({ model: createOpenAICompatible(...), tools: tool()+Zod, stopWhen: stepCountIs(8), abortSignal, onError })`; тела `execute` = наш текущий `executeTool` + jail + diff; мост `fullStream→emit`. Движок → TypeScript (изолированно, один файл `core/kyrei-engine.ts`), gateway/store остаются JS. Внедрять за флагом `KYREI_ENGINE=v2`, старый движок держать до прогона матрицы провайдеров (OpenAI/DeepSeek/OpenRouter/локальный Ollama/LM Studio: стрим, tools, cancel, usage, fallback-без-tools). Оценка: ~1–2 дня.
- **Фаза 0:** deps (`ai`,`@ai-sdk/openai-compatible`,`zod`) + TS-сборка одного файла.
- **Фаза 1:** `kyrei-engine-v2.ts` с идентичной сигнатурой; флаг в gateway.
- **Фаза 2:** `AbortController` в gateway (совместим с обоими движками).
- **Фаза 3:** матрица провайдеров + Ollama-локальный дефолт (`localhost:11434/v1`).
- **Фаза 4:** v2 по умолчанию, v1 за флагом ещё релиз, затем удалить транспортный код.

**Журнал решений — #25:** «Фундамент движка = AI SDK v5 (A1) тонкой обёрткой; локальные модели через `@ai-sdk/openai-compatible`; движок→TS; внедрение за флагом `KYREI_ENGINE=v2`» — ✅ принято (2026-07-12), заменяет открытый пункт #3.
**#26:** «Локальный inference по умолчанию — Ollama (`localhost:11434/v1`, OpenAI-совместимый); внешние API опционально; НИКОГДА не использовать голую строку-модель (иначе Vercel Gateway)» — ✅ принято (2026-07-12).

> Источники §28: ai-sdk.dev / v5.ai-sdk.dev / sdk.vercel.ai (generating-text, tools-and-tool-calling,
> loop-control, provider-management, middleware, telemetry, migration-guide-5-0), github.com/vercel/ai
> (LICENSE Apache-2.0, content/docs, common-errors), @ai-sdk/openai-compatible docs, ollama.com/blog
> (openai-compatibility, streaming-tool), github ollama-ai-provider-v2. Часть API помечена version-uncertain
> (v5.0 GA ↔ main) — сверять под вендоримую `ai@5.x`. Контент перефразирован под лицензионные ограничения.

---

## 29. Решение по Rust + формальный спек движка (kyrei-engine)

**Rust (решение #27, принято 2026-07-12):** ядро агентного цикла остаётся на **TS + AI SDK v5** — цикл I/O-bound, Rust там не ускоряет (узкое место — LLM), но заберёт зрелость SDK и добавит языковую границу к нашему TS/Electron-рендеру. Rust — точечно, позже: CPU-hot подсистемы (индексация/поиск/дифф/эмбеддинги) через `napi-rs`, либо при переходе на Tauri-шелл. Прецедент codex/omp обманчив (они выбрали Rust ради single-binary distribution + OS-песочницы, не ради скорости LLM-цикла).

**Формальный спек (#28):** создан `.kiro/specs/kyrei-engine/` (requirements/design/tasks) — синтез §20–§28. 13 требований (EARS), дизайн с 14 Correctness Properties + Honest Limits + Eval Harness + Verification Gate + Cross-platform, 8 фаз задач (strangler-fig за флагом `KYREI_ENGINE=v2`).

**Hardening спека роем ревью-агентов (5 линз):** выловлены и внесены правки — устаревшая v4-таблица частей стрима → актуальные v5 (`text-*`/`reasoning-*`/`tool-input-*`/`tool-call.input`/`tool-result.output`/`finish`), `result.responseMessages` → `(await result.response).messages`, единый источник ошибки (только `error`-часть), prepareStep не рвёт tool-пары; EOL/BOM/EOF-сохранность (нормализация только для сравнения, не для записи), транзакционная мультифайловая правка, атомарная запись, refuse бинарных/no-op; честная безопасность (в Node без OS-песочницы нельзя гарантировать network-deny/командный containment/атомарный TOCTOU — задокументировано + опц. sandbox-порт), секрет-редакция во всех каналах, prompt-injection из недоверенного контента; штатные `ai/test`-утилиты (`MockLanguageModelV2`+`simulateReadableStream`) вместо самодельного SSE-сервера + отдельный provider-contract тест; дедуп памяти с `ltm/`; выбор `node:sqlite` (без node-gyp) + `asarUnpack` для sqlite-vec + single-writer WAL; измеримое «лучше аналогов» (Req 13: edit_success ≥95%, 0 jail-escape/secret-leak, не хуже v1 по steps/tokens). Добавлены задачи: system-prompt-дизайн, config-схема+UI, маппинг персиста, тесты Фазы 4, observability, CI-matrix, OS-sandbox port.

---

## 30. Второй проход ревью-роя + turnkey-блюпринты ядра

Рой (5 линз) прошёл по обновлённому спеку: (1) consistency-аудит нашёл orphan-требования (2.5/4.9/4.10/4.11/7.8/7.9) и **жёсткий гейт: exact-pin `ai@5.0.x`** (иначе `npm i` утащит v6 и сломает `stepCountIs`→`isStepCount`, `MockLanguageModelV2`→V3) — исправлено; (2–5) написаны 4 turnkey-блюпринта в `.kiro/specs/kyrei-engine/`:

- **blueprint-orchestrator-provider.md** — `runKyreiChat` на `streamText`, полный switch `fullStream`→события (все v5-части), provider registry/build/fallback/no-tools (peek первой части, т.к. стрим не бросает синхронно)/keys, abort→interrupted. 3 главных подводных камня разобраны.
- **blueprint-apply-engine.md** — EBNF грамматика патча + lenient-препроцессор, `seek` (4 уровня + точный Unicode-набор кодпоинтов, «нормализация для сравнения, байты для записи»), `apply` (детект/сохранение EOL/BOM/EOF, атомарная temp+rename на том же томе, транзакционная мультифайловая правка), snapshot (git/copy+GC), инструменты, Windows-специфика (jail для UNC/`\\?\`/junction/drive-relative, taskkill /T, EBUSY-retry).
- **blueprint-context-memory-data.md** — драйвер `better-sqlite3` (ship) / `node:sqlite` (roadmap за портом `SqliteDriver`) с обоснованием, полный DDL + FTS5(triggers) + vec0, sqlite-vec через asarUnpack, WAL single-writer, токен-оценка (o200k/cl100k/эвристика+15%), 2-фазная компакция с never-prune и сохранением tool-пар, CCR (content-addressable + retrieve-tool + GC), слоёная память + **ltm как единый ledger через bridge (без дубля JSONL)** + handoff-схема + reseed, worker-offload.
- **blueprint-security-reliability-testing.md** — точный `safePath` (Windows, TOCTOU-митигация; честно: `O_NOFOLLOW` нет на Windows, drive-relative `C:rel` — реальный bypass, обрабатывается явно), permissions (deny-wins, 3×3 автономия, approval-flow), secrets (18 паттернов, редакция во всех каналах), audit, cleanup/loop-detect/goal-verifier/verify/self-heal, тест-каркас (ai/test `MockLanguageModelV2`+`simulateReadableStream`, fast-check seed=42/numRuns=1000, recorded-fixture provider-contract, eval-runner, CI-matrix os×engine, `.gitattributes`).

Реальные находки из проверки Node на win32: `fs.constants.O_NOFOLLOW===undefined`, `path.win32.isAbsolute("C:rel\\a")===false` (drive-relative резолвится от CWD — jail-bypass, обрабатывается), `node:sqlite` доступен но Stability 1.1. Спек + блюпринты: диагностика 0 ошибок. Готово к Фазе 0.

---

## 31. Реализация движка Kyrei v2 — статус (Фазы 0–7)

Движок v2 реализован по спеку `.kiro/specs/kyrei-engine/` за флагом `KYREI_ENGINE=v2` (v1 не тронут). Стек — всё latest, кроме зафиксированного AI SDK (`ai@5.0.210`).

**Готово (Фазы 0–6 + бо́льшая часть 7):**
- **Ядро:** orchestrator на `streamText` + `stopWhen`, stream-bridge (все v5-части `fullStream`→события, стабильный `tool_call_id`, отмена≠ошибка, единый источник ошибки), провайдер-слой (реестр + keyPool round-robin/affinity + openStream: no-tools-fallback через peek + провайдер-fallback).
- **Правки:** контекст-якорный apply (parse+seek 4 уровня+Unicode, EOL/BOM/EOF-сохранность, атомарная/транзакционная запись, snapshot-откат), `edit_file`/`write_file`-граница, LCS-дифф.
- **Инструменты:** list_dir/read_file/write_file/edit_file/run_command/grep_search(ripgrep)/find_path(fast-glob)/diagnostics/batch, все с workspace-jail (+ Windows-hardening).
- **Контекст:** tokens (o200k/cl100k/эвристика + двойной триггер), 2-фазная компакция + чекпоинты 20/45/70% через prepareStep, CCR (обратимое сжатие + retrieve-tool).
- **Надёжность:** cleanup-incomplete, loop-detect, self-heal FSM, verify (детект экосистемы), goal-verifier, budget.
- **Данные:** SQLite (better-sqlite3 + FTS5, sqlite-vec loadable) за портами `SessionStore/MemoryStore/VectorStore`, graceful-fallback на файловый бэкенд; JSONL-транскрипт как SoT.
- **Память:** слоёная (AGENTS.md→steering→MEMORY→GLOBAL), writer с enforced-путями, кросс-процессный lock, handoff-артефакт+reseed, ltm-bridge (единый ledger + редакция секретов).
- **Безопасность:** permissions (двухосевая автономия, deny-wins), audit (редакция, ротация, вне jail), pre-hook (secret-scan), sanitizeEnv.
- **Оркестрация:** plan-as-files, reviewer с чистым контекстом, read-swarm (single-writer-safe).
- **Eval/CI/Observability:** детерминированный eval-харнесс (реальный цикл со scripted MockLanguageModelV2 + oracle, E1/E2/E6), метрики + regression-check, structured logger с редакцией, CI-matrix (win/mac/linux × v1/v2), `npm run gate`.
- **Тесты:** 88 проходят (unit + property-based + SQLite + ripgrep + eval); `tsc`, build, check-js — чисто.

**Live-валидация выполнена (2026-07-12):** v2 прогнан против реального OpenAI-compatible провайдера (`a6.a6api.com/v1`, модель `gpt-5.6-sol`). Подтверждено end-to-end: (1) стриминг текста + usage + `message.complete`; (2) tool-calling — модель вызвала `write_file`, событие `tool.start` несёт полные args (`{path, content}`), файл реально создан, `tool.complete` без ошибки. Полный цикл ~10 c.

**Найден и исправлен баг стрим-бриджа:** в v5 `fullStream` часть `tool-input-start` приходит без аргументов (они добавляются позже в `tool-call`), из-за чего `tool.start` эмитился с пустым `{}`. Фикс: `tool-input-start` теперь только регистрирует инструмент (стабильный id), а `tool.start` эмитится в обработчике `tool-call` с финализированными args. Тесты бриджа совместимы, gate зелёный.

**Задача 24 — ВЫПОЛНЕНА:** после live-валидации дефолт переключён на v2 (`core/gateway.js`: `useV2 = process.env.KYREI_ENGINE !== "v1"`). v1 остаётся за флагом `KYREI_ENGINE=v1` ещё один релиз, затем ручной SSE/loop-код v1 будет удалён.

**Обновление дерева зависимостей до latest (2026-07-12):** подняты electron 34→43, electron-builder 25→26, @vitejs/plugin-react 4→6, vite 6→8, typescript 5.9→7.0.2, lucide-react 0.469→1, react-markdown 9→10, shiki 1→4, tailwind-merge 2→3. Проверено: `npm run gate` (typecheck на TS7 + build + 88 тестов) зелёный, `vite build` рендерера успешен (Vite 8 + plugin-react 6 + Tailwind 4). **AI-кластер намеренно закреплён как совместимый набор под AI SDK v5:** `ai@5.0.210` + `@ai-sdk/openai-compatible@1.0.42` (dist-tag `ai-v5`; `latest` 3.x требует ai@6/7) + `zod@3.25.76`. `gpt-tokenizer`, `better-sqlite3`, `sqlite-vec` оставлены на текущих валидированных версиях.

**Git-гигиена:** `hermes/`, `.omp-runtime/` и все env-файлы (`.env`, `*.env`, кроме `*.env.example`) добавлены в `.gitignore` — вендорные подпроекты и секреты не уходят в публичный репозиторий. Провайдер по умолчанию НЕ зашивается: каждый разработчик подключает своих провайдеров сам.

**Закрыты отложенные задачи Фазы 0 (2.5, 2.6):**
- **2.5 — версионируемый system-prompt.** Новый модуль `core/engine/prompt/`: `system.ts` (`buildSystemPrompt` с секциями identity/workflow/tool-policy/editing/safety/response-style, `PROMPT_VERSION` + `PROMPT_CHANGELOG`, детерминированный → prompt-cache-friendly), `tool-descriptions.ts` (единый источник описаний инструментов, используется и в `tools/index.ts`, и в промпте), snapshot-тест `prompt.test.ts` (пинит текст к версии — любое изменение слов требует бампа `PROMPT_VERSION`). `orchestrator/system-prompt.ts` теперь тонкий реэкспорт.
- **2.6 — Zod-схема конфига + проводка.** `core/engine/config/schema.ts`: `EngineConfigSchema` (maxSteps/timeouts/budgets/permissions/providerRoles/fallbackChain с границами и дефолтами) + `resolveEngineConfig()` — **fail-open** валидация (битое поле → дефолт + warning, никогда не бросает), миграции legacy-форм (`autonomy`→permissions.terminal, `maxToolCalls`→maxSteps), инвариант softPct<hardPct. Подключено в `run.ts` (заменён простой spread) и в gateway (`PUT /api/config` принимает `engine`-объект, пробрасывается в v2). Тесты: `config.test.ts` (9 кейсов) + `prompt.test.ts` (7 кейсов).

**Тесты: 104 проходят** (было 88; +16 из prompt/config), gate зелёный на всём обновлённом стеке.

**Задача 19.1 — OS-sandbox port (opt-in, off by default).** `core/engine/security/sandbox.ts`: порт `Sandbox` (`available()`/`wrap()`/`describe()`) + платформенные best-effort реализации:
- **Linux** — bubblewrap (`bwrap`) или `firejail`: fs→cwd, сеть запрещена (`--unshare-net`/`--net=none`).
- **macOS** — `sandbox-exec` с deny-by-default профилем (запись только в cwd, сеть запрещена).
- **Windows** — честно недоступен в userland без нативного Job Object addon; строгий режим сообщает об этом (`residual risk`) и фолбэчит на jail + permission engine.
- Единый `createSandbox(mode)` (off→noop passthrough) + `maybeSandbox()` — **fail-open**: если примитив недоступен, команда выполняется без обёртки, а поза безопасности сообщается, а не роняет функциональность. Поле `sandbox: "off"|"strict"` добавлено в `EngineConfig` + Zod-схему, подключено в `run_command`. Тесты: `sandbox.test.ts` (7 кейсов, включая экранирование sh и honest-unavailable на Windows).

**Итого тесты: 111 проходят** (88 → 104 → 111). Все обязательные задачи спека Фаз 0–7 + бэклог 19.1 закрыты; gate зелёный на TS7/Vite8/обновлённом стеке.

**Финальная сверка (2026-07-12):**
- **Eval-deliverables закоммичены:** `tests/eval/baseline.json` (v1 vs v2 baseline) + `tests/eval/report.md` (человекочитаемая запись релиза). Regression-гейт теперь живой — новый тест грузит `baseline.json` и падает при просадке passRate или росте медианных steps/tokens >20% (v2: passRate 1.0, medSteps 2, medTokens 60; v1 medSteps 3).
- **Повторная live-валидация** после изменений prompt/config/sandbox: против `a6.a6api.com/v1` (`gpt-5.6-sol`) — `status: complete`, `tool.start` с реальными args, файл создан, 5.5 c. Заодно подтверждён **fail-open конфига в бою**: переданы битый `maxSteps: 99999` и legacy `autonomy: "turbo"` → в логе `migrated legacy 'autonomy' → permissions.terminal` и `maxSteps > 200 → using default`, движок не упал.
- **Тесты: 112 проходят.** Спек kyrei-engine реализован полностью.

**Удаление legacy-движка v1 (2026-07-12):** по решению — оставляем только v2. Удалён `core/kyrei-engine.js`; из `core/gateway.js` вырезаны импорт v1, флаг `KYREI_ENGINE`/`useV2`, ветка выбора движка и polling-отмена (`cancelled`-set, `isCancelled`) — остался только v2-путь на `AbortController`. Из CI убрана ось матрицы `engine:[v1,v2]` (теперь только `os`). README обновлён. `check-js` теперь 6 JS-файлов (было 7). Gate зелёный, 112 тестов проходят.

Не интегрированы в живой цикл (модули готовы и протестированы, интеграция — при флипе v2): approval-события через gateway, аудит на каждый вызов, авто-verify после правок, реальный спавн read-роя, компакция активна только при наличии workspace/CCR.
