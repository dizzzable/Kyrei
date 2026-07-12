# Implementation Plan — Kyrei Desktop UI/UX и настройки

## Overview

Стратегия: strangler-fig на уровне компонентов. Каждая **волна** завершается зелёной сборкой рендерера (`npm run build`) + `npm run gate` (движок не тронут). Внутри волны задачи параллелятся между саб-агентами (независимые файлы). Чистые порты (`lib/*`) идут раньше экранов, которые их потребляют. Референс: `hermes/hermes-agent/apps/desktop/src/**` (локально, .gitignore — читать через read_file / includeIgnoredFiles).

Ссылки `_Требования: N.M_` → requirements.md. `- [ ]*` — опциональная/полировка.

## Tasks

### Фаза 0 — Инфраструктура и примитивы

- [x] 0. Дизайн-фундамент (токены/шрифт/темы)
  - Токен-каскад `--k-*→--ui-*→--color-*` в `src/index.css`, JetBrains Mono (bundled), `shadow-nous`/`stroke-nous`/`.shimmer`, 7 тем.
  - _Требования: 1.1, 1.2, 1.3, 1.4, 2.4_

- [ ] 0.1. Выбрать стор-слой и завести `src/store/`
  - Мини-стор на `useSyncExternalStore` (`createStore`/`atom`) ИЛИ nanostores (зафиксировать решение в шапке). Хелперы персиста (`storedString/Bool/Json`) в `lib/persist.ts`.
  - _Требования: 10.1_

- [ ] 0.2. Библиотека UI-примитивов `src/components/ui/`
  - Button (варианты+размеры, CVA/cn), IconButton, Input, Textarea, Select, Switch, Tooltip, DropdownMenu, Dialog, DisclosureRow, Kbd, Badge, SegmentedControl, SearchField, Icon(lucide). Все с `aria-*`.
  - _Требования: 1.5, 10.3_

- [ ] 0.3. i18n-каталог + провайдер
  - `src/i18n/` (ru по умолчанию + en), `useI18n()`. Существующие строки не мигрировать разом — по мере касания.
  - _Требования: 11.1, 11.2_

### Фаза 1 — Тема (полная)

- [ ] 1. Система тем: skin ⟂ mode + boot-paint
  - `src/themes/`: presets, `applyTheme` (пишет семена в documentElement), mode (light/dark/system + слушатель ОС), `renderedModeFor` по яркости. Boot-paint inline-скрипт в `index.html` (красит фон до React из localStorage).
  - _Требования: 2.1, 2.2, 2.3, 2.5, P4_

- [ ] 1.1. Грид выбора темы в настройках (Appearance)
  - Карточки-превью тем + сегмент Light/Dark/System. Живое применение.
  - _Требования: 2.4_

- [ ]* 1.2. (Опц.) Импорт VS Code темы
  - Порт `themes/vscode.ts` (JSONC→~6 ключей+mix, ensureContrast). Файл-пикер.
  - _Требования: 2.6_

### Фаза 2 — Чистые порты логики (`lib/*`) — сильно параллелится

- [ ] 2. Порт рендер-логики markdown/кода/математики
  - `lib/markdown-code.ts` (язык→shiki/иконка), `lib/katex-memo.ts` (мемо-KaTeX), настройка code/table/alert/link компонентов для `react-markdown`.
  - _Требования: 5.1, 10.2_

- [ ] 2.1. Порт tool-view + result-summary
  - `lib/tool-view.ts` (`buildToolView` + `TOOL_META` под lucide), `lib/tool-result-summary.ts` (JSON→человекочитаемое). Юнит-тесты.
  - _Требования: 5.2, 12.2_

- [ ] 2.2. Порт диффов
  - `lib/diff.ts` (`parseDiff`/`stripDiffFileHeaders`/tint+гуттер/счётчик, Shiki по языку). Юнит-тесты.
  - _Требования: 5.3, 12.2_

- [ ] 2.3. Порт селектор-модели логики
  - `lib/model-status-label.ts` (`formatModelStatusLabel`, effort labels), `store/model-presets.ts`, `store/model-visibility.ts`. Юнит-тесты.
  - _Требования: 4.1, 4.3, 4.4, 12.2_

- [ ] 2.4. Порт сессионной логики
  - `lib/session-search.ts` (локальный матч), `lib/session-export.ts` (JSON). Юнит-тесты.
  - _Требования: 6.2, 6.3, 12.2_

