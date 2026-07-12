# Kyrei ↔ Hermes — паритет настроек (план + статус)

Каталог настроек Hermes собран роем из `hermes-agent/apps/desktop/src/app/settings/**`.
Классификация: **A** — бэкится конфигом движка, **B** — только UI/desktop, **C** — провайдеры/ключи, **D** — требует бэкенд-фичу, которой у Kyrei нет.

## Что у Kyrei РЕАЛЬНО есть в движке (EngineConfig)
`maxSteps, commandTimeoutMs, maxToolOutput, contextBudget{softPct,hardPct}, permissions{terminal,review,rules}, providerRoles, fallbackChain, sandbox`.
Всё это уже прокидывается в движок через gateway `PUT /api/config { engine }` (fail-open). Значит эти поля можно сделать «настоящими».

## Разделы настроек Kyrei (целевые)

| Раздел | Поля | Тип | Статус |
|---|---|---|---|
| Модель и провайдер | provider(baseURL), apiKey(write-only), model(datalist), workspace | text/pass | ✅ есть |
| Оформление | тема (grid), режим, язык, масштаб, плотность, tool-view, rich-rendering, импорт VS Code-темы | UI (B) | ✅ есть |
| Уведомления | master, звук+тест, нативные | UI (B) | ✅ есть |
| Голос | STT/диктовка, авто-озвучка, язык, тест | UI/Web Speech (B) | ✅ есть |
| Клавиши | панель ребайнда | UI (B) | ✅ есть |
| Продвинутые | sendOnEnter, JSON движка, сброс UI | смеш. | ✅ есть (raw JSON) |
| О программе | версия/движок/провайдер | read-only | ✅ есть |

## План: сделать Advanced/Safety «схема-driven» поверх реального EngineConfig (A)

Заменить сырой JSON на именованные поля (Hermes-стиль `label + описание слева / контрол справа`):

| Поле | Контрол | Ключ EngineConfig | Kyrei backing |
|---|---|---|---|
| Макс. шагов | number | `maxSteps` | ✅ |
| Таймаут команды (мс) | number | `commandTimeoutMs` | ✅ |
| Лимит вывода инструмента | number | `maxToolOutput` | ✅ |
| Контекст: мягкий порог | number 0–1 | `contextBudget.softPct` | ✅ |
| Контекст: жёсткий порог | number 0–1 | `contextBudget.hardPct` | ✅ |
| Терминал (автономность) | select off/auto/turbo | `permissions.terminal` | ✅ |
| Ревью | select always/agent/request | `permissions.review` | ✅ |
| Песочница | select off/strict | `sandbox` | ✅ |
| Fallback-цепочка моделей | list | `fallbackChain` | ✅ |
| (power) сырой JSON движка | textarea | `engine` целиком | ✅ (оставить внизу) |

## НЕ переносим (D — нет бэкенда у Kyrei), помечаем как «недоступно»/скрываем:
Auxiliary-модели и MoA-пресеты; Pets/petdex; внешние memory-провайдеры (hindsight/honcho); голосовые бэкенды (у нас Web Speech, а не серверный STT/TTS); удалённые terminal-бэкенды (docker/ssh/modal/…); delegation/суб-агенты; Gateway Remote/Cloud (org/agent); Computer Use (cua-driver); toolset-каталоги image/video gen; VS Code Marketplace (у нас только локальный импорт файла); MCP-панель; мессенджер-мосты; self-update/uninstall.

## C — провайдеры/ключи
У Kyrei один провайдер (base URL + apiKey) — это осознанно (каждый разработчик встраивает своих). Мульти-провайдерный каталог/OAuth Hermes не переносим.

## Итог
- Тема: ✅ переведена на чёрно-белую shadcn (mono), синий убран, добавлены анимации.
- Схема-driven поля EngineConfig: ✅ реализованы (Продвинутые → Движок).

## Реализовано в движке (настоящие ключи, влияют на агента)
- `personality` — стиль ассистента → системный промпт (раздел «Чат»).
- `apiMaxRetries` — ретраи провайдера → `streamText maxRetries` (Продвинутые).
- `fileReadMaxChars` — отдельный лимит `read_file` (Продвинутые).
- Плюс ранее: `maxSteps`, `commandTimeoutMs`, `maxToolOutput`, `contextBudget.soft/hardPct`, `permissions.terminal/review`, `sandbox`, `fallbackChain`.

Все пишутся в `PUT /api/config { engine }` → `resolveEngineConfig` (fail-open) → используются движком.
