# Requirements Document

## Introduction

Kyrei Desktop UI/UX и настройки.

Цель — довести десктопный интерфейс Kyrei (`src/**` renderer + `core/gateway.js`) до уровня Hermes desktop: тот же класс визуала («flat, borderless + shadow»), богатый композер, продвинутый рендеринг сообщений, полноценная навигация по сессиям и **исчерпывающие настройки** — при сохранении наших принципов (local-first, безопасность по умолчанию, движок v2 не трогаем как чёрный ящик за `runKyreiChat`).

Основано на `docs/research.md §32` (изучение Hermes роем саб-агентов). Референс-исходник для дословного переноса алгоритмов лежит локально в `hermes/hermes-agent/apps/desktop/` (в .gitignore; читать через read_file / includeIgnoredFiles).

Принципы этой спецификации:
- **Инкрементально и обратимо:** каждая волна задач завершается зелёной сборкой рендерера (`npm run build`) и, где есть логика, unit-тестами (vitest). UI не должен ломаться между волнами.
- **Аддитивно к текущему рендереру:** существующие компоненты (`Message`, `Composer`, `Sidebar`, `Settings`, `FileExplorer`) эволюционируют, а не выбрасываются разом.
- **Портируемое — портируем дословно:** чистые модули Hermes (`katex-memo`, `diff-lines`, `tool-result-summary`, `session-search`, `session-export`, `composer-queue`, `composer-input-history`, `desktop-slash-commands`, реестр keybinds, `model-status-label`) адаптируются к нашим типам, а не переписываются с нуля.
- **Local-first:** никаких новых внешних сетевых зависимостей; шрифты/иконки бандлятся; всё работает офлайн.
- **Стек:** React 19 + Vite + Tailwind v4 (CSS-first) + lucide-react (иконки, уже в проекте) + существующий gateway (SSE + REST). Стейт — React-хуки + лёгкие сторы (можно ввести nanostores позже, но не обязательно для первых волн).

## Glossary

- **токен-каскад** — `--k-*` (семена темы) → `--ui-*` (тиры через `color-mix`) → `--color-*` (Tailwind). Реализован в `src/index.css` (Фаза A).
- **skin / mode** — акцентная тема (skin) и светлый/тёмный режим (mode), независимы.
- **композер** — панель ввода сообщения (`src/components/Composer.tsx`).
- **tool-строка** — раскрываемая строка вызова инструмента в сообщении.
- **attachment** — прикреплённый к сообщению контекст (файл/папка/картинка/URL).
- **effort** — уровень reasoning модели (minimal/low/medium/high/xhigh=Max).
- **схема-driven настройка** — поле настроек, отрисованное из описания (тип+лейбл+дефолт), а не хардкодом.

---

## Requirements

### Requirement 1: Дизайн-система и токены

**User Story:** Как пользователь, я хочу, чтобы приложение выглядело так же опрятно и «дорого», как Hermes, чтобы им было приятно пользоваться.

#### Acceptance Criteria
1. THE SYSTEM SHALL использовать токен-каскад `--k-* → --ui-* → --color-*` (реализован в Фазе A), где вся палитра выводится из ~10 семян через `color-mix()`.
2. THE SYSTEM SHALL предоставлять иерархию текста (primary/secondary/tertiary/quaternary) и границ (primary/secondary/tertiary + `--stroke-nous`), доступную как Tailwind-утилиты или CSS-переменные.
3. THE SYSTEM SHALL следовать правилу «flat, borderless + shadow»: elevation через `shadow-nous`, а не рамки-в-рамках; оверлеи/поповеры/тултипы используют `shadow-nous` + `overlay-blur`.
4. THE SYSTEM SHALL бандлить JetBrains Mono (OFL) для кода/диффов/терминала и использовать системный sans для UI.
5. THE SYSTEM SHALL предоставлять переиспользуемые UI-примитивы (Button с вариантами, IconButton, Input, Textarea, Select, Switch, Tooltip, DropdownMenu, Dialog, DisclosureRow, Kbd, Badge, SegmentedControl) с единым стилем «стиль живёт в примитиве».

### Requirement 2: Система тем

**User Story:** Как пользователь, я хочу выбирать тему и режим и чтобы приложение запоминало выбор без вспышки при запуске.