- [ ] 2.5. Порт композер-логики
  - `store/composer-queue.ts` (enqueue/dequeue/promote/edit/migrate/shouldAutoDrain), `store/composer-input-history.ts`, `store/composer-draft.ts`, `lib/slash-commands.ts` (реестр), `lib/speech-text.ts`. Юнит-тесты (queue/history).
  - _Требования: 3.3, 3.4, 3.5, 3.2, 12.2_

- [ ] 2.6. Порт chat-messages (расширение)
  - Расширить `lib/chat-messages.ts`: коалесинг reasoning/text по сегменту, устойчивый `upsertToolPart` (id/имя+overlap), склейка tool-only. Юнит-тесты.
  - _Требования: 5.4, 5.5, 12.2, P1_

- [ ] 2.7. Порт реестра keybinds
  - `lib/keybinds/actions.ts` (действия по категориям + дефолты, `mod`-нормализация), `store/keybinds.ts` (диффы+capture+конфликты). Юнит-тесты.
  - _Требования: 9.1, 9.2, 9.3, 10.4, 12.2_

### Фаза 3 — Расширения gateway

- [ ] 3. `GET /api/models` — каталог моделей
  - Из движкового `provider/registry.ts` + сконфигурированного провайдера; local-only. Клиент `gateway.getModels()`. Деградация на ручной ввод.
  - _Требования: 4.2, 4.5_

- [ ] 3.1. `POST /api/complete-path` — автодополнение путей
  - Список рабочей папки с фильтром, jail-safe (движковый `safePath`). Клиент `gateway.completePath()`.
  - _Требования: 3.2_

### Фаза 4 — Рендеринг сообщений (экран)

- [ ] 4. Переработать `components/Message.tsx` → thread
  - Markdown (Shiki отложенный + KaTeX мемо), smooth reveal, deferred rendering; ассистент-футер (copy/retry) по hover без сдвига layout.
  - _Требования: 5.1, 5.5, 5.7, 10.1_

- [ ] 4.1. Tool-строки в сообщении
  - `DisclosureRow` + `buildToolView`: статус-глиф/заголовок/счётчик/длительность, раскрытое тело (дифф/результат/stdout+stderr/картинка), Copy, Technical-режим, персист раскрытия.
  - _Требования: 5.2_

- [ ] 4.2. Диффы + reasoning-блок + статусы
  - `FileDiffPanel` (из `lib/diff`), `ThinkingDisclosure` (таймер/шиммер/авто-сворачивание), статусы (loading/stall>2с/awaiting-input).
  - _Требования: 5.3, 5.4, 5.6_

### Фаза 5 — Композер (экран)

- [ ] 5. Разбить и обогатить `components/Composer.tsx`
  - `composer/` (Composer+controls+context-menu+attachments); черновик per-session; Enter/Shift+Enter/IME/Esc; высококонтрастная send CTA.
  - _Требования: 3.1, 3.4, 3.7_

- [ ] 5.1. Очередь + история ввода + @-mentions + slash
  - `queue-panel` (edit/delete/reorder/автодренаж), история ↑/↓, @-popover (gateway complete-path), slash-popover (реестр).
  - _Требования: 3.2, 3.3, 3.5_

- [ ] 5.2. ModelPill + меню модели
  - Пилюля «Модель · Max», меню (провайдеры/модели+поиск, thinking/fast/effort, пресеты, видимость), каталог из `/api/models`.
  - _Требования: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ]* 5.3. (Опц.) Голос: диктовка + Auto-speak
  - Контролы mic/auto-speak; `speech-text` очистка; за фичефлагом до gateway TTS/STT.
  - _Требования: 3.6_

- [ ]* 5.4. (Опц.) Steer + popout
  - Cmd/Ctrl+Enter steer; плавающий композер (драг+кламп).
  - _Требования: 3.8_

### Фаза 6 — Навигация и сессии

- [ ] 6. Левый сайдбар: rail + список + pinned + поиск
  - Rail-навигатор (New session + маршруты), список сессий, секция Pinned, `SearchField` (session-search), консистентный рефетч (не терять active/pinned).
  - _Требования: 6.1, 6.2, 6.5_

- [ ] 6.1. Меню строки + индикаторы состояния
  - rename/delete/pin/export/copy-id; индикаторы working/needs-input (из SSE-состояния).
  - _Требования: 6.3, 6.4_

