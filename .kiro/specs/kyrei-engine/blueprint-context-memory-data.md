# Blueprint — Kyrei v2: Context Management + Memory + Data Layer

> Тёрнки-план реализации для `core/engine/context/**`, `core/engine/memory/**`, `core/engine/data/**`.
> Local-first, offline. Совместим с внешним контрактом `runKyreiChat` и существующим `ltm/`-слоем.
> Ссылки на дизайн: `.kiro/specs/kyrei-engine/design.md` (§Data Layer, §Memory, §Token Estimation). Ссылки на исследование: `docs/research.md` §21 (данные), §22 (память), §27.1 (backlog).

## Статус верификации библиотек (проверено, с цитатами)

| Библиотека | Факт (проверено) | Источник |
|---|---|---|
| `node:sqlite` | Stability **1.1 — Active development**; экспериментальный warning ещё в v22.22.0; полностью стабилизирован только в Node **v26**. Non-backward-compatible изменения возможны в любом релизе. | [Node v24 docs](https://r2.nodejs.org/download/test/v24.0.0-test20241020b0ffe9ed35/docs/api/sqlite.html), [nodejs/node#57445](https://github.com/nodejs/node/issues/57445) |
| `node:sqlite` loadExtension | Метод `db.loadExtension(path)` и SQL-функция включаются опцией `new DatabaseSync(path, { allowExtension: true })`; можно затем `enableLoadExtension(false)`. Заблокировано при включённой permission-model. | [Node API sqlite](https://nodejs.cn/api/v23/sqlite/database_loadextension_path.html), [Deno mirror allowExtension](https://docs.deno.com/api/node/sqlite/~/DatabaseSyncOptions.allowExtension) |
| `better-sqlite3` | Синхронный, одно соединение; `db.loadExtension()` есть; для Electron требует пересборки под ABI (частая ошибка `NODE_MODULE_VERSION`). | [better-sqlite3 api.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), [bs3#1171 ABI](https://github.com/WiseLibs/better-sqlite3/issues/1171) |
| `better-sqlite3 + sqlite-vec` | Реальная Electron-инсталляция: CherryHQ/cherry-studio заменили libsql на `better-sqlite3 + sqlite-vec`; одно синхронное соединение убирает write-mutex/BUSY-retry сложность; векторный поиск остаётся в SQL. | [cherry-studio#16626](https://github.com/CherryHQ/cherry-studio/issues/16626) |
| `sqlite-vec` | Loadable-расширение (грузится через `sqlite3_load_extension`), MIT/Apache-2, один C-файл, npm-пакет с пребилтами per-OS; brute-force сейчас, ANN для vec0 — в работе. | `docs/research.md` §21 |
| `gpt-tokenizer` | Поддерживает `o200k_base` (GPT-4o/o1/o3/o4/4.1) и `cl100k_base` (GPT-4/3.5); самый быстрый JS BPE-токенайзер; TS. Экспорт `encode`, `isWithinTokenLimit`, энкодинг-специфичные подпакеты. | [npm gpt-tokenizer](https://www.npmjs.com/package/gpt-tokenizer) |

> Примечание по компоновке: `sqlite-vec` грузится в SQLite через C-ABI `sqlite3_load_extension`, поэтому он **driver-agnostic** — работает и с `better-sqlite3`, и с `node:sqlite` (при `allowExtension:true`). Единственное требование — совместимый нативный `.dll/.dylib/.so` под каждую ОС/арх; это одинаково для обоих драйверов.

---

## 1. Data Layer

### 1.1 Финальный выбор драйвера: `better-sqlite3` (ship) → `node:sqlite` (roadmap)

**Решение:** для v2-ship берём **`better-sqlite3`** как дефолтную реализацию за портом `SqliteDriver`. **`node:sqlite`** — целевой мигрант, включается флагом `KYREI_SQLITE=node` и становится дефолтом, когда Electron начнёт поставлять Node ≥ 26 (стабильный `node:sqlite`).

**Обоснование (Electron-упаковка под Windows / macOS / Linux):**

1. **Зрелость и стабильность контракта.** `node:sqlite` — Stability 1.1, non-backward-compatible изменения разрешены в любом релизе ([node#57445](https://github.com/nodejs/node/issues/57445)); строить ship-функциональность памяти на API, который может измениться в минорном апдейте Electron, — риск. `better-sqlite3` имеет стабильный API годами.
2. **Версия Node внутри Electron.** Electron несёт собственный форк Node; `node:sqlite` присутствует и разблокирован только в свежих сборках и продолжает эмитить экспериментальный warning вплоть до v22.22.0. Мы не можем гарантировать нужную версию на всех трёх целевых билд-агентах.
3. **Проверенный прецедент.** Electron-приложение cherry-studio уже отгружает `better-sqlite3 + sqlite-vec` в проде; одно синхронное соединение делает транзакции «correct by construction» и убирает write-mutex/BUSY-retry слой ([#16626](https://github.com/CherryHQ/cherry-studio/issues/16626)).
4. **Цена native-сборки управляема.** Боль `better-sqlite3` — `NODE_MODULE_VERSION` ABI-mismatch ([bs3#1171](https://github.com/WiseLibs/better-sqlite3/issues/1171)). Решается детерминированно: `@electron/rebuild` в CI на матрице `os: [windows-latest, macos-latest, ubuntu-latest]` + `electron-builder` с `npmRebuild:true`. Это разовая стоимость на релиз, полностью автоматизируемая.
5. **Обратный путь дешёвый.** Оба драйвера скрыты за `SqliteDriver`; `sqlite-vec` грузится одинаково через `loadExtension`. Переключение на `node:sqlite` = смена одной фабрики, без изменения SQL/DDL/портов.

**Матрица решения:**

| Критерий | `better-sqlite3` | `node:sqlite` |
|---|---|---|
| Стабильность API | ✅ стабилен | ⚠️ 1.1, ломается | 
| Нужен `electron-rebuild` | ⚠️ да (per-OS/ABI) | ✅ нет (встроен) |
| `loadExtension` (sqlite-vec) | ✅ `db.loadExtension(path)` | ✅ `{allowExtension:true}` + `db.loadExtension` |
| Наличие в Electron-Node сейчас | ✅ всегда (npm) | ⚠️ зависит от версии |
| Синхронность / worker-модель | ✅ sync, легко в worker | ✅ sync |
| Проверенный Electron+vec прецедент | ✅ cherry-studio | ❌ пока нет |
| Ship-риск | низкий | средний |

**Фабрика драйвера (единственная точка ветвления):**
```ts
// core/engine/data/sqlite/driver.ts
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
  iterate<T = unknown>(...params: unknown[]): IterableIterator<T>;
}
export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  loadExtension(path: string): void;
  pragma(source: string): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
}

export function openSqlite(dbPath: string, opts: { readonly?: boolean } = {}): SqliteDriver {
  const impl = process.env.KYREI_SQLITE === 'node' ? 'node' : 'better';
  return impl === 'node' ? openNodeSqlite(dbPath, opts) : openBetterSqlite(dbPath, opts);
}
```

### 1.2 SQLite DDL (полная схема)

Файл БД: `<userData>/kyrei/index.db` (глобальный индекс) + опционально `<workspace>/.kyrei/index.db` (проектный).
JSONL-транскрипты остаются source-of-truth; таблицы ниже — производный индекс (§1.6).

```sql
-- ── meta / версионирование ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL
);
-- INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('schema_version','1');
-- INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('vec_dim','768');

-- ── sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- 'sess_YYYY_MM_DD_NN' (совместимо с ltm/)
  workspace     TEXT,                      -- абсолютный путь workspace (nullable для global)
  title         TEXT,
  started_at    TEXT NOT NULL,             -- ISO-8601 UTC
  ended_at      TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- active|complete|interrupted|error
  meta_json     TEXT,                      -- произвольные метаданные (model/provider и т.п.)
  jsonl_path    TEXT NOT NULL,             -- путь к транскрипту-SoT
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_ws       ON sessions(workspace, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status   ON sessions(status);

-- ── messages ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,          -- порядок внутри сессии (монотонно)
  role          TEXT NOT NULL,             -- system|user|assistant|tool
  parts_json    TEXT NOT NULL,             -- MessagePart[] (см. design.md)
  text          TEXT,                      -- денормализованный plain-text для FTS
  tool_call_id  TEXT,                      -- для role=tool / tool-part pairing
  token_est     INTEGER,                   -- локальная оценка токенов части
  compacted     INTEGER NOT NULL DEFAULT 0,-- 1 = вытеснено компакцией (тело в CCR)
  ccr_hash      TEXT,                      -- ссылка на CCR-запись, если compacted=1
  created_at    TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_session  ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_toolid   ON messages(tool_call_id);

-- ── memory_docs (проекция markdown-слоёв: session/project/global) ────────
CREATE TABLE IF NOT EXISTS memory_docs (
  id            TEXT PRIMARY KEY,          -- стабильный id (hash пути+scope)
  scope         TEXT NOT NULL,             -- session|project|global
  kind          TEXT NOT NULL,             -- memory|notes|steering|agents|handoff|checkpoint
  path          TEXT NOT NULL,             -- абсолютный путь markdown-файла (SoT)
  workspace     TEXT,
  title         TEXT,
  body          TEXT NOT NULL,             -- текущее содержимое (для FTS/эмбеддинга)
  frontmatter_json TEXT,                   -- YAML-фронтматтер → JSON
  content_hash  TEXT NOT NULL,             -- sha256 body (детект рассинхрона)
  source_ref    TEXT,                      -- ltm id (evt_/chk_/sess_) если из ltm-bridge
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memdocs_scope     ON memory_docs(scope, kind);
CREATE INDEX IF NOT EXISTS idx_memdocs_ws        ON memory_docs(workspace);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memdocs_path ON memory_docs(path);

-- ── vectors (метаданные эмбеддингов; сами float32 в vec0-таблице) ────────
CREATE TABLE IF NOT EXISTS vectors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type    TEXT NOT NULL,             -- 'memory_doc' | 'message' | 'chunk'
  owner_id      TEXT NOT NULL,             -- memory_docs.id / messages.id / chunk id
  chunk_index   INTEGER NOT NULL DEFAULT 0,-- для AST/строковых чанков
  model         TEXT NOT NULL,             -- имя embedding-модели
  dim           INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,             -- дедуп: не переэмбеддить неизменённое
  created_at    TEXT NOT NULL,
  UNIQUE(owner_type, owner_id, chunk_index, model)
);
CREATE INDEX IF NOT EXISTS idx_vectors_owner     ON vectors(owner_type, owner_id);
```

**Виртуальные таблицы (FTS5 + sqlite-vec vec0).** Создаются отдельным шагом после загрузки расширения:

```sql
-- FTS5: keyword-поиск по сообщениям и memory-докам (external-content pattern).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, body,
  content='memory_docs',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Триггеры синхронизации external-content FTS (messages):
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

-- sqlite-vec: хранилище float32-эмбеддингов. dim фиксируется из schema_meta.vec_dim.
-- rowid vec-таблицы == vectors.id (1:1), чтобы JOIN был по rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
  embedding float[768]
);
```

> `vec0` не поддерживает произвольные `ALTER`; при смене embedding-модели/`dim` таблица `vec_items` пересоздаётся из `vectors`+worker-реэмбеддинг (см. миграции §1.7).

### 1.3 Загрузка `sqlite-vec` как loadable-расширения + `asarUnpack`

`sqlite-vec` — нативный бинарь; в упакованном Electron его нельзя держать внутри `app.asar` (нельзя `dlopen` из архива). Кладём в `asarUnpack` и грузим по абсолютному распакованному пути.

**`electron-builder` конфиг:**
```jsonc
// electron-builder.yml / package.json "build"
{
  "asar": true,
  "asarUnpack": [
    "**/node_modules/sqlite-vec-*/**",       // пребилты per-OS
    "**/node_modules/better-sqlite3/**"       // нативный аддон драйвера
  ],
  "files": ["dist/**", "node_modules/**"]
}
```

**Разрешение пути (работает и в dev, и в упакованном):**
```ts
// core/engine/data/sqlite/vec.ts
import { app } from 'electron';
import { join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';   // экспортирует getLoadablePath()

/** В упакованном приложении asar-путь → unpacked-путь. */
function unpacked(p: string): string {
  return p.replace(`app.asar${sepDir}`, `app.asar.unpacked${sepDir}`);
}
const sepDir = require('node:path').sep;

export function loadVec(db: SqliteDriver): void {
  // sqlite-vec.getLoadablePath() возвращает путь к .dll/.dylib/.so под текущую ОС/арх.
  let extPath = sqliteVec.getLoadablePath();
  if (app?.isPackaged) extPath = unpacked(extPath);
  db.loadExtension(extPath);              // better-sqlite3: прямой вызов
  // node:sqlite: драйвер должен быть открыт с { allowExtension: true } (см. openNodeSqlite)
  const [{ v }] = db.prepare('select vec_version() as v').all<{ v: string }>();
  if (!v) throw new Error('sqlite-vec failed to load');
}
```

**`node:sqlite`-специфика загрузки** (требует `allowExtension` в конструкторе — проверено):
```ts
// core/engine/data/sqlite/driver.node.ts
import { DatabaseSync } from 'node:sqlite';
export function openNodeSqlite(dbPath: string, opts: { readonly?: boolean }): SqliteDriver {
  const db = new DatabaseSync(dbPath, { allowExtension: true, readOnly: !!opts.readonly });
  // ... адаптер под SqliteDriver; db.loadExtension(path) доступен благодаря allowExtension
  // После загрузки vec — по желанию db.enableLoadExtension(false) для безопасности.
}
```

**Smoke-тест на 3 ОС (CI-gate):** открыть БД → `loadVec` → `select vec_version()` → вставить/найти 1 вектор. Падение = блок мержа (см. `docs/blueprint-security-reliability-testing.md` verification-gate).

### 1.4 Single-writer WAL + busy_timeout

Модель: **одно соединение-писатель** живёт в процессе-владельце (gateway или dedicated worker), все прочие процессы (main, renderer-through-gateway) открывают **read-only** соединения. Синхронное `better-sqlite3` делает запись атомарной по построению — нет write-mutex/BUSY-retry слоя (подтверждено практикой cherry-studio).

**PRAGMA-инициализация писателя (один раз при открытии):**
```ts
// core/engine/data/sqlite/init.ts
export function initWriter(db: SqliteDriver): void {
  db.pragma('journal_mode = WAL');        // конкурентные read при одном write
  db.pragma('synchronous = NORMAL');      // WAL: durable при NORMAL, быстрее FULL
  db.pragma('busy_timeout = 5000');       // ждать до 5с вместо мгновенного SQLITE_BUSY
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 1000'); // checkpoint каждые ~1000 страниц
  db.pragma('cache_size = -16000');       // ~16MB page-cache
  db.pragma('mmap_size = 268435456');     // 256MB mmap (ускоряет чтение)
}
export function initReader(db: SqliteDriver): void {
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
}
```

**Правила concurrency:**
- Единственный writer сериализует все `INSERT/UPDATE/DELETE`; кросс-процессный доступ к writer идёт через IPC к владельцу, не через второе write-соединение.
- Долгие/массовые записи (bulk-embedding, rebuild) — в worker-thread с собственным writer-соединением, **но** его запускает только процесс-владелец, чтобы «single-writer» инвариант не нарушался (worker и gateway не пишут одновременно; координация через очередь задач §6).
- `busy_timeout=5000` — страховка на случай checkpoint-конкуренции с read-only читателями.

### 1.5 TS-порты: `SessionStore` / `MemoryStore` / `VectorStore`

```ts
// core/engine/data/ports.ts
export interface SessionRecord {
  id: string; workspace?: string; title?: string;
  startedAt: string; endedAt?: string;
  status: 'active' | 'complete' | 'interrupted' | 'error';
  meta?: Record<string, unknown>; jsonlPath: string;
}
export interface StoredMessage {
  sessionId: string; seq: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: MessagePart[]; text?: string; toolCallId?: string;
  tokenEst?: number; compacted?: boolean; ccrHash?: string; createdAt: string;
}

export interface SessionStore {
  createSession(rec: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionRecord[]>;
  appendMessage(msg: StoredMessage): Promise<number>;          // → seq/id
  getMessages(sessionId: string, opts?: { fromSeq?: number }): Promise<StoredMessage[]>;
  markCompacted(sessionId: string, seqRange: [number, number], ccrHash: string): Promise<void>;
  searchMessages(query: string, opts?: { sessionId?: string; limit?: number }): Promise<StoredMessage[]>; // FTS5
}

export interface MemoryDoc {
  id: string; scope: 'session' | 'project' | 'global';
  kind: 'memory' | 'notes' | 'steering' | 'agents' | 'handoff' | 'checkpoint';
  path: string; workspace?: string; title?: string;
  body: string; frontmatter?: Record<string, unknown>;
  contentHash: string; sourceRef?: string; updatedAt: string;
}
export interface MemoryStore {
  upsertDoc(doc: MemoryDoc): Promise<void>;
  getDoc(id: string): Promise<MemoryDoc | null>;
  listDocs(opts: { scope?: MemoryDoc['scope']; kind?: MemoryDoc['kind']; workspace?: string }): Promise<MemoryDoc[]>;
  search(query: string, opts?: { scope?: MemoryDoc['scope']; limit?: number }): Promise<MemoryDoc[]>; // FTS5
  removeDoc(id: string): Promise<void>;
}

export interface VectorHit { ownerType: string; ownerId: string; chunkIndex: number; distance: number; }
export interface VectorStore {
  upsert(rows: Array<{ ownerType: string; ownerId: string; chunkIndex: number;
    model: string; embedding: Float32Array; contentHash: string }>): Promise<void>;
  query(embedding: Float32Array, opts: { k: number; ownerType?: string }): Promise<VectorHit[]>;
  deleteByOwner(ownerType: string, ownerId: string): Promise<void>;
  /** Гибрид: vector + FTS5 с Reciprocal-Rank-Fusion (research §27.1). */
  hybridSearch(query: { text: string; embedding: Float32Array }, opts: { k: number }): Promise<VectorHit[]>;
}
```

`VectorStore.query` (sqlite-vec KNN):
```sql
SELECT v.owner_type, v.owner_id, v.chunk_index, k.distance
FROM vec_items k
JOIN vectors v ON v.id = k.rowid
WHERE k.embedding MATCH :queryVec AND k.k = :k
ORDER BY k.distance;              -- vec0 KNN: MATCH + k=, ORDER BY distance
```

### 1.6 JSONL-как-SoT ↔ SQLite index rebuild

**Принцип (design.md §Data Layer):** JSONL-транскрипт на сессию — единственный source-of-truth. SQLite/FTS5/vec — производный, полностью **выбрасываемый** индекс, пересобираемый из JSONL при рассинхроне/повреждении.

Layout транскриптов: `<userData>/kyrei/transcripts/<session_id>.jsonl` — append-only, одна строка = один `StoredMessage` (плюс события сессии). `ltm/store/*.jsonl` — отдельный журнал событий/чекпоинтов (см. §5), НЕ дублируется.

**Процедура rebuild (`data/sqlite/rebuild.ts`):**
```ts
export async function rebuildIndex(db: SqliteDriver, transcriptsDir: string): Promise<RebuildReport> {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM vectors;');
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');"); // FTS integrity rebuild
  });
  tx();
  // 1. сканируем каждый <session_id>.jsonl построчно (stream, не грузим в память)
  // 2. первая мета-строка → sessions; последующие → messages(+seq)
  // 3. денормализуем text для FTS; token_est считаем лениво (§2)
  // 4. эмбеддинги НЕ считаем в rebuild синхронно — ставим задачу в worker-очередь (§6)
  // 5. обновляем schema_meta.last_rebuild_at
  return report; // { sessions, messages, durationMs }
}
```

**Детект рассинхрона (запуск rebuild):**
- при старте: сравнить `count(*)` строк JSONL с `messages` по сессии; расхождение → rebuild этой сессии;
- при `SQLITE_CORRUPT`/ошибке открытия БД → удалить `index.db*` и полный rebuild;
- CLI/команда `kyrei index rebuild [--session <id>]` для ручного вызова.
- Тяжёлый rebuild (много сессий) уходит в worker-thread (§6), UI показывает прогресс.

**Инвариант:** удаление `index.db` никогда не теряет данные — всё восстановимо из JSONL + `ltm/`.

### 1.7 Schema migration / versioning

Версия хранится в `schema_meta.schema_version` (текущая = `1`). Миграции — упорядоченный массив идемпотентных шагов; применяются в одной транзакции с bump версии.

```ts
// core/engine/data/sqlite/migrations.ts
interface Migration { version: number; up(db: SqliteDriver): void; }

const MIGRATIONS: Migration[] = [
  { version: 1, up: (db) => { db.exec(DDL_V1 /* §1.2 базовые таблицы + индексы */); } },
  // { version: 2, up: (db) => db.exec('ALTER TABLE sessions ADD COLUMN cost_usd REAL;') },
];

export function migrate(db: SqliteDriver): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get<{ value: string }>();
  const current = row ? Number(row.value) : 0;
  const pending = MIGRATIONS.filter(m => m.version > current).sort((a, b) => a.version - b.version);
  const run = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      db.prepare(`INSERT INTO schema_meta(key,value) VALUES('schema_version',?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(m.version));
    }
  });
  run();
}
```

**Правила миграций:**
- Виртуальные таблицы (FTS5/vec0) и триггеры создаются **после** `migrate()` и после `loadVec()` (расширение должно быть загружено). Их пересоздание безопасно (`IF NOT EXISTS` / drop+create для vec при смене `dim`).
- Смена embedding-модели/`dim`: bump `schema_meta.vec_dim`, `DROP TABLE vec_items`, пересоздать, поставить worker-реэмбеддинг всех `vectors` из `memory_docs.body`/`messages.text`.
- Down-миграции не поддерживаем (local-first, откат = rebuild из JSONL SoT).
- `session-store.js` (v1, JSON-файл `state.json`, `SCHEMA_VERSION=1`) продолжает работать параллельно за флагом; порт `SessionStore` v2 читает те же сессии при первом запуске (импорт-адаптер), но новый SoT — JSONL.

---

## 2. Token Estimation — `core/engine/context/tokens.ts`

Цель: дешёвая локальная оценка токенов + сверка с `usage` провайдера, чтобы триггерить компакцию до 400/overflow. Двойной триггер `max(localEstimate, providerUsage)` (design.md §Token Estimation).

### 2.1 Пер-провайдерная стратегия

```ts
// core/engine/context/tokens.ts
export type TokenizerKind = 'o200k' | 'cl100k' | 'heuristic';

/** Выбор энкодинга по id модели/провайдеру. */
export function pickTokenizer(model: string): TokenizerKind {
  const m = model.toLowerCase();
  // OpenAI новые (GPT-4o, o1/o3/o4, GPT-4.1) → o200k_base
  if (/(gpt-4o|gpt-4\.1|o1|o3|o4|omni)/.test(m)) return 'o200k';
  // OpenAI старые (gpt-4, gpt-3.5, text-embedding-*) → cl100k_base
  if (/(gpt-4|gpt-3\.5|turbo|cl100k|text-embedding)/.test(m)) return 'cl100k';
  // Claude / локальные (Llama, Qwen, Mistral, Ollama) — нет точного JS-токенайзера → эвристика
  return 'heuristic';
}
```

Реализация энкодеров через `gpt-tokenizer` (подпакеты по энкодингу, ленивый импорт, чтобы не тянуть обе BPE-таблицы сразу):
```ts
// ленивый кэш энкодеров
let _o200k: typeof import('gpt-tokenizer/encoding/o200k_base') | null = null;
let _cl100k: typeof import('gpt-tokenizer/encoding/cl100k_base') | null = null;

async function encodeCount(text: string, kind: TokenizerKind): Promise<number> {
  if (kind === 'o200k') {
    _o200k ??= await import('gpt-tokenizer/encoding/o200k_base');
    return _o200k.encode(text).length;
  }
  if (kind === 'cl100k') {
    _cl100k ??= await import('gpt-tokenizer/encoding/cl100k_base');
    return _cl100k.encode(text).length;
  }
  return heuristicCount(text);
}
```

**Эвристика для Claude / локальных (нет точного токенайзера):**
```ts
/**
 * Калиброванная оценка с запасом. Базис: ~1 токен ≈ 4 символа англ. текста,
 * но код/CJK/пунктуация плотнее. Берём max по нескольким сигналам + safety margin.
 */
export function heuristicCount(text: string): number {
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  const byChars = chars / 3.6;              // консервативнее, чем /4
  const byWords = words * 1.35;             // ~0.75 слова/токен → 1.33 токена/слово
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length; // CJK ≈ 1 токен/символ
  const base = Math.max(byChars, byWords) + cjk * 0.6;
  return Math.ceil(base * SAFETY_MARGIN);   // SAFETY_MARGIN = 1.15 (+15%, design.md)
}
const SAFETY_MARGIN = 1.15;
```

### 2.2 Чтение `usage` провайдера из finish-части

`streamText`-мост (`stream-bridge.ts`) достаёт usage из финальной части потока. На v5 поле — `finish.totalUsage` (на старых `finish.usage`); для OpenAI-совместимых обязателен `stream_options.include_usage:true`, иначе `usage=null` (design.md §Token Estimation).

```ts
export interface ProviderUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; }

/** Извлечь usage из finish-части fullStream (v5: totalUsage; fallback usage). */
export function readUsage(finishPart: any): ProviderUsage | null {
  const u = finishPart?.totalUsage ?? finishPart?.usage;
  if (!u) return null;                      // провайдер не прислал — опираемся на localEstimate
  return {
    inputTokens: u.inputTokens ?? u.promptTokens,
    outputTokens: u.outputTokens ?? u.completionTokens,
    totalTokens: u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0)),
  };
}
```

Обработка неполного usage: если есть `inputTokens`, но нет `totalTokens` — достраиваем; если usage вовсе нет — используем накопленный `localEstimate` истории.

### 2.3 Локальная оценка истории и `isOverflow()`

```ts
export interface TokenBudget { window: number; softPct: number; hardPct: number; }
export interface EstimateResult { localEstimate: number; providerUsage: number | null; effective: number; }

/** Оценка всей истории сообщений локально (кэш per-message в StoredMessage.tokenEst). */
export async function estimateMessages(messages: ModelMessage[], model: string): Promise<number> {
  const kind = pickTokenizer(model);
  let sum = 0;
  for (const m of messages) {
    const text = partsToText(m);            // конкатенация text/reasoning/tool-io частей
    sum += await encodeCount(text, kind);
    sum += PER_MESSAGE_OVERHEAD;            // ~4 токена на роль/разметку сообщения
  }
  return sum;
}
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Двойной триггер (design.md §Token Estimation):
 * effective = max(localEstimate, providerUsage); overflow при effective ≥ softPct·window.
 */
export function isOverflow(est: EstimateResult, budget: TokenBudget): {
  soft: boolean; hard: boolean; ratio: number;
} {
  const effective = Math.max(est.localEstimate, est.providerUsage ?? 0);
  const ratio = effective / budget.window;
  return {
    soft: effective >= budget.softPct * budget.window,   // деф. softPct = 0.75
    hard: effective >= budget.hardPct * budget.window,   // деф. hardPct = 0.90
    ratio,
  };
}
```

`budget.window` берётся из provider-registry (`limits.contextWindow` модели, design.md §Provider). `softPct/hardPct` — из `EngineConfig.contextBudget`. `soft` → мягкая компакция (prune tool-outputs); `hard` → полная компакция + при необходимости handoff (§3).

---

## 3. Compaction — `core/engine/context/compaction.ts`

Интеграция через `prepareStep` (design.md §Context, §Orchestrator): при overflow возвращаем скомпактированные `messages`. Компакция ломает prompt-cache → запускается **редко, на пороге**, не каждый шаг (баланс Req 5.2 ↔ 5.5).

**Инвариант (КРИТИЧНО):** нельзя удалять `assistant`-сообщение с `tool_calls` без парного `tool`-результата и наоборот (иначе провайдер вернёт 400). Prune и summary работают только над **завершёнными парами**.

### 3.1 Never-prune набор

```ts
const NEVER_PRUNE = {
  systemPrompt: true,        // system-сообщение(я)
  toolDefinitions: true,     // определения инструментов (вне messages, но учитываем в бюджете)
  lastNTurns: 3,             // последние N полных ходов (assistant+tool пары) не трогаем
  pinnedByMarker: true,      // сообщения с маркером «pinned» (напр. активный план)
};
```

### 3.2 Фаза 1 — детерминированный prune tool-outputs

Дешёвая, обратимая (CCR §4), без LLM. Урезаем **тела результатов инструментов**, сохраняя пары.

```ts
export interface PruneConfig {
  maxToolOutputChars: number;   // деф. 12000 (= EngineConfig.maxToolOutput)
  pruneToChars: number;         // до скольки ужимать при pruning, деф. 500 (head+tail)
  neverPruneTools: string[];    // напр. ['attempt_completion'] — их результат критичен
  keepLastNTurns: number;       // деф. 3
}

/**
 * Проходим messages от начала до (len - keepLastNTurns*2).
 * Для каждой завершённой tool-пары, чьё tool-тело > maxToolOutputChars:
 *   1) кладём оригинал в CCR → hash;
 *   2) заменяем тело на head+tail усечение + маркер восстановления.
 * assistant.tool_calls НЕ трогаем — только tool-результаты (пара сохраняется).
 */
export function pruneToolOutputs(messages: ModelMessage[], cfg: PruneConfig, ccr: CcrStore): ModelMessage[]
```

Маркер усечения (модель видит, что можно восстановить):
```
[tool output truncated: 14231 chars → 500. Full output retrievable via retrieve("sha256:ab12…")]
<первые 250 символов>
…
<последние 250 символов>
```

**Пороги (когда что пруним):**
| Условие | Действие |
|---|---|
| `soft` overflow (≥75%) | prune tool-outputs > `maxToolOutputChars` вне last-N ходов |
| всё ещё `soft` после prune | prune tool-outputs > 2000 символов вне last-N |
| `hard` overflow (≥90%) | prune всё (кроме never-prune) + перейти к фазе 2 |

**Что никогда не пруним:** system-prompt, определения инструментов, результаты `neverPruneTools`, сообщения last-N ходов, pinned-маркированные.

### 3.3 Фаза 2 — LLM-summary

Запускается, если после фазы 1 всё ещё `hard` overflow. Суммаризирует **старую зону** истории (всё до last-N ходов) в одно `assistant`-сообщение-конспект + маркер точки компакции. Оригиналы старой зоны → CCR.

```ts
export interface SummarizeConfig {
  role: 'small' | 'plan';       // дешёвая модель (design.md provider roles)
  keepLastNTurns: number;
  maxSummaryTokens: number;     // деф. 1500
}

const SUMMARY_SYSTEM = `Ты — компактор контекста. Сожми диалог в структурированный конспект,
сохранив: намерение задачи, принятые решения и их причины, изменённые файлы и ключевые пути,
открытые вопросы, ограничения, следующий шаг. НЕ выдумывай. Пиши плотно, без воды.`;

const SUMMARY_MARKER = '⟪KYREI-COMPACTION⟫'; // маркер начала конспекта

/**
 * 1) взять oldZone = messages[systemEnd .. len - keepLastNTurns*2] (только полные пары);
 * 2) вызвать модель роли `small` c SUMMARY_SYSTEM над oldZone (без tools, анти-рекурсия);
 * 3) сохранить каждую вытесненную пару в CCR (hash);
 * 4) вернуть [ ...system, {role:'assistant', text: SUMMARY_MARKER + summary,
 *      metadata:{ compaction:true, coversSeq:[a,b], ccrHashes:[...] }}, ...lastNTurns ];
 * 5) записать событие компакции в ltm-bridge (§5) как checkpoint-подобную запись.
 */
export async function summarize(messages: ModelMessage[], cfg: SummarizeConfig,
  llm: LlmRole, ccr: CcrStore): Promise<ModelMessage[]>
```

Форма итогового конспекта (шаблон, который модель заполняет):
```
⟪KYREI-COMPACTION⟫ (covers turns 1–N; originals retrievable via retrieve(hash))
## Intent
## Decisions (+ rationale)
## Files touched (key paths)
## Open questions
## Constraints
## Next step
```

### 3.4 Ранние чекпоинты 20 / 45 / 70 %

Проценты считаются **от softPct-бюджета живой зоны** (не от всего окна), чтобы чекпоинты срабатывали заранее и не конфликтовали с порогом компакции. `checkpointBudget = softPct * window`.

```ts
const CHECKPOINT_MARKS = [0.20, 0.45, 0.70]; // доли checkpointBudget

/**
 * На пересечении каждой отметки (один раз за отметку за сессию):
 *   - писать distilled-checkpoint в ltm-bridge (§5) — summary+decisions+next_actions;
 *   - обновлять memory/notes.md (scratch) главного агента;
 *   - НЕ компактить и НЕ ломать prompt-cache (чекпоинт — побочная запись, не мутация messages).
 * Это создаёт «точки восстановления» задолго до overflow, чтобы handoff (§5) имел свежий seed.
 */
export function maybeCheckpoint(effectiveTokens: number, checkpointBudget: number,
  fired: Set<number>, sink: CheckpointSink): void
```

### 3.5 Взаимодействие с prompt-cache

- Компакция мутирует префикс истории → инвалидирует provider-side prompt-cache. Поэтому:
  - фаза 1/2 запускаются **только** на пороге (`soft`/`hard`), а не каждый шаг;
  - ранние чекпоинты (§3.4) — это **сайд-запись** (ltm + notes.md), они **не** меняют `messages`, значит кэш не рушат;
  - last-N ходов и system-prompt остаются байт-стабильными между шагами без overflow → кэш держится;
  - после компакции новый префикс (system + конспект) стабилен до следующего порога → кэш восстанавливается на последующих шагах.
- `prepareStep` возвращает изменённые `messages` **лениво**: если `isOverflow().soft === false`, возвращает исходный массив (identity) — ноль инвалидаций.

---

## 4. CCR (Content-addressable Compaction Recall) — `core/engine/context/ccr.ts`

Обратимое сжатие: любой вытесненный/усечённый фрагмент восстановим по хешу (design.md Property 6, Req 5.4). Реализует инвариант «нет безвозвратной потери».

### 4.1 Дисковый layout

```
<userData>/kyrei/ccr/
  ab/                          # шардинг по первым 2 hex-символам хеша
    ab12cd34…json.gz          # gzip-сжатое тело фрагмента
  index.db → таблица ccr_blobs  # метаданные (в том же index.db, отдельная таблица)
```

```sql
CREATE TABLE IF NOT EXISTS ccr_blobs (
  hash        TEXT PRIMARY KEY,      -- 'sha256:<hex>'
  session_id  TEXT,                  -- откуда вытеснено (для GC по сессии)
  kind        TEXT NOT NULL,         -- 'tool_output' | 'message' | 'turn_range'
  byte_size   INTEGER NOT NULL,      -- размер сжатого блоба
  orig_chars  INTEGER NOT NULL,      -- исходная длина (для UI/метрик)
  ref_count   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  last_access TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccr_session ON ccr_blobs(session_id);
CREATE INDEX IF NOT EXISTS idx_ccr_access  ON ccr_blobs(last_access);
```

### 4.2 Хеш-схема

- Алгоритм: `sha256` над **сырым UTF-8** содержимого фрагмента, префикс `sha256:`.
- Content-addressable → дедуп: одинаковый tool-output вытесняется один раз, `ref_count++`.
- Путь блоба: `ccr/<hash[7:9]>/<hash[7:]>.json.gz` (шард по 2 символам после префикса).

```ts
export function ccrHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}
```

### 4.3 API + tool-схема `retrieve`

```ts
// core/engine/context/ccr.ts
export interface CcrStore {
  put(content: string, meta: { sessionId?: string; kind: string }): Promise<string>; // → hash
  get(hash: string): Promise<string | null>;      // распаковка gzip; bump last_access
  has(hash: string): Promise<boolean>;
  gc(policy: GcPolicy): Promise<{ removed: number; freedBytes: number }>;
}
```

Инструмент, доступный модели (регистрируется в `tools/`), — чтобы агент мог развернуть усечённое:
```ts
export const retrieveTool = tool({
  description: 'Восстановить полное содержимое ранее усечённого/скомпактированного фрагмента по его CCR-хешу (из маркера [... retrievable via retrieve("sha256:…")]).',
  inputSchema: z.object({ hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
  async execute({ hash }, { abortSignal }): Promise<ToolResult> {
    const body = await ccr.get(hash);
    if (body == null) return { title: 'retrieve', output: `CCR miss: ${hash} (возможно, собран GC)` };
    return { title: 'retrieve', output: body, metadata: { hash, restored: true } };
  },
});
```

### 4.4 GC / retention

```ts
export interface GcPolicy {
  maxTotalBytes: number;     // деф. 256MB на CCR-стор
  maxAgeDays: number;        // деф. 30 (совпадает с ltm event_retention_days)
  keepReferenced: boolean;   // не удалять blob с ref_count>0 в активной сессии
}
```
- LRU по `last_access` + возрастной порог `maxAgeDays`; при превышении `maxTotalBytes` удаляем самые старые невостребованные.
- Не удаляем блобы, на которые ссылается **активная** (незавершённая) сессия (`sessions.status='active'`).
- GC запускается: idle-хук + при старте, если стор > `maxTotalBytes`. Тяжёлый GC — в worker (§6).
- Осиротевший `retrieve` (CCR miss после GC) не роняет цикл — возвращает actionable-текст (агент продолжает без фрагмента).

### 4.5 Cross-restart persistence

- Блобы и `ccr_blobs`-метаданные — на диске, переживают перезапуск процесса/приложения.
- CCR-хеши хранятся в `messages.ccr_hash` и в metadata конспекта компакции → после рестарта и rebuild индекса (§1.6) ссылки остаются валидными (хеш — от содержимого, не от rowid).
- Если `index.db` пересобран, а блоб на диске есть — `ccr_blobs` восстанавливается сканом каталога `ccr/**` (хеш = имя файла), метаданные (`kind/session`) берутся из маркеров в JSONL SoT.

---

## 5. Memory — `core/engine/memory/**`

### 5.1 Layout `.kyrei/` (слоёная память)

```
<workspace>/.kyrei/
  memory/
    MEMORY.md            # ПРОЕКТНЫЙ слой (SoT, семантическая память проекта)
    notes.md             # SCRATCH главного агента (единственное, куда пишет главный агент)
  snapshots/             # обратимые снапшоты правок (apply-движок, design.md §4)
  handoff/
    handoff-<id>.md      # distilled handoff-артефакт (§5.6)
  index.db               # (опц.) проектный SQLite-индекс
<userData>/kyrei/
  memory/
    GLOBAL.md            # ГЛОБАЛЬНЫЙ слой (кросс-проектные предпочтения)
  transcripts/*.jsonl    # SoT-транскрипты сессий
  ccr/**                 # CCR-стор
  index.db               # глобальный индекс
<workspace>/
  AGENTS.md              # проектные инструкции агенту (высокий приоритет, см. §5.5)
  .kiro/steering/*.md    # steering-правила (существующие)
```

**Три слоя (design.md §Memory, research §22):**
1. **session** — чекпоинт текущей сессии (в `ltm/` + notes.md scratch);
2. **project** — `MEMORY.md` / `AGENTS.md` / `.kiro/steering/**` (markdown = SoT);
3. **global** — `<userData>/kyrei/memory/GLOBAL.md`.

Markdown — source-of-truth; `memory_docs`+FTS5+vec (§1.2) — производный индекс (проекция).

### 5.2 Writer-роль + enforced write-paths

```ts
// core/engine/memory/writer.ts
export type MemoryScope = 'session' | 'project' | 'global';

/** Разрешённые пути записи по роли. Главный агент — ТОЛЬКО notes.md scratch. */
const WRITE_PATHS: Record<'main' | 'writer', RegExp[]> = {
  main:   [/\.kyrei[\/\\]memory[\/\\]notes\.md$/],           // scratch only
  writer: [/\.kyrei[\/\\]memory[\/\\]MEMORY\.md$/,
           /\.kyrei[\/\\]handoff[\/\\]handoff-[\w-]+\.md$/,
           /kyrei[\/\\]memory[\/\\]GLOBAL\.md$/],
};

export function assertWritable(role: 'main' | 'writer', absPath: string): void {
  const ok = WRITE_PATHS[role].some(rx => rx.test(absPath));
  if (!ok) throw new Error(`memory write denied: role=${role} path=${absPath}`);
}
```

- **Writer-роль** — отдельный шаг/подвызов (не главный цикл): консолидирует scratch → `MEMORY.md`, пишет handoff, обновляет global. Использует дешёвую модель (роль `small`), не имеет доступа к деструктивным инструментам.
- Главный агент пишет **только** `notes.md` (scratch). Это защищает структурные файлы от несогласованных правок (design.md §Memory Req 6.3).
- Все записи в структурные файлы проходят через `writer.ts` → `assertWritable` → single-writer lock (§5.3).

### 5.3 Single-writer кросс-процессный lock (main / gateway / worker)

Процессы Kyrei (main, gateway, worker) могут одновременно захотеть писать в один markdown/JSONL. Сериализуем через файловый advisory-lock.

```ts
// core/engine/memory/lock.ts
/**
 * Кросс-процессный lock через атомарное создание lockfile (O_CREAT|O_EXCL).
 * Один writer на структурный файл. Stale-lock детектится по PID+mtime.
 */
export async function withFileLock<T>(target: string, fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const lock = target + '.lock';
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    try {
      // wx = O_CREAT|O_EXCL|O_WRONLY — атомарно, падает если lock существует
      const fd = await open(lock, 'wx');
      await fd.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fd.close();
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if (await isStale(lock, opts.staleMs ?? 30000)) { await rm(lock).catch(() => {}); continue; }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${target}`);
      await sleep(50 + Math.random() * 50); // джиттер против thundering herd
    }
  }
  try { return await fn(); } finally { await rm(lock).catch(() => {}); }
}
```

- Пишущие записи в `MEMORY.md`/`notes.md`/`GLOBAL.md`/`handoff` и в `ltm/store/*.jsonl` (через bridge) — под `withFileLock`.
- SQLite-запись уже сериализована single-writer соединением (§1.4); lock нужен для **markdown/JSONL** файлов, которые пишут разные процессы.
- Существующие `ltm/`-локи (`auth.lock`, `cron/*.lock`) — тот же паттерн; переиспользуем соглашение `<file>.lock`.

### 5.4 Дедуп с существующим `ltm/` (bridge, не дублировать)

**Принцип (design.md §Memory Req 6.5):** НЕ создавать второй параллельный JSONL-журнал. `ltm/store/*.jsonl` — **единый ledger событий/чекпоинтов**. Движок Kyrei пишет туда через `ltm-bridge`. `MEMORY.md`-слой — это семантическая проекция поверх ledger, а не дубль.

Форматы ledger фиксированы (`.kiro/steering/ltm-memory-format.md`) — bridge пишет строго в них:

```ts
// core/engine/memory/ltm-bridge.ts
export interface LtmBridge {
  /** Событие file_write (после apply/write_file). Пишет в ltm/store/events.jsonl. */
  captureEvent(e: { filesChanged: string[]; branch?: string; sessionId: string;
    source: 'kyrei:apply' | 'kyrei:tool'; }): Promise<void>;
  /** Чекпоинт (ранние отметки §3.4, завершение фазы, компакция). → checkpoints.jsonl */
  checkpoint(c: { summary: string; changedFiles: string[];
    decisions: Array<{ decision: string; rationale: string }>;
    openThreads: string[]; nextActions: string[]; sessionId: string; }): Promise<void>;
  /** Recall для reseed (§5.6) — читает active-context.json + last-recall.md. */
  recall(): Promise<{ recentFiles: string[]; openThreads: string[]; nextActions: string[] }>;
}
```

**Реализация:** тонкая обёртка, вызывающая тот же формат, что Python-CLI (`ltm/bin/ltm.py`):
- запись — прямой append в `ltm/store/events.jsonl` / `checkpoints.jsonl` в формате из steering (id-схема `evt_NNNNNN`/`chk_NNNNNN`, генерация id как в `_next_id`), под `withFileLock` (§5.3);
- **секрет-редакция обязательна** перед записью (те же паттерны, что в steering: `sk_live_`, `sk_test_`, `AKIA`, `ghp_`, `gho_`, `-----BEGIN`, `Bearer`, base64 40+) — переиспользуем `security/secrets.ts`;
- `session_id` синхронизируется с `ltm/runtime/current-session.json` (тот же ID и в `sessions` таблице §1.2, поле `id`);
- чтение/recall может делегироваться Python-CLI (`python ltm/bin/ltm.py files/sessions/checkpoints`, путь из `ltm/config.json` `python_cmd`) ЛИБО читать JSONL напрямую — bridge выбирает доступный путь;
- **никакого второго JSONL:** `transcripts/*.jsonl` (§1.6) — это транскрипт сообщений (SoT для SQLite-индекса), а `ltm/store/*.jsonl` — журнал событий/решений. Разные назначения, не дублируются: транскрипт = «что сказано», ledger = «что сделано/решено».
- fingerprint-дедуп событий переиспускаем как в `ltm.py` (`_event_fingerprint`: sorted files + git_status + session), чтобы bridge и hook не писали дубли.

### 5.5 AGENTS.md precedence

Порядок применения инструкций (от высшего приоритета к низшему), собирается в system-prompt:
1. **Runtime `EngineConfig`** (permissions/roles) — жёсткие ограничения, не переопределяемы.
2. **`<workspace>/AGENTS.md`** — проектные инструкции агенту (высший «мягкий» слой).
3. **`.kiro/steering/**`** с `inclusion: always` → затем `fileMatch` (по совпадению пути).
4. **`<workspace>/.kyrei/memory/MEMORY.md`** — семантическая память проекта.
5. **`<userData>/kyrei/memory/GLOBAL.md`** — глобальные предпочтения (низший).

```ts
// core/engine/memory/layers.ts
export async function assembleSystemContext(workspace: string): Promise<string> {
  const layers = [
    await readIfExists(join(workspace, 'AGENTS.md')),          // приоритет 2
    ...(await readSteering(workspace)),                         // приоритет 3
    await readIfExists(join(workspace, '.kyrei/memory/MEMORY.md')), // 4
    await readIfExists(join(userData(), 'kyrei/memory/GLOBAL.md')), // 5
  ].filter(Boolean);
  // Конфликты: более высокий слой перекрывает; помечаем источник каждого блока.
  return layers.map((l, i) => `<<layer:${LAYER_NAMES[i]}>>\n${l}`).join('\n\n');
}
```
При конфликте инструкций выигрывает более высокий слой; в system-prompt каждый блок помечается источником, чтобы модель разрешала конфликты детерминированно. Вложенные `AGENTS.md` (в подкаталогах) применяются к путям под ними (ближайший к файлу — приоритетнее), по аналогии со steering `fileMatch`.

### 5.6 Handoff — схема, триггер, reseed

**Триггер (design.md §Memory):** приближение к пределу окна (`hard` overflow из §2.3) **ИЛИ** завершение фазы плана **ИЛИ** явный `handoff`-запрос. Handoff-артефакт создаётся writer-ролью (§5.2).

**Схема артефакта** (`.kyrei/handoff/handoff-<id>.md`, markdown + YAML-фронтматтер):
```yaml
---
id: handoff-<sessionId>-<seq>
created_at: 2026-07-12T10:00:00Z
session_id: sess_2026_07_12_01
trigger: window_limit | phase_complete | explicit
intent: "одно предложение — цель задачи"
constraints: ["не менять public API", "оффлайн-режим"]
---
## Done
- <что уже сделано, буллеты>
## Next actions
- <упорядоченные следующие шаги>
## Key files
- path/to/file.ts — почему важен
## Decisions
- decision — rationale
## Open questions
- <нерешённое>
```

TS-схема (валидируется zod при записи/чтении):
```ts
export interface HandoffArtifact {
  id: string; createdAt: string; sessionId: string;
  trigger: 'window_limit' | 'phase_complete' | 'explicit';
  intent: string; constraints: string[];
  done: string[]; nextActions: string[];
  keyFiles: Array<{ path: string; why: string }>;
  decisions: Array<{ decision: string; rationale: string }>;
  openQuestions: string[];
}
```

**Reseed (старт чистого окна):** новое окно НЕ загружает историю чата. Вместо этого:
```ts
// core/engine/memory/handoff.ts
export async function reseedFromHandoff(h: HandoffArtifact, bridge: LtmBridge): Promise<ModelMessage[]> {
  const recall = await bridge.recall();          // active-context.json + last-recall.md
  const system = renderReseedSystem(h, recall);  // intent+constraints+done+nextActions+keyFiles
  // читаем план-файлы и keyFiles (не chat-историю), кладём как контекст
  const planContext = await readPlanAndKeyFiles(h.keyFiles);
  return [{ role: 'system', content: system }, { role: 'user', content: planContext }];
}
```
- Handoff синхронно пишется и в `ltm/` как checkpoint (через bridge §5.4) — единый ledger.
- После reseed старая сессия помечается `status`-ом, новая создаётся с ссылкой на handoff `id` в `sessions.meta_json`.
- Инвариант: handoff покрывает достаточно, чтобы продолжить без chat-истории (проверяется eval-задачей «resume after handoff»).

---

## 6. Worker-thread offload для тяжёлых операций

Тяжёлые/долгие операции уходят в `worker_threads`, чтобы не блокировать event-loop gateway (design.md §Data «тяжёлое — в worker»). `better-sqlite3` синхронный — идеален для worker (без async-оверхеда), но синхронный вызов на main-потоке блокировал бы; поэтому массовые операции — только в worker.

### 6.1 Что оффлоадим

| Операция | Почему в worker |
|---|---|
| Bulk-embedding (Transformers.js локально) | CPU-bound, сотни мс–секунды |
| Векторный full-scan / реиндексация vec_items | долгий проход по всем строкам |
| Index rebuild из JSONL (§1.6) | I/O + парсинг многих сессий |
| CCR GC (§4.4) при большом сторе | сканы + gzip |
| Компакция-summary — НЕ здесь | это сетевой LLM-вызов, остаётся в orchestrator (async) |

### 6.2 Модель: единственный DB-writer-worker + очередь задач

Чтобы не нарушить single-writer инвариант (§1.4), **пишет только один worker** (DB-owner). Gateway шлёт задачи, worker исполняет последовательно.

```ts
// core/engine/data/worker/pool.ts
export type WorkerJob =
  | { kind: 'embed'; ownerType: string; ownerId: string; chunks: string[]; model: string }
  | { kind: 'rebuild'; transcriptsDir: string; sessionId?: string }
  | { kind: 'ccr_gc'; policy: GcPolicy }
  | { kind: 'vec_reindex'; newDim: number; model: string };

export interface WorkerResult { jobId: string; ok: boolean; data?: unknown; error?: string }

export class DataWorker {
  private worker: Worker;
  private queue = new Map<string, (r: WorkerResult) => void>();
  constructor(dbPath: string) {
    this.worker = new Worker(new URL('./data-worker.js', import.meta.url),
      { workerData: { dbPath } });
    this.worker.on('message', (r: WorkerResult) => this.queue.get(r.jobId)?.(r));
  }
  run(job: WorkerJob): Promise<WorkerResult> {
    const jobId = randomUUID();
    return new Promise((resolve) => { this.queue.set(jobId, resolve);
      this.worker.postMessage({ jobId, job }); });
  }
  async close() { await this.worker.terminate(); }
}
```

```ts
// core/engine/data/worker/data-worker.ts (исполняется в worker-потоке)
import { parentPort, workerData } from 'node:worker_threads';
const db = openSqlite(workerData.dbPath);   // собственное writer-соединение
initWriter(db); loadVec(db);
parentPort!.on('message', async ({ jobId, job }) => {
  try {
    let data: unknown;
    switch (job.kind) {
      case 'embed':      data = await embedAndUpsert(db, job); break;   // Transformers.js
      case 'rebuild':    data = await rebuildIndex(db, job.transcriptsDir); break;
      case 'ccr_gc':     data = await ccrGc(db, job.policy); break;
      case 'vec_reindex':data = await vecReindex(db, job); break;
    }
    parentPort!.postMessage({ jobId, ok: true, data });
  } catch (e: any) { parentPort!.postMessage({ jobId, ok: false, error: String(e?.message ?? e) }); }
});
```

### 6.3 Правила

- Ровно **один** DataWorker-процесс держит writer-соединение; gateway и main открывают read-only (§1.4) для быстрых точечных чтений, а все записи маршрутизируют через `DataWorker.run`.
- Embedding-модель (Transformers.js) грузится один раз внутри worker и переиспользуется (прогрев при старте).
- Отмена: длинные задачи проверяют `AbortSignal` через периодический флаг в `workerData`/`MessageChannel`; rebuild/GC — чекпоинт-абортируемы по батчам.
- Ошибка worker не роняет gateway: `WorkerResult.ok=false` → actionable-лог + graceful degrade (напр. поиск падает на FTS-only, если vec недоступен).

---

## Сводка ключевых решений

| # | Решение | Обоснование |
|---|---|---|
| D1 | Ship-драйвер = `better-sqlite3`; `node:sqlite` — roadmap за флагом | node:sqlite Stability 1.1 (ломкий API); bs3+vec проверен в Electron-проде |
| D2 | `sqlite-vec` в `asarUnpack`, грузится по unpacked абсолютному пути | нельзя `dlopen` из `app.asar` |
| D3 | WAL + single-writer + `busy_timeout=5000`; writer в DataWorker | синхронный bs3 → транзакции корректны by construction |
| D4 | JSONL транскрипты = SoT; SQLite/FTS5/vec = выбрасываемый индекс | rebuild из SoT при рассинхроне/повреждении |
| D5 | Двойной токен-триггер `max(local, providerUsage) ≥ softPct·window` | gpt-tokenizer o200k/cl100k + эвристика +15% для Claude/локальных |
| D6 | Компакция: prune tool-outputs → LLM-summary; только на пороге | сохранение prompt-cache + tool-pair инвариант |
| D7 | Ранние чекпоинты 20/45/70% от softPct-бюджета как сайд-запись | seed для handoff без инвалидации кэша |
| D8 | CCR: content-addressable sha256 + gzip + `retrieve(hash)` tool | обратимость (Property 6), cross-restart persistence |
| D9 | `ltm/` = единый ledger через bridge; MEMORY.md = проекция | без второго JSONL (design.md Req 6.5) |
| D10 | Writer-роль + enforced write-paths + кросс-процессный file-lock | главный агент пишет только notes.md scratch |
| D11 | Handoff-артефакт + reseed из handoff/plan/keyFiles, не из chat | чистое окно на задачу (research §27.1) |

## Порядок реализации (соответствие фазе 5 плана design.md)

1. `data/sqlite/driver.ts` + фабрика + `migrate()` + DDL v1 → smoke-тест открытия БД на 3 ОС.
2. `loadVec` + `asarUnpack` + FTS5/vec0 виртуальные таблицы → smoke `vec_version()`.
3. Порты `SessionStore`/`MemoryStore`/`VectorStore` + `rebuildIndex` из JSONL.
4. `tokens.ts` (o200k/cl100k/эвристика + `isOverflow`) + `readUsage` в stream-bridge.
5. `ccr.ts` (put/get/gc + `retrieveTool`) → property-тест обратимости.
6. `compaction.ts` (prune → summarize + чекпоинты) + интеграция в `prepareStep`.
7. `memory/` (layers + writer + lock + ltm-bridge + handoff) → тест reseed.
8. `data/worker/` (DataWorker + embed/rebuild/gc) → перенос тяжёлого в worker.

Каждый шаг завершается verification-gate (сборка + `tsc --noEmit` + vitest зелёные), см. `docs/blueprint-security-reliability-testing.md`.
