# Design Document — Kyrei Desktop UI/UX и настройки

## Overview

Переносим UX-паттерны Hermes desktop на существующий рендерер Kyrei (`src/**`), не ломая работающий движок v2 (за `runKyreiChat`) и текущий транспорт (gateway SSE + REST). Стратегия — **strangler-fig на уровне компонентов**: наращиваем слой примитивов + сторов, затем поэтапно заменяем/обогащаем экраны. Каждая волна автономна и оставляет приложение рабочим.

Референс для дословного переноса алгоритмов: `hermes/hermes-agent/apps/desktop/src/**` (локально, .gitignore).

## Architecture

```
src/
  main.tsx                 # boot-paint + провайдеры (theme, i18n, query?)
  index.css                # токен-каскад (Фаза A ✓) + утилиты
  app/
    App.tsx                # оболочка: rail | sidebar | main | right | overlays
    shell/                 # titlebar (опц.), statusbar, layout-константы
    chat/
      ChatView.tsx         # тред + композер
      thread/              # Message, AssistantMessage, parts, status
      composer/            # Composer, controls, model-pill, context-menu,
                           #   attachments, queue-panel, slash/at popover
    sidebar/               # rail-nav, sessions list, pinned, search, row-menu
    settings/              # overlay, nav, config-fields, разделы
    command-palette/       # ⌘K
    overlays/              # session-switcher, dialogs
  components/ui/           # примитивы (Button, Input, Select, Switch, Tooltip,
                           #   DropdownMenu, Dialog, DisclosureRow, Kbd, Badge,
                           #   SegmentedControl, IconButton, Codicon/Icon)
  lib/                     # чистая логика (портируемое из Hermes)
    chat-messages.ts       # ✓ есть — расширить (reasoning-коалесинг, tool upsert)
    gateway.ts             # ✓ есть — расширить (model.options, complete.path,...)
    markdown-code.ts       # порт: язык→shiki/codicon
    katex-memo.ts          # порт: мемоизирующий KaTeX
    tool-result-summary.ts # порт: JSON→человекочитаемое
    diff.ts                # порт diff-lines: парсинг + рендер
    tool-view.ts           # порт buildToolView (иконки/тон/заголовки)
    model-status-label.ts  # порт: formatModelStatusLabel
    session-search.ts      # порт: локальный матч
    session-export.ts      # порт: экспорт в JSON
    slash-commands.ts      # порт desktop-slash-commands (адаптир. реестр)
    speech-text.ts         # порт: sanitizeTextForSpeech
    keybinds/actions.ts    # порт реестра действий
  store/                   # лёгкие сторы (см. ниже)
  themes/                  # presets, apply, mode, boot
  i18n/                    # catalog ru/en
  types/                   # общие типы (расширить lib/types.ts)
```

## Стейт-менеджмент

Текущий Kyrei держит состояние в `App.tsx` через `useState`. Для роста вводим **лёгкий стор-слой** без тяжёлых зависимостей:
- Вариант по умолчанию: крошечный `createStore` на `useSyncExternalStore` (10–20 строк, ноль зависимостей) — атомы `$sessions`, `$activeSessionId`, `$messages`, `$composerDraft`, `$composerQueue`, `$modelPresets`, `$theme`, `$settings`, `$keybinds`.
- Альтернатива (если рой сочтёт оправданным): `nanostores` + `@nanostores/react` (как Hermes). Решение зафиксировать в задаче 0.1; по умолчанию — свой мини-стор, чтобы не тянуть зависимость.
- **Компромисс переносимости (важно):** три портируемых модуля Hermes (`composer-queue`, `composer-input-history`, `model-presets`) написаны на `nanostores` (`atom`). При мини-сторе их привязка к стору **переписывается** (адаптация, не дословный порт — чистая логика переносится, обёртка стора меняется). Если хотим дешёвые порты — принять nanostores в задаче 0.1. Это прямой вход в стоимость волны 2.
- Персист — через существующий `lib/persist.ts` (localStorage helpers) + новые `storedString/Bool/Json`.

**Правило:** тяжёлый стриминг (`message.delta`) НЕ должен ре-рендерить композер/сайдбар — подписки гранулярные, композер читает `$messages` императивно для истории, а не подписан на каждый дельта-флэш (паттерн Hermes).

## Токен-система (Фаза A — реализовано)