- [ ] 6.2. Command Palette (⌘K) + Session switcher (Ctrl+Tab)
  - cmdk/свой fuzzy: действия (new/settings/theme/goto-session); switcher со слотами. Через реестр keybinds.
  - _Требования: 6.6, 9.1_

### Фаза 7 — Настройки «тьма»

- [ ] 7. Двухпанельный settings-overlay
  - Замена `Settings.tsx`: nav-разделы + контент, deep-link, автосейв (debounce), Export/Import/Reset.
  - _Требования: 7.1, 7.2_

- [ ] 7.1. Схема-driven ConfigField + движковые разделы
  - `ConfigField` (boolean/enum/number/list/text), разделы Model/Chat/Workspace/Safety/Memory/Advanced; Advanced маппится на `EngineConfig` через gateway (`engine`), fail-open.
  - _Требования: 7.3, 7.4, 7.5, 7.6_

- [ ] 7.2. Appearance/Providers/Keys/Sessions/About
  - Appearance (тема/режим/язык/масштаб/tool-view), Providers/Keys (provider/apiKey/model + доп. ключи), Sessions (архив/дефолт-папка), About (версия/обновления).
  - _Требования: 7.4, 2.4, 11.2_

- [ ] 7.3. Notifications + звук + keybind-панель
  - Мастер+пер-вид тумблеры, звук завершения+тест, нативные уведомления; панель ребайнда клавиш (capture/конфликты/reset).
  - _Требования: 8.1, 8.2, 8.3, 9.2, 9.3_

### Фаза 8 — Полировка и верификация

- [ ] 8. Statusbar + layout-полировка
  - Нижний статус-бар (модель/контекст/статус), консистентные отступы/хайрлайны, `overlay-blur` на оверлеях.
  - _Требования: 1.3_

- [ ] 8.1. Доступность + производительность проход
  - `aria-*`/роли/клавнавигация по меню/палитре/настройкам; мемоизация тяжёлого; deferred стриминг; smoke-прогон ключевых сценариев.
  - _Требования: 10.1, 10.2, 10.3, 10.4, 12.3_

- [ ] 8.2. i18n-подчистка + финальная верификация
  - Вынести оставшиеся строки в каталог; `npm run build` + `npm run gate` зелёные; обновить `docs/research.md`.
  - _Требования: 11.1, 12.1_

---

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 0, "tasks": ["0.1", "0.2", "0.3"], "depends_on": [], "note": "task 0 done" },
    { "wave": 1, "tasks": ["1", "1.1", "1.2"], "depends_on": [0] },
    { "wave": 2, "tasks": ["2","2.1","2.2","2.3","2.4","2.5","2.6","2.7"], "depends_on": [0], "note": "чистые порты — максимальный параллелизм" },
    { "wave": 3, "tasks": ["3", "3.1"], "depends_on": [0] },
    { "wave": 4, "tasks": ["4", "4.1", "4.2"], "depends_on": [2, 3] },
    { "wave": 5, "tasks": ["5", "5.1", "5.2", "5.3", "5.4"], "depends_on": [2, 3] },
    { "wave": 6, "tasks": ["6", "6.1", "6.2"], "depends_on": [2] },
    { "wave": 7, "tasks": ["7", "7.1", "7.2", "7.3"], "depends_on": [1, 2] },
    { "wave": 8, "tasks": ["8", "8.1", "8.2"], "depends_on": [4, 5, 6, 7] }
  ]
}
```

Критический путь: 0 → (0.1/0.2) → 2.x порты → 4/5 экраны → 8 полировка. Волны 2–3 запускаются роем параллельно сразу после волны 0; 4/5/6/7 параллелятся между собой после готовности их портов.

## Notes

- `- [ ]` — обязательная задача; `- [ ]*` — опциональная (голос/steer/popout/VSCode-темы).
- Каждая волна завершается verification-gate: `npm run build` (рендерер) + `npm run gate` (движок).
- Порты из Hermes адаптируются к нашим типам/иконкам (lucide), а не копируются буквально с зависимостями `@assistant-ui`/nanostores, если мы их не вводим.
- Движок v2 — чёрный ящик за `runKyreiChat`/gateway; эта спека его не меняет (кроме аддитивных read-only эндпоинтов gateway).
