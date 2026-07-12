# Kyrei

Кросс-платформенный десктопный AI-агент для работы с кодом (Windows / macOS / Linux).
Electron + React (renderer) поверх локального TypeScript/Node-движка и HTTP-шлюза.

## Архитектура

- **`core/engine/`** — движок v2 (`kyrei-engine`) на [Vercel AI SDK v5](https://sdk.vercel.ai).
  Оркестратор на `streamText` + `stopWhen`, потоковый мост `fullStream → события`,
  контекст-якорный apply-движок, провайдер-слой с fallback и пулом ключей,
  токен-бюджет и компакция, слоёная память, безопасность (jail, permissions,
  редакция секретов, opt-in OS-sandbox) и детерминированный eval-харнесс.
- **`core/gateway.js`** — локальный HTTP/SSE-шлюз между рендерером и движком.
- **`electron/`** — оболочка приложения.
- **`src/`** — React-интерфейс.
- **`.kiro/specs/kyrei-engine/`** — формальный спек (requirements / design / tasks).
- **`docs/research.md`** — журнал исследований и решений.

Движок v2 — единственный (legacy v1 удалён). Изолирован от оболочки: не знает про Electron,
общается с рендерером только через локальный gateway.

## Команды

```bash
npm install
npm run gate       # typecheck движка + сборка + проверка JS + тесты (vitest)
npm run build      # сборка рендерера (vite)
npm start          # сборка + запуск Electron
npm run dist       # упаковка через electron-builder
```

## Провайдеры

Провайдер по умолчанию не зашит — каждый пользователь настраивает свой
OpenAI-совместимый эндпоинт (base URL / модель / ключ) в настройках приложения.
Поддерживается локальный Ollama (`localhost:11434/v1`).

## Стек

Всё на актуальных версиях, кроме закреплённого AI SDK v5 (`ai@5.0.x`).
TypeScript, Vite, Electron, React 19, Tailwind, better-sqlite3 + sqlite-vec, ripgrep.

## Лицензия

См. `LICENSE` (если добавлена в репозиторий).