#### Acceptance Criteria
1. THE SYSTEM SHALL разделять **skin** (акцентная тема) и **mode** (light/dark/system), хранить оба и применять независимо.
2. WHEN приложение стартует THE SYSTEM SHALL красить фон из сохранённой темы ДО монтирования React (boot-paint, без вспышки белого/тёмного).
3. THE SYSTEM SHALL определять эффективный light/dark по реальной яркости фона активной темы (а не только по флагу mode).
4. THE SYSTEM SHALL предоставлять ≥7 встроенных пресетов (dark/light/midnight/ember/mono/cyberpunk/slate) и грид выбора темы в настройках с живым превью.
5. WHERE выбран режим `system` THE SYSTEM SHALL следовать системной теме ОС и реагировать на её смену.
6. (Опц.) THE SYSTEM SHALL поддерживать импорт пользовательской темы из VS Code color-theme JSON (конвертер ~6 ключей + `ensureContrast`).

### Requirement 3: Богатый композер

**User Story:** Как пользователь, я хочу мощное поле ввода — с контекстом, командами, очередью и голосом — как в Hermes.

#### Acceptance Criteria
1. THE SYSTEM SHALL поддерживать прикрепление контекста через кнопку «+»: файлы, папки, изображения, вставка картинки из буфера, URL, готовые prompt-сниппеты; прикреплённое отображается карточками-чипами с превью и возможностью удаления.
2. THE SYSTEM SHALL поддерживать **@-меншены** (@file/@folder/@url/@image; опц. @tool/@git) с автодополнением из рабочей папки через gateway `POST /api/complete-path` (обязательно jail-safe через движковый `safePath`) и **slash-команды** из реестра с popover-подсказкой и двухшаговым выбором аргумента.
3. WHEN идёт генерация и пользователь отправляет новое сообщение THE SYSTEM SHALL ставить его в **очередь** (per-session, с редактированием/удалением/переупорядочиванием и авто-дренажом по завершении хода).
4. THE SYSTEM SHALL хранить **черновик per-session** (текст в localStorage, вложения в памяти) и восстанавливать при возврате к сессии.
5. THE SYSTEM SHALL поддерживать навигацию по **истории отправленных сообщений** стрелками ↑/↓ в пустом композере.
6. THE SYSTEM SHALL поддерживать **голос**: диктовку (STT → вставка в композер) и озвучивание ответов (Auto-speak TTS) с очисткой текста от кода/ссылок/эмодзи перед синтезом. THE SYSTEM SHALL использовать браузерный **Web Speech API** (`webkitSpeechRecognition` + `speechSynthesis`) — явно разрешён владельцем проекта (распознавание может задействовать облачный сервис платформы; это принятый компромис). Голос **выключен по умолчанию**. WHERE голосовой бэкенд/поддержка недоступны THE SYSTEM SHALL скрывать/дизейблить контролы без ошибок.
7. THE SYSTEM SHALL отправлять по Enter, переносить строку по Shift+Enter, поддерживать IME (не отправлять во время композиции), останавливать генерацию по Esc/кнопке Stop.
8. (Опц.) THE SYSTEM SHALL поддерживать «steer» (Cmd/Ctrl+Enter — подрулить текущим запуском) и «popout» (плавающий композер).

### Requirement 4: Селектор модели

**User Story:** Как пользователь, я хочу быстро переключать модель и её режим прямо из композера.

#### Acceptance Criteria
1. THE SYSTEM SHALL показывать в композере пилюлю модели с меткой вида «Модель · Max» (имя + effort/fast). Примечание: effort/fast/thinking хранятся как per-`provider::model` UI-пресет (localStorage); **до появления проводки `RunKyreiChatOpts.modelParams` в движок эти значения не влияют на вызов модели** (косметика) — проводка в движок описана как отдельная задача (Фаза 3).
2. THE SYSTEM SHALL открывать меню выбора модели со списком из `GET /api/models` (аддитивный эндпоинт, отдающий известный движку реестр `provider/registry.ts` + текущую модель) с поиском. Каталог отражает **известные** движку модели, не произвольные модели провайдера.
3. THE SYSTEM SHALL позволять на модель настраивать **Thinking** (вкл/выкл), **Fast** (если поддерживается), **Effort** (minimal/low/medium/high/xhigh=Max) и запоминать пресет per `provider::model` (localStorage) как UI-метку. WHERE движок/gateway поддерживает reasoning/fast per-session THE SYSTEM SHALL применять пресет к активной сессии; иначе пресет остаётся UI-меткой без движкового эффекта.
4. THE SYSTEM SHALL поддерживать **видимость моделей** (какие показывать в списке) с дефолтом «топ-N на провайдера» и кастомизацией.
5. WHERE каталог моделей недоступен или пуст THE SYSTEM SHALL деградировать до ручного ввода имени модели без падения.
6. THE SYSTEM SHALL: новые gateway-эндпоинты (`GET /api/models`, `POST /api/complete-path`) — local-only, без внешних вызовов; автодополнение путей ограничено рабочей папкой через движковый `safePath` (не слабой проверкой `startsWith('..')`).