`src/index.css`: `--k-*` (семена per theme) → `--ui-text-*`/`--ui-stroke-*`/`--ui-row-*` (через `color-mix`) → `--color-*` (Tailwind). `shadow-nous`, `stroke-nous`, `.overlay-blur`, `.shimmer`, JetBrains Mono @font-face (bundled), 7 тем. Дальнейшее: добавить недостающие Tailwind-алиасы (`text-faint` уже есть) по мере надобности примитивами.

## Components and Interfaces

### UI-примитивы (Requirement 1.5)

Единый источник стиля. Минимальный набор на CVA-подобных вариантах (можно `class-variance-authority` — лёгкая, либо свой `cn`+map):
- **Button**: варианты `default/secondary/ghost/outline/destructive/link/text`; размеры `sm/md/lg/icon/icon-sm`. Высококонтрастная primary CTA (fg-on-bg круглая) для send.
- **IconButton**, **Input**, **Textarea**, **Select**, **Switch**, **Tooltip**, **DropdownMenu**, **Dialog**, **DisclosureRow** (раскрываемая строка с кареткой + trailing/action-слотами), **Kbd**, **Badge**, **SegmentedControl**, **SearchField**, **Icon** (обёртка над lucide; при желании — Codicon шрифтом, но по умолчанию lucide, уже в проекте).
- Все примитивы — с `aria-*` и клавиатурной поддержкой.

## Data Models

### Расширение `lib/types.ts`

```ts
// Сообщение остаётся { id, role, parts, pending }. parts: text|reasoning|tool.
// Расширения:
interface ToolPart { /* + */ countLabel?: string; subtitle?: string; icon?: string; tone?: string }

interface ComposerAttachment { id; kind: 'file'|'folder'|'image'|'url'; label; detail?; refText?; previewUrl?; path?; uploadState? }
interface QueuedPrompt { id; text; attachments: ComposerAttachment[]; queuedAt }
interface ModelPreset { effort?: string; fast?: boolean }   // per `provider::model`
interface ModelInfo { provider; model; caps?: { reasoning?; fast? }; pricing? }

interface Settings {           // клиентские настройки (localStorage)
  themeSkin: string; themeMode: 'light'|'dark'|'system'; language: 'ru'|'en';
  uiScale: number; toolView: 'product'|'technical';
  notifications: { enabled; turnDone; turnError; needsInput; backgroundDone };
  completionSound: string; keybinds: Record<string,string[]>;
  modelPresets: Record<string, ModelPreset>; modelVisibility?: Record<string, boolean>;
}
// Движковые настройки (maxSteps/timeouts/sandbox/permissions/budgets) — это EngineConfig,
// уходят в gateway PUT /api/config { engine } и валидируются resolveEngineConfig (fail-open).
// ВАЖНО: EngineConfig НЕ содержит effort/fast/thinking. ModelPreset — чисто клиентская UI-метка
// (localStorage). Чтобы effort/fast влияли на вызов, нужен новый RunKyreiChatOpts.modelParams
// (см. «Расширения gateway»); до этого — косметика.
```

## Расширения gateway (`core/gateway.js`)

