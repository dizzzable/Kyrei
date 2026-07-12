# Implementation Plan — Kyrei Desktop UI/UX и настройки

## Overview

Стратегия: strangler-fig на уровне компонентов. Каждая **волна** завершается зелёной сборкой рендерера (`npm run build`) + `npm run gate` (движок не тронут). Внутри волны задачи параллелятся между саб-агентами (независимые файлы). Чистые порты (`lib/*`) идут раньше экранов, которые их потребляют. Референс: `hermes/hermes-agent/apps/desktop/src/**` (локально, .gitignore — читать через read_file / includeIgnoredFiles).

Ссылки `_Требования: N.M_` → requirements.md. `- [ ]*` — опциональная/полировка.

## Tasks

### Фаза 0 — Инфраструктура и примитивы

- [x] 0. Дизайн-фундамент (токены/шрифт/темы)
  - Токен-каскад `--k-*→--ui-*→--color-*` в `src/index.css`, JetBrains Mono (bundled), `shadow-nous`/`stroke-nous`/`.shimmer`, 7 тем.
  - _Требования: 1.1, 1.2, 1.3, 1.4, 2.4_

- [x] 0.1. Выбрать стор-слой и завести `src/store/`
  - Мини-стор на `useSyncExternalStore` (`createStore`/`atom`) ИЛИ nanostores (зафиксировать решение в шапке — **блокер волны 2**: три порта используют nanostores-атомы, выбор влияет на «дословно vs адаптация»). Хелперы персиста (`storedString/Bool/Json`) в `lib/persist.ts`.
  - _Требования: 10.1_

- [x] 0.2. Библиотека UI-примитивов `src/components/ui/`
  - Button (варианты+размеры, CVA/cn), IconButton, Input, Textarea, Select, Switch, Tooltip, DropdownMenu, Dialog, DisclosureRow, Kbd, Badge, SegmentedControl, SearchField, Icon(lucide). Все с `aria-*`.
  - _Требования: 1.5, 10.3_

- [x] 0.3. i18n-каталог + провайдер
  - `src/i18n/` (ru по умолчанию + en), `useI18n()`. Существующие строки не мигрировать разом — по мере касания.
  - _Требования: 11.1, 11.2_

- [x] 0.4. Добавить `typecheck:renderer` в gate
  - Скрипт `tsc --noEmit` по `src/**` (+ tsconfig для рендерера, если нужен), включить в `npm run gate` (сейчас `vite build` использует esbuild без полной типизации — типовые ошибки в `src/**` пролезают).
  - _Требования: 12.1_

### Фаза 1 — Тема (полная)

- [x] 1. Система тем: skin ⟂ mode + boot-paint
  - `src/themes/`: presets, `applyTheme` (пишет семена в documentElement), mode (light/dark/system + слушатель ОС), `renderedModeFor` по яркости. Boot-paint inline-скрипт в `index.html` (красит фон до React из localStorage).
  - _Требования: 2.1, 2.2, 2.3, 2.5, P4_

- [x] 1.1. Грид выбора темы в настройках (Appearance)
  - Карточки-превью тем + сегмент Light/Dark/System. Живое применение.
  - _Требования: 2.4_

- [x]* 1.2. (Опц.) Импорт VS Code темы
  - Порт `themes/vscode.ts` (JSONC→~6 ключей+mix, ensureContrast). Файл-пикер.
  - _Требования: 2.6_

### Фаза 2 — Чистые порты логики (`lib/*`) — сильно параллелится

- [x] 2. Порт рендер-логики markdown/кода/математики
  - `lib/markdown-code.ts` (язык→shiki/иконка — дословно), `lib/katex-memo.ts` (мемо-`rehype`-transform под **react-markdown**, НЕ streamdown-обёртка), настройка code(на `lib/highlighter.ts`, без react-shiki)/table/alert/link компонентов. Внести бандл-deps: `katex`/`remark-math`/`rehype-katex`/`hast-*`/`unified`/`vfile` + `katex.min.css` (офлайн).
  - _Требования: 5.1, 10.2, 4.6_
  - _Порядок внутри волны: 2 → 2.2 (2.2 импортирует `shikiLanguageForFilename` из 2)._