### Requirement 5: Рендеринг сообщений

**User Story:** Как пользователь, я хочу красивый и быстрый рендеринг ответов — markdown, код, диффы, вызовы инструментов, reasoning.

#### Acceptance Criteria
1. THE SYSTEM SHALL рендерить markdown (заголовки chat-scale, списки, таблицы, GFM-alerts, ссылки, инлайн-код) с подсветкой кода через Shiki (отложенной во время стриминга) и математикой через KaTeX (мемоизированной — переrender только изменённых формул).
2. THE SYSTEM SHALL рендерить **tool-строки** как раскрываемые строки со статус-глифом, заголовком/подзаголовком, счётчиком/длительностью; раскрытое тело показывает дифф / результаты / stdout+stderr (с ANSI) / картинку; есть Copy и Technical-режим (сырой JSON); состояние раскрытия персистится.
3. THE SYSTEM SHALL рендерить **диффы** в стиле Cursor: tint add/remove + 2px гуттер, подсветка по языку, номера строк опционально, счётчик `+N −M`.
4. THE SYSTEM SHALL рендерить **reasoning** в сворачиваемом блоке «Размышление» с таймером/шиммером во время генерации и авто-сворачиванием по завершении; пустой reasoning не показывать.
5. THE SYSTEM SHALL плавно раскрывать стриминг-текст (smooth reveal) и НЕ блокировать ввод/скролл во время стриминга (deferred rendering).
6. THE SYSTEM SHALL показывать статусы: загрузка ответа, «залипание» стрима (>2с тишины), ожидание ввода/одобрения. Примечание: событие `approval.request` определено в контракте движка, но пока **не эмитится** (approval-flow — non-goal текущих волн); до его реализации состояние «нужен ввод» не показывается.
7. THE SYSTEM SHALL показывать действия над сообщением ассистента (копировать, повторить, читать вслух) по наведению, не сдвигая layout.

### Requirement 6: Навигация и управление сессиями

**User Story:** Как пользователь, я хочу удобно управлять множеством сессий — искать, закреплять, переключаться, экспортировать.

#### Acceptance Criteria
1. THE SYSTEM SHALL показывать левый сайдбар с секциями: **New session**, список сессий, **Pinned** (закреплённые), с иконочным rail-навигатором вверху.
2. THE SYSTEM SHALL поддерживать **поиск** по сессиям (локальный по title/preview/id; серверный FTS — опционально).
3. THE SYSTEM SHALL поддерживать меню действий строки: переименовать, удалить, **архивировать**, закрепить/открепить, экспортировать в JSON, копировать id. (Опц.) ветвление сессии (branch).
4. THE SYSTEM SHALL показывать индикаторы состояния строки: «работает» (акцентный пульс, из per-session runtime-статуса gateway) и «нужен ввод» (amber, зависит от approval-flow — см. R5.6), с приоритетом «нужен ввод».
5. THE SYSTEM SHALL сохранять список сессий консистентным при рефетче (не терять активную/закреплённую/только-что-завершённую).
6. THE SYSTEM SHALL поддерживать **Command Palette** (Cmd/Ctrl+K) с ранжированным поиском по действиям (новый чат, настройки, темы, переход к сессии) и **Session switcher** (Ctrl+Tab).

### Requirement 7: Исчерпывающие настройки («тьма»)

**User Story:** Как пользователь, я хочу глубокие настройки, как в Hermes, чтобы точно подстроить агента и приложение.