Текущее: `/api/config` (GET/PUT), `/api/sessions`, `/api/messages`, `/api/prompt`, `/api/cancel`, `/api/events` (SSE), `/api/files`, `/api/choose-folder`. Добавить (по мере фаз):
- **`GET /api/models`** (обязательный аддитивный) → каталог из движкового реестра. **Требует нового `registry.listModels()`** — сейчас `REGISTRY` приватен (экспортируются только `resolve/registerModel/isLocalBaseURL`). Каталог статичный (~3 известные модели: gpt-4o-mini/deepseek-chat/llama3.1:8b), НЕ отражает произвольные модели провайдера → честно как «известные модели» + деградация на ручной ввод. local-only.
- **`POST /api/complete-path`** (обязательный аддитивный) → автодополнение путей для @-меншенов. **Требует реэкспорта `safePath` из `engine/index.ts`** (сейчас не реэкспортнут — в index.ts есть secrets/permissions/sandbox, но не `jail.safePath`). Реализация: `readdir` внутри `config.workspace`, целевой путь валидируется `safePath` (не слабой `startsWith('..')`, которая на Windows пропускает drive-relative/UNC). local-only, jail-safe.
- **Per-session runtime-статус** (обязательный аддитивный для индикатора «работает») → gateway держит `Map<sessionId,"idle"|"working">`, ставит `working` в `runPrompt`, снимает в `finally`; отдаёт в `GET /api/sessions` (поле `status`). Клиент подписан на SSE только активной сессии, поэтому для неактивных строк сайдбара нужен этот статус.
- **`interrupted`-событие** (обязательная правка): сейчас `runPrompt().catch` эмитит `error` на ЛЮБОЙ throw, включая `AbortError` от отмены → нарушает Property 2. Правка: ловить AbortError → эмитить `{type:"interrupted"}` (или полагаться на `message.complete{status:"interrupted"}` от движка и не эмитить `error` на abort). Клиент трактует `interrupted` не как ошибку.
- **effort/fast проводка** (опц., для реального эффекта пилюли): `EngineConfig` НЕ содержит effort/fast/thinking, `RunKyreiChatOpts` их не принимает и в модель не прокидывает. Чтобы пилюля влияла на вызов — добавить `RunKyreiChatOpts.modelParams?: { effort?; fast?; reasoning? }` и прокинуть в `build.ts`/`streamText` (providerOptions), gateway принимает из `/api/prompt` body. До этого effort/fast — только UI-пресет (косметика).
- **`PUT /api/config`** — приём `engine` уже есть; клиентские поля (тема/язык/уведомления/keybinds/пресеты) хранятся в localStorage рендерера, не в gateway.
- **Экспорт сессии** — на клиенте из `getMessages`; ОБЯЗАТЕЛЬНО редактировать секреты (`redact` из движка) и не включать абсолютные пути/apiKey.
- (Опц. голос) **`POST /api/tts`**, **`POST /api/stt`** — только локальные бэкенды; вне scope первых волн.
Все новые эндпоинты — local-only, без внешних вызовов кроме сконфигурированного провайдера. Клиент (`App.tsx`) сейчас НЕ читает уже эмитируемые `status.update`/`tool.progress`/`message.start` — подключить для usage/statusbar (чисто UI-задача).

## Рендеринг сообщений (порт)

- Markdown: используем текущий `react-markdown` + `remark-gfm` (уже в deps). Добавляем компоненты для code (Shiki через существующий `lib/highlighter.ts` singleton — **НЕ тянуть `react-shiki`**, отложенный при стриминге), таблиц, alerts, ссылок; KaTeX через мемо-плагин; smooth reveal хук; deferred value.
- **KaTeX (уточнение порта):** `katex-memo.ts` из Hermes возвращает форму плагина **streamdown**. Под `react-markdown` переносим только внутренний мемо-`rehype`-transform (LRU + visitor) как `rehypePlugin`. Вносим бандл-зависимости `katex`, `remark-math`, `rehype-katex`, `hast-util-from-html-isomorphic`, `hast-util-to-text`, `unist-util-visit-parents`, `unified`, `vfile` + `katex/dist/katex.min.css` — **офлайн, без CDN**.
- **Shiki офлайн:** грамматики/темы бандлятся; использовать существующий singleton `lib/highlighter.ts`.
- Tool-строки: `tool-view.ts` (порт `buildToolView` + `TOOL_META` иконок под lucide) + `DisclosureRow` + `tool-result-summary.ts`.
- Диффы: **парсинг** → `lib/diff.ts` (порт из `diff-lines.tsx`: `parseDiff`/`stripDiffFileHeaders`/`parseHunks`/счётчик `+N −M` — чистый, дословно, волна 2). **Рендер** (`FileDiffPanel`: tint+гуттер, подсветка) переписать на `lib/highlighter.ts` (Hermes-компонент тянет `react-shiki`/`fixed-row-window` — не копировать буквально; волна 4).
- Reasoning: `ThinkingDisclosure` (таймер/шиммер/авто-сворачивание).

## Композер (порт)

- `composer/` разбивается: `Composer.tsx` (оркестрация) + `controls.tsx` (mic/model-pill/send) + `context-menu.tsx` (+ меню) + `attachments.tsx` (чипы) + `queue-panel.tsx` + `model-pill.tsx` + `slash-at-popover.tsx`.
- Черновик: `store/composer` + `lib/persist` (per-session текст + вложения в памяти).
- Очередь: порт `composer-queue.ts` (enqueue/dequeue/promote/edit/migrate/shouldAutoDrain) — чистый, переносится дословно.
- История ввода: порт `composer-input-history.ts` (derive из `$messages`).
- @-mentions: gateway `/api/complete-path`; slash: `lib/slash-commands.ts` реестр + popover.
- Голос: `speech-text.ts` порт; TTS/STT — за фичефлагом (по умолчанию off до gateway-эндпоинтов).

## Селектор модели (порт)

`model-status-label.ts` (`formatModelStatusLabel` — дословно), `store/model-presets` (per `provider::model`, localStorage), `store/model-visibility`, `ModelPill` + меню (эффорт radio/thinking/fast toggle), каталог из `/api/models` (TanStack Query опц. или простой fetch+cache).

