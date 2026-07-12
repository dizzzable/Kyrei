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
- Альтернатива (если рой сочтёт оправданным): `nanostores` + `@nanostores/react` (как Hermes). Решение зафиксировать в задаче 0; по умолчанию — свой мини-стор, чтобы не тянуть зависимость.
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
```

## Расширения gateway (`core/gateway.js`)

Текущее: `/api/config` (GET/PUT), `/api/sessions`, `/api/messages`, `/api/prompt`, `/api/cancel`, `/api/events` (SSE), `/api/files`, `/api/choose-folder`. Добавить (по мере фаз):
- **`GET /api/models`** → каталог провайдеров/моделей (из реестра движка `provider/registry.ts` + сконфигурированный провайдер). Для видимости/пилюли/настроек Model. Деградация: пустой список → ручной ввод.
- **`POST /api/complete-path`** → автодополнение путей для @-меншенов (list рабочей папки с фильтром; jail-safe через движковый `safePath`).
- **`PUT /api/config`** — расширить приём `engine` (уже есть) + клиентские поля не хранит (клиентские в localStorage рендерера).
- **`GET /api/session/:id/export`** — опц.; экспорт можно собрать и на клиенте из `getMessages`.
- (Опц. голос) **`POST /api/tts`**, **`POST /api/stt`** — если решим встроить локальный TTS/STT; иначе фича off. Вне scope первых волн.
Все новые эндпоинты — local-only, без внешних вызовов кроме сконфигурированного провайдера.

## Рендеринг сообщений (порт)

- Markdown: используем текущий `react-markdown` + `remark-gfm` (уже в deps) ИЛИ переходим на streamdown-подход. Решение в задаче: остаёмся на `react-markdown` (проще, уже есть), добавляем: компоненты для code (Shiki, отложенный при стриминге), таблиц, alerts, ссылок; KaTeX через мемо-плагин (`katex-memo` порт, `rehype-katex`); smooth reveal хук; deferred value.
- Tool-строки: `tool-view.ts` (порт `buildToolView` + `TOOL_META` иконок под lucide) + `DisclosureRow` + `tool-result-summary.ts`.
- Диффы: `diff.ts` (порт `diff-lines`: `parseDiff`/`stripDiffFileHeaders`/tint+гуттер, Shiki по языку, счётчик `+N −M`).
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

## Порядок и стратегия для роя

Задачи в `tasks.md` разбиты на волны; внутри волны — параллелятся между саб-агентами (независимые файлы/модули). Между волнами — контрольная сборка. Чистые порты (`lib/*`) идут раньше, чем экраны, которые их потребляют.