- [x] 2.1. Порт tool-view + result-summary
  - `lib/tool-view.ts` (`buildToolView` + `TOOL_META` под lucide), `lib/tool-result-summary.ts` (дословно, только `lib/text`). Юнит-тесты.
  - _Требования: 5.2, 12.2_

- [x] 2.2. Порт диффов (только парсинг)
  - `lib/diff.ts`: чистый парсинг из `diff-lines.tsx` (`parseDiff`/`stripDiffFileHeaders`/`parseHunks`/счётчик) — дословно. Рендер `FileDiffPanel` — НЕ здесь (волна 4.2, на `lib/highlighter.ts`). Юнит-тесты.
  - _Требования: 5.3, 12.2_

- [x] 2.3. Порт селектор-модели логики (только UI-пресеты)
  - `lib/model-status-label.ts` (`formatModelStatusLabel`/`modelDisplayParts` — дословно), `store/model-presets.ts` (**только** хранение пресета as UI-метка: `get/setModelPreset/key`; `applyModelPreset` с RPC `config.set` из Hermes НЕ переносим — у Kyrei нет), `store/model-visibility.ts`. Юнит-тесты.
  - _Требования: 4.1, 4.3, 4.4, 12.2_

- [x] 2.4. Порт сессионной логики
  - `lib/session-search.ts` (адаптация под наш `SessionInfo={id,title,createdAt,updatedAt}`), `lib/session-export.ts` (адаптация: `gateway.getMessages` + **redact секретов** + без abs-путей). Юнит-тесты.
  - _Требования: 6.2, 6.3, 7.2, 12.2_

- [x] 2.5. Порт композер-логики
  - `store/composer-queue.ts` + `store/composer-input-history.ts` (чистая логика дословно, привязка к стору — адаптация под выбор 0.1), `store/composer-draft.ts`, `lib/slash-commands.ts` (каркас `desktop-slash-commands` + контент под реальные команды Kyrei), `lib/speech-text.ts` (дословно). Юнит-тесты (queue/history/speech).
  - _Требования: 3.3, 3.4, 3.5, 3.2, 12.2_

- [x] 2.6. Порт chat-messages (расширение)
  - Расширить `lib/chat-messages.ts`: коалесинг reasoning/text по сегменту, устойчивый `upsertToolPart` (id/имя+overlap), склейка tool-only. Юнит-тесты.
  - _Требования: 5.4, 5.5, 12.2, P1_

- [x] 2.7. Порт реестра keybinds
  - `lib/keybinds/combo.ts` (нормализатор комбо — дословно, `mod`=Cmd/Ctrl) + `lib/keybinds/actions.ts` (действия по категориям, **прунинг** под поверхности Kyrei: без profiles/terminals/pets/review/worktree), `store/keybinds.ts` (диффы+capture+конфликты). Юнит-тесты.
  - _Требования: 9.1, 9.2, 9.3, 10.4, 12.2_

### Фаза 3 — Расширения gateway/движка (аддитивные, read-only где можно)

- [x] 3. `GET /api/models` — каталог моделей
  - Движок: `registry.ts` → `export function listModels(): ModelEntry[]` (сейчас `REGISTRY` приватен). Gateway: `GET /api/models` → `{ models, current }`; local-only. Клиент `gateway.getModels()`. Каталог = известные модели, деградация на ручной ввод.
  - _Требования: 4.2, 4.5, 4.6_

- [x] 3.1. `POST /api/complete-path` — автодополнение путей
  - Движок: реэкспорт `safePath` из `engine/index.ts` (сейчас нет). Gateway: `readdir` в `config.workspace`, путь через `safePath` (jail-safe). Клиент `gateway.completePath()`.
  - _Требования: 3.2, 4.6_

- [x] 3.2. Gateway: отмена ≠ ошибка
  - В `runPrompt().catch` распознавать `AbortError` → эмитить `{type:"interrupted"}` (или полагаться на `message.complete{status:"interrupted"}`), НЕ `error`. Клиент трактует `interrupted` не как ошибку. Обеспечивает Property 2.
  - _Требования: 5.6, 12.4, P2_

- [x] 3.3. Per-session runtime-статус
  - Gateway: `Map<sessionId,"idle"|"working">`, ставить `working` в `runPrompt`, снимать в `finally`; отдавать в `GET /api/sessions` (`status`). Питает индикатор «работает» в сайдбаре.
  - _Требования: 6.4_