## Навигация/сессии (порт)

`session-search.ts`, `session-export.ts` (дословно), row-menu (rename/delete/pin/export/copy-id), индикаторы (working/needs-input) — состояние из SSE (streaming флаг per session). Command Palette — cmdk (`cmdk` пакет, лёгкий) или свой список + fuzzy; Session switcher — свой стор.

## Настройки (порт)

Двухпанельный overlay (замена текущего `Settings.tsx`): `SECTIONS` (id/label/icon/keys), `ConfigField` (тип-driven рендер), автосейв debounce, Export/Import/Reset. Клиентские разделы (Appearance/Notifications/Keybinds) — из `store/settings`. Движковые (Advanced) — в `EngineConfig` через gateway. Провайдеры/ключи — через существующий `/api/config` (provider/apiKey/model) + расширение для нескольких ключей (опц.).

## i18n

`i18n/catalog.ts` (ru/en), провайдер + хук `useI18n()`; строки выносятся при касании компонента (не рефакторим всё сразу — по мере переработки экрана).

## Testing Strategy

vitest (уже настроен). Тесты на чистую логику в `lib/`: `chat-messages`, `session-search`, `tool-result-summary`, `diff`, `model-status-label`, `composer-queue`, `keybinds`. UI-компоненты — smoke (рендер без падения) где оправдано. Верификация волны: `npm run build` (рендерер) + `npm run gate` (движок не тронут) зелёные.

## Error Handling

- Клиентские настройки: битое/устаревшее значение → дефолт + warning, остальные сохраняются (fail-open, зеркалит движковый `resolveEngineConfig`).
- Каталог моделей / автодополнение путей недоступны → graceful degradation (ручной ввод модели; пустой список автодополнений) без падения UI.
- Ошибки стрима из gateway (`error`-событие) показываются как строка в сообщении; отмена (`interrupted`) ошибкой не считается (P2).
- Голосовые/сетевые фичи при отсутствии бэкенда — контролы скрыты/дизейблены, не бросают.
- Персист в localStorage best-effort (quota/приватный режим не ломают ввод).
- Экспорт конфига/сессии редактирует секреты (`redact`) и исключает `apiKey`/абсолютные пути.
- `/api/complete-path` валидирует целевой путь `safePath` — выход за workspace отклоняется (не полагаться на слабую `startsWith('..')`).

## Correctness Properties

Инварианты, которые проверяются тестами/ручным smoke и должны выполняться всегда.

### Property 1: Гранулярность стриминга
Стриминг-дельты (`message.delta`) не ре-рендерят композер/сайдбар — подписки гранулярные.

**Validates: Requirements 10.1**

### Property 2: Отмена ≠ ошибка
Отменённый ход завершается `interrupted` и UI не показывает событие `error`.

**Validates: Requirements 5.6**

### Property 3: Сохранность черновика/очереди
Черновик и очередь per-session не теряются при переключении сессий.

**Validates: Requirements 3.3, 3.4**

### Property 4: Тема без вспышки
Смена/старт темы не даёт вспышки (boot-paint) и не перезагружает состояние.

**Validates: Requirements 2.2**

### Property 5: Fail-open настроек
Битая клиентская настройка → дефолт, остальные валидные сохраняются.

**Validates: Requirements 7.6**

### Property 6: Стиль в примитиве
Каждый примитив несёт свой стиль; call-site не хардкодит паддинги/цвета мимо токенов.

**Validates: Requirements 1.5**

### Property 7: Секрет-гигиена UI
`apiKey` не попадает в localStorage рендерера, экспорт конфига/сессии, логи; gateway отдаёт только `hasKey`. Экспорт проходит через `redact` и не содержит абсолютных путей.

**Validates: Requirements 7.2, 7.7**

### Property 8: Офлайн-инвариант
Рендерер и новые gateway-эндпоинты не делают внешних сетевых вызовов, кроме сконфигурированного провайдера. Шрифты/иконки/Shiki-грамматики/KaTeX-CSS бандлятся; голос — только локальные бэкенды; импорт тем — локальный файл; проверка обновлений — только по явному действию.

**Validates: Requirements 4.6, 7.7, 3.6, 2.6**

## Порядок и стратегия для роя

Задачи в `tasks.md` разбиты на волны; внутри волны — параллелятся между саб-агентами (независимые файлы/модули). Между волнами — контрольная сборка. Чистые порты (`lib/*`) идут раньше, чем экраны, которые их потребляют.