#### Acceptance Criteria
1. THE SYSTEM SHALL предоставлять двухпанельный settings-overlay (слева навигация по разделам, справа контент) с deep-link по разделу и авто-сохранением (debounce).
2. THE SYSTEM SHALL предоставлять действия Экспорт / Импорт / Сброс конфигурации (JSON). THE SYSTEM SHALL **редактировать секреты** при экспорте (через движковый `redact`) и НЕ включать `apiKey` и абсолютные пути в экспорт конфига/сессии.
3. THE SYSTEM SHALL рендерить настройки **схема-driven** (`ConfigField`: boolean→Switch, enum→Select, number→Input, list→CSV, object→JSON-textarea, text→Input/Textarea) из описания разделов с лейблами/описаниями; enum-варианты задаются оверрайдами.
4. THE SYSTEM SHALL включать разделы:
   - **Model**: провайдер/модель/Apply, профильные effort/fast, `model_context_length`, `fallback_providers`; (опц.) auxiliary-модели по задачам и MoA-пресеты.
   - **Chat**: личность (набор встроенных), `timezone`, показ reasoning, `image_input_mode`.
   - **Appearance**: тема (грид+режим), язык, UI-масштаб, прозрачность, tool-view (Product/Technical), embeds (Ask/Always/Off).
   - **Workspace**: рабочая папка, `code_execution.mode`, `persistent_shell`, `env_passthrough`, `file_read_max_chars`.
   - **Safety**: `approvals.mode` (manual/smart/off), `approvals.timeout`, `approvals.mcp_reload_confirm`, `command_allowlist`, `security.redact_secrets`, `security.allow_private_urls`, `browser.allow_private_urls`, `browser.auto_local_for_private_urls`, `checkpoints.enabled`.
   - **Memory & Context**: память вкл/профиль/лимиты/`provider`, `context.engine`, `compression.{enabled,threshold,target_ratio,protect_last_n}`.
   - **Voice**: `tts.provider`+поля, `stt.provider`+поля, `auto_tts`, `record_key`, `max_recording` (локальные бэкенды, off по умолчанию — R3.6).
   - **Advanced** (маппится на `EngineConfig` через gateway `engine`, fail-open): `maxSteps`, `commandTimeoutMs`, `maxToolOutput`, `contextBudget.{softPct,hardPct}`, `permissions.{terminal,review,rules}`, `providerRoles`, `fallbackChain`, `sandbox`.
   - **Providers/Keys**: API-ключи по провайдерам (под-вкладки Accounts/Keys, prefix-группировка в карточки).
   - **Sessions** (архив/дефолт-папка), **About** (версия/обновления), **Gateway** (Local/Cloud/Remote — опц.).
   Примечание: только поля из `EngineConfig` реально влияют на движок; поля вроде `approvals.*`/`memory.*`/`compression.*`/`terminal.*` показываются, только если движок/gateway их поддерживает, иначе помечаются как «планируется» и не отправляются.
5. WHERE значение настройки задаётся из UI THE SYSTEM SHALL проводить движковые поля в `EngineConfig` через gateway (уже поддержано `resolveEngineConfig`, fail-open).
6. THE SYSTEM SHALL валидировать пользовательский ввод и никогда не терять существующий валидный конфиг при ошибке (fail-open).
7. THE SYSTEM SHALL держать `apiKey` **write-only**: gateway отдаёт только `hasKey` (не значение); ключ не попадает в localStorage рендерера, экспорт, логи. THE SYSTEM SHALL НЕ вводить телеметрию/аналитику и никаких внешних сетевых вызовов, кроме сконфигурированного провайдера. WHERE есть проверка обновлений (About) THE SYSTEM SHALL делать её только по явному действию пользователя (opt-in), без фоновых запросов.

### Requirement 8: Настройки уведомлений и звука

**User Story:** Как пользователь, я хочу управлять уведомлениями и звуками завершения.

#### Acceptance Criteria
1. THE SYSTEM SHALL предоставлять мастер-тумблер уведомлений + пер-вид тумблеры (5 видов: завершение хода, ошибка, нужен ввод, **одобрение** (approval), фоновая задача).
2. THE SYSTEM SHALL предоставлять выбор звука завершения из набора с превью и кнопкой «тест».
3. WHERE окно свёрнуто/не в фокусе THE SYSTEM SHALL показывать нативное уведомление о завершении хода (если включено).