- [x]* 3.4. (Опц.) Проводка effort/fast в движок
  - `RunKyreiChatOpts.modelParams?: {effort?;fast?;reasoning?}` → `build.ts`/`streamText` (providerOptions); gateway принимает из `/api/prompt`. До этого effort/fast — UI-косметика.
  - _Требования: 4.1, 4.3_

- [x] 3.5. Клиент: подключить уже эмитируемые события
  - `App.tsx`/`chat-messages` читают `status.update` (usage/модель для statusbar) и `tool.progress` (прогресс tool-строки); `message.start`. Чисто UI, движок уже шлёт.
  - _Требования: 5.6_

### Фаза 4 — Рендеринг сообщений (экран)

- [x] 4. Переработать `components/Message.tsx` → thread
  - Markdown (Shiki отложенный + KaTeX мемо), smooth reveal, deferred rendering; ассистент-футер (copy/retry) по hover без сдвига layout.
  - _Требования: 5.1, 5.5, 5.7, 10.1_

- [x] 4.1. Tool-строки в сообщении
  - `DisclosureRow` + `buildToolView`: статус-глиф/заголовок/счётчик/длительность, раскрытое тело (дифф/результат/stdout+stderr/картинка), Copy, Technical-режим, персист раскрытия.
  - _Требования: 5.2_

- [x] 4.2. Диффы + reasoning-блок + статусы
  - `FileDiffPanel` (из `lib/diff`), `ThinkingDisclosure` (таймер/шиммер/авто-сворачивание), статусы (loading/stall>2с/awaiting-input).
  - _Требования: 5.3, 5.4, 5.6_

### Фаза 5 — Композер (экран)

- [x] 5. Разбить и обогатить `components/Composer.tsx`
  - `composer/` (Composer+controls+context-menu+attachments); черновик per-session; Enter/Shift+Enter/IME/Esc; высококонтрастная send CTA.
  - _Требования: 3.1, 3.4, 3.7_

- [x] 5.1. Очередь + история ввода + @-mentions + slash
  - `queue-panel` (edit/delete/reorder/автодренаж), история ↑/↓, @-popover (gateway complete-path), slash-popover (реестр).
  - _Требования: 3.2, 3.3, 3.5_

- [x] 5.2. ModelPill + меню модели
  - Пилюля «Модель · Max», меню (провайдеры/модели+поиск, thinking/fast/effort, пресеты, видимость), каталог из `/api/models`.
  - _Требования: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x]* 5.3. (Опц.) Голос: диктовка + Auto-speak
  - Контролы mic/auto-speak; `speech-text` очистка; за фичефлагом до gateway TTS/STT.
  - _Требования: 3.6_

- [x]* 5.4. (Опц.) Steer + popout
  - Cmd/Ctrl+Enter steer; плавающий композер (драг+кламп).
  - _Требования: 3.8_

### Фаза 6 — Навигация и сессии

- [x] 6. Левый сайдбар: rail + список + pinned + поиск
  - Rail-навигатор (New session + маршруты), список сессий, секция Pinned, `SearchField` (session-search), консистентный рефетч (не терять active/pinned).
  - _Требования: 6.1, 6.2, 6.5_

- [x] 6.1. Меню строки + индикаторы состояния
  - rename/delete/pin/export/copy-id; индикаторы working/needs-input (из SSE-состояния).
  - _Требования: 6.3, 6.4_

- [x] 6.2. Command Palette (⌘K) + Session switcher (Ctrl+Tab)
  - cmdk/свой fuzzy: действия (new/settings/theme/goto-session); switcher со слотами. Через реестр keybinds.
  - _Требования: 6.6, 9.1_

### Фаза 7 — Настройки «тьма»

- [x] 7. Двухпанельный settings-overlay
  - Замена `Settings.tsx`: nav-разделы + контент, deep-link, автосейв (debounce), Export/Import/Reset.
  - _Требования: 7.1, 7.2_