### Requirement 9: Ребайндируемые горячие клавиши

**User Story:** Как пользователь, я хочу переназначать горячие клавиши.

#### Acceptance Criteria
1. THE SYSTEM SHALL иметь единый реестр действий по категориям (composer/session/navigation/view) с дефолтными комбо.
2. THE SYSTEM SHALL позволять переназначать комбо в панели (capture-режим), подсвечивать конфликты, сбрасывать одно/все; хранить только диффы от дефолтов.
3. THE SYSTEM SHALL показывать нередактируемые фиксированные шорткаты read-only для полноты карты.

### Requirement 10: Производительность и доступность

**User Story:** Как пользователь, я хочу плавный отзывчивый UI даже на длинных сессиях.

#### Acceptance Criteria
1. WHEN идёт стриминг THE SYSTEM SHALL сохранять отзывчивость ввода и скролла (deferred/мемоизированный рендер тяжёлых частей).
2. THE SYSTEM SHALL мемоизировать дорогие операции (парсинг markdown-блоков, KaTeX, buildToolView) с кэшами.
3. THE SYSTEM SHALL иметь `aria-label`/роли на интерактивных элементах, корректную клавиатурную навигацию по меню/палитре/настройкам, `aria-live` на статусах.
4. THE SYSTEM SHALL быть кроссплатформенным (Windows/macOS/Linux) — модификатор `mod` = Cmd на macOS / Ctrl иначе.

### Requirement 11: Локализация (i18n)

**User Story:** Как русскоязычный пользователь, я хочу интерфейс на русском, но с возможностью переключения языка.

#### Acceptance Criteria
1. THE SYSTEM SHALL выносить пользовательские строки в каталог локализации (минимум ru + en), а не хардкодить в компонентах.
2. THE SYSTEM SHALL по умолчанию использовать русский и позволять переключать язык в Appearance.

### Requirement 12: Верификация и качество

**User Story:** Как разработчик, я хочу, чтобы UI-порт был проверяемым и не регрессировал.

#### Acceptance Criteria
1. WHEN завершается волна задач THE SYSTEM SHALL собирать рендерер (`npm run build`) без ошибок, **проходить типизацию рендерера** (`tsc --noEmit` по `src/**`, добавить как `typecheck:renderer` в `npm run gate`) и проходить существующий `npm run gate` (движок не затронут).
2. THE SYSTEM SHALL иметь unit-тесты (vitest) на чистую логику UI: chat-messages сборка, session-search, tool-result-summary, diff-парсинг, model-status-label, composer-queue, keybind-реестр, sanitizeTextForSpeech, fail-open парсер клиентских настроек.
3. THE SYSTEM SHALL не вводить регрессий доступности/производительности, подтверждаемых ручным smoke-прогоном ключевых сценариев (чат, tools, диффы, настройки, темы).
4. WHEN пользователь отменяет ход THE SYSTEM SHALL получать `interrupted` (не `error`) и не показывать сообщение об ошибке (требует правки gateway: распознавать AbortError → эмитить `interrupted`).

---

## Non-goals (вне scope этой спецификации)

Явно НЕ реализуем сейчас (чтобы не раздувать scope и не завязываться на отсутствующую бэкенд-инфраструктуру):
- **Профили** (мульти-HERMES_HOME), маршруты Skills/Messaging/Artifacts/Cron/Agents-монитор/Pet, Command Center (System/Usage/Maintenance) — зависят от расширения бэкенда.
- **approval-flow** (in-chat Run/Reject, событие `approval.request`) — пока движок его не эмитит; контракт зарезервирован, UI-состояние «нужен ввод» неактивно.
- **subagent/todo/compaction прогресс** в UI — движок наружу не эмитит; статус-стек над композером — опционально, после появления событий.
- **Правый rail** (preview/console/review-панель), timeline-рейка, generated-images-галерея, haptics, onboarding/OAuth-флоу.
- **Голосовые эндпоинты** (`/api/tts`, `/api/stt`) — фича off по умолчанию; включается только с локальным бэкендом.
- **VS Code Marketplace live-search тем** — только локальный импорт JSON-файла темы (offline); сетевой поиск — non-goal.

Эти пункты могут стать отдельными спеками позже. Данная спецификация фокусируется на визуале, композере, рендеринге, сессиях и настройках, работающих с текущим движком/gateway.