- [x] 7.1. Схема-driven ConfigField + движковые разделы
  - `ConfigField` (boolean/enum/number/list/text), разделы Model/Chat/Workspace/Safety/Memory/Advanced; Advanced маппится на `EngineConfig` через gateway (`engine`), fail-open.
  - _Требования: 7.3, 7.4, 7.5, 7.6_

- [x] 7.2. Appearance/Providers/Keys/Sessions/About
  - Appearance (тема/режим/язык/масштаб/tool-view), Providers/Keys (provider/apiKey/model + доп. ключи), Sessions (архив/дефолт-папка), About (версия/обновления).
  - _Требования: 7.4, 2.4, 11.2_

- [x] 7.3. Notifications + звук + keybind-панель
  - Мастер+пер-вид тумблеры, звук завершения+тест, нативные уведомления; панель ребайнда клавиш (capture/конфликты/reset).
  - _Требования: 8.1, 8.2, 8.3, 9.2, 9.3_

### Фаза 8 — Полировка и верификация

- [x] 8. Statusbar + layout-полировка
  - Нижний статус-бар (модель/контекст/статус), консистентные отступы/хайрлайны, `overlay-blur` на оверлеях.
  - _Требования: 1.3_

- [x] 8.1. Доступность + производительность проход
  - `aria-*`/роли/клавнавигация по меню/палитре/настройкам; мемоизация тяжёлого; deferred стриминг; smoke-прогон ключевых сценариев.
  - _Требования: 10.1, 10.2, 10.3, 10.4, 12.3_

- [x] 8.2. i18n-подчистка + финальная верификация
  - Вынести оставшиеся строки в каталог; `npm run build` + `npm run gate` зелёные; обновить `docs/research.md`.
  - _Требования: 11.1, 12.1_

---

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 0, "tasks": ["0.1", "0.2", "0.3", "0.4"], "depends_on": [], "note": "task 0 done; 0.1 — блокер волны 2" },
    { "wave": 1, "tasks": ["1", "1.1", "1.2"], "depends_on": [0] },
    { "wave": 2, "tasks": ["2","2.1","2.2","2.3","2.4","2.5","2.6","2.7"], "depends_on": [0], "note": "чистые порты; внутри: 2→2.2" },
    { "wave": 3, "tasks": ["3", "3.1", "3.2", "3.3", "3.4", "3.5"], "depends_on": [0] },
    { "wave": 4, "tasks": ["4", "4.1", "4.2"], "depends_on": [2], "note": "рендер треда не нужен gateway-эндпоинтам" },
    { "wave": 5, "tasks": ["5", "5.1", "5.2", "5.3", "5.4"], "depends_on": [2, 3], "note": "5.1←complete-path, 5.2←/api/models" },
    { "wave": 6, "tasks": ["6", "6.1", "6.2"], "depends_on": [2, 3], "note": "6.1←runtime-status(3.3)" },
    { "wave": 7, "tasks": ["7", "7.1", "7.2", "7.3"], "depends_on": [1, 2] },
    { "wave": 8, "tasks": ["8", "8.1", "8.2"], "depends_on": [4, 5, 6, 7] }
  ]
}
```

Критический путь: 0 → (0.1/0.2) → 2.x порты → 4/5 экраны → 8 полировка. Волны 2–3 запускаются роем параллельно сразу после волны 0; 4/5/6/7 параллелятся между собой после готовности их портов. **Правки после ревью роя (§зафиксированы в шапке):** каталог моделей = известные модели (не полный список провайдера); effort/fast — UI-пресет до задачи 3.4; отмена→interrupted (3.2); per-session статус (3.3); `typecheck:renderer` в gate (0.4); секрет-редакция экспорта; голос через Web Speech API (разрешён владельцем — облачное распознавание принято); diff-парсинг (в.2) ≠ diff-рендер (в.4).

## Notes

- `- [ ]` — обязательная задача; `- [ ]*` — опциональная (голос/steer/popout/VSCode-темы).
- Каждая волна завершается verification-gate: `npm run build` (рендерер) + `npm run gate` (движок).
- Порты из Hermes адаптируются к нашим типам/иконкам (lucide), а не копируются буквально с зависимостями `@assistant-ui`/nanostores, если мы их не вводим.
- Движок v2 — чёрный ящик за `runKyreiChat`/gateway; эта спека его не меняет (кроме аддитивных read-only эндпоинтов gateway).
