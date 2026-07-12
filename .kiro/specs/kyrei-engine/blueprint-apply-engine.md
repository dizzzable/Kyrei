# Blueprint — Apply-Engine + Tools (Kyrei v2, Windows-first)

> Turnkey реализуемая спецификация подсистем `apply/` и `tools/` из `design.md`.
> Целевая ОС — Windows (workspace на `F:\`), но всё кроссплатформенно.
> Язык ядра — TypeScript (ESM, `"module": "NodeNext"`), сборка через `esbuild`/`tsx` в один бандл, потребляемый `gateway.js`.
> Всё, что ниже — прямо реализуемо, без догадок. Пути в примерах: `F:\pi cli\Kyrei\core\engine\**`.

## 0. Библиотеки (выбор + обоснование)

| Задача | Выбор | Почему |
|---|---|---|
| glob (`find_path`) | **`fast-glob`** (`^3.3`) | Быстрый, стабильный Windows-путь, поддержка `ignore`, `dot`, `onlyFiles`, `absolute`. Не тянет нативных бинарей. |
| ripgrep (`grep_search`) | **`@vscode/ripgrep`** (`^1.15`) + системный `rg` fallback + JS-fallback | Бандлит `rg` per-OS в `node_modules/@vscode/ripgrep/bin/rg(.exe)`. Быстро, надёжно, тот же движок, что в VS Code. |
| Zod-схемы инструментов | **`zod`** (`^3.23`) | Требование 4.2 (`tool()` + `inputSchema`), рантайм-валидация. |
| Детект бинарных файлов | своя эвристика (NUL-byte + UTF-8 validity) | Не тянуть `istextorbinary`; полный контроль, детерминизм для property-тестов. |
| Атомарная запись | `node:fs` (`fs.mkdtemp`/`rename`) свой код | Нужен контроль над temp-на-том-же-томе (Windows rename cross-volume падает). |
| Diff | **свой LCS** (перенос `lineDiff` из v1) | Уже есть, детерминирован, без зависимостей (Req 3.4). |
| Снапшоты | `git` (если репо) ИЛИ копия в `.kyrei/snapshots/` | Req 3.7. `git` через `child_process`, не библиотека — меньше веса. |

Установка:
```
npm i zod fast-glob @vscode/ripgrep
```

---

# 1. Грамматика патча (parse-patch.ts)

## 1.1 Формат (codex-style)

Патч — текстовый блок из одной или нескольких **file-секций**. Каждая секция открывается директивой `*** <Action> File: <path>` и (для Update) содержит **хунки**, разделённые якорями `@@`.

Пример (полный конверт):
```
*** Begin Patch
*** Update File: src/app.ts
@@ class Server
     start() {
-        this.port = 3000;
+        this.port = Number(process.env.PORT ?? 3000);
         this.listen();
     }
*** Add File: src/env.ts
+export const PORT = Number(process.env.PORT ?? 3000);
+export const HOST = process.env.HOST ?? "0.0.0.0";
*** Delete File: src/legacy.ts
*** Move File: src/old.ts -> src/new.ts
*** End Patch
```

Правила строк внутри хунка (первый символ = маркер):
- `' '` (пробел) — **контекст** (строка присутствует и в старом, и в новом файле).
- `'-'` — **удаляемая** строка (есть в старом, нет в новом).
- `'+'` — **добавляемая** строка (нет в старом, есть в новом).
- `'@@ <hint>'` — **якорь-подсказка**: необязательный контекст-заголовок (имя функции/класса), помогает сузить поиск при коллизиях. Текст после `@@` — не regex, а буквальная строка для локализации.

`*** Add File` — далее только `+`-строки (тело нового файла).
`*** Delete File` — тело отсутствует.
`*** Move File: A -> B` — переименование; может сопровождаться Update-хунками (тогда применяются к содержимому после перемещения).

## 1.2 Формальная грамматика (EBNF-ish)

```ebnf
patch          = [ begin_env ] , { file_section } , [ end_env ] ;
begin_env      = "*** Begin Patch" , NL ;
end_env        = "*** End Patch" , [ NL ] ;

file_section   = update_section | add_section | delete_section | move_section ;

update_section = "*** Update File: " , path , NL , { hunk } ;
add_section    = "*** Add File: "    , path , NL , { add_line } ;
delete_section = "*** Delete File: " , path , NL ;
move_section   = "*** Move File: "   , path , " -> " , path , NL , { hunk } ;

hunk           = [ anchor ] , { patch_line }+ ;
anchor         = "@@" , [ SP , hint_text ] , NL ;
patch_line     = ctx_line | del_line | add_line ;
ctx_line       = " "  , line_text , NL ;
del_line       = "-"  , line_text , NL ;
add_line       = "+"  , line_text , NL ;

path           = ? printable, no NL; forward-slashes preferred ? ;
hint_text      = ? any text до NL ? ;
line_text      = ? any text до NL (может быть пустым) ? ;
NL             = "\n" | "\r\n" ;
SP             = " " ;
```

Семантические ограничения (проверяются парсером, не грамматикой):
1. `update_section`/`move_section` должны содержать ≥1 хунк с ≥1 `del`/`add` строкой (иначе no-op → reject, Req 3.14).
2. В одном хунке порядок строк = порядок в файле; `+`-строки вставляются на позицию, где стоят относительно контекста.
3. `path` нормализуется: `\` → `/`, убираются `./`, запрещены `..` и абсолютные (jail — на уровне apply).
4. Пустая `line_text` допустима (пустая строка кода): `'+'` + сразу NL = добавить пустую строку.

## 1.3 Ленивый пре-процессор (lenient) — Req 3.6

Модель часто оборачивает патч в мусор. Пре-процессор `sanitizePatch(raw: string): string` применяет правила **по порядку**, каждое идемпотентно:

1. **Strip markdown fences.** Удалить обрамляющие ` ```patch `/` ``` `/` ```diff `/` ```` ``` ```` (в начале и конце, с учётом языкового тега). Regex: `^\s*```[\w-]*\n` и `\n```\s*$`.
2. **Strip heredoc wrappers.** Если весь блок обёрнут в `cat <<'EOF' ... EOF`, `<<"PATCH" ... PATCH`, `apply_patch <<'EOF' ... EOF` — вырезать заголовок heredoc (`^\S+\s+<<-?['"]?(\w+)['"]?\s*$`) и завершающий делимитер (строка ровно `\1`).
3. **Strip leading shell prompt.** Убрать префиксы `$ `, `PS>`, `> ` в начале строк-директив.
4. **Normalize line endings для парсинга.** Внутренне работаем с `\n`; исходные EOL файла берутся из целевого файла на этапе apply, НЕ из патча (патч задаёт только контент строк).
5. **Trim trailing junk.** После `*** End Patch` — обрезать всё. Если конверта нет — обрезать хвостовые пустые строки и строки, не начинающиеся с валидного маркера (` `, `-`, `+`, `@`, `*`), если они идут после последнего валидного хунка.
6. **Envelope tolerance.** Отсутствие `*** Begin/End Patch` допустимо: если первая непустая строка — `*** <Action> File:`, парсим без конверта.
7. **BOM/zero-width в директивах.** Снять `U+FEFF`, `U+200B` из начала строк-директив перед матчингом префикса `*** `.
8. **CRLF в самом патче.** Разбивать по `/\r?\n/`; хранить строки без EOL.

Псевдокод:
```ts
export function sanitizePatch(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "");
  // 1. fences
  s = s.replace(/^\s*```[\w-]*\r?\n/, "").replace(/\r?\n```[ \t]*$/s, "");
  // 2. heredoc
  const hd = s.match(/^[^\n]*<<-?['"]?(\w+)['"]?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/);
  if (hd) s = hd[2];
  // 3. prompts on directive lines
  s = s.replace(/^(?:\$ |PS[^>]*> |> )(\*\*\* )/gm, "$1");
  // 5. cut after End Patch
  const end = s.indexOf("*** End Patch");
  if (end >= 0) s = s.slice(0, end + "*** End Patch".length);
  // 7. zero-width in directive prefix
  s = s.replace(/^[\uFEFF\u200B]+(\*\*\* )/gm, "$1");
  return s;
}
```

## 1.4 Парсер → `PatchHunk[]`

```ts
interface FilePatch {
  op: "update" | "add" | "delete" | "move";
  file: string;          // нормализованный rel-путь (источник)
  dest?: string;         // для move
  hunks: PatchHunk[];    // для update/move
  addBody?: string[];    // для add (строки без маркеров)
}
interface PatchHunk { anchor?: string; context: string[]; remove: string[]; add: string[]; ops: HunkLine[]; }
type HunkLine = { kind: " " | "-" | "+"; text: string };
```

Алгоритм:
```ts
export function parsePatch(raw: string): FilePatch[] {
  const src = sanitizePatch(raw);
  const lines = src.split(/\r?\n/);
  const out: FilePatch[] = [];
  let i = 0;
  const isDirective = (l: string) => /^\*\*\* (Begin|End) Patch$|^\*\*\* (Update|Add|Delete|Move) File: /.test(l);

  while (i < lines.length) {
    const l = lines[i];
    if (l === "*** Begin Patch" || l === "*** End Patch" || l.trim() === "") { i++; continue; }

    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\*\*\* Add File: (.+)$/))) {
      const body: string[] = []; i++;
      while (i < lines.length && !isDirective(lines[i])) {
        const b = lines[i];
        if (b.startsWith("+")) body.push(b.slice(1));
        else if (b.trim() === "") body.push("");     // терпим пустые
        else break;
        i++;
      }
      out.push({ op: "add", file: normPath(m[1]), hunks: [], addBody: body });
    } else if ((m = l.match(/^\*\*\* Delete File: (.+)$/))) {
      out.push({ op: "delete", file: normPath(m[1]), hunks: [] }); i++;
    } else if ((m = l.match(/^\*\*\* Move File: (.+?) -> (.+)$/))) {
      i++; const hunks = parseHunks(lines, () => (i = /*advance*/ i), );
      // (в реализации parseHunks возвращает [hunks, nextIndex])
      out.push({ op: "move", file: normPath(m[1]), dest: normPath(m[2]), hunks });
    } else if ((m = l.match(/^\*\*\* Update File: (.+)$/))) {
      i++; const [hunks, next] = parseHunks(lines, i); i = next;
      out.push({ op: "update", file: normPath(m[1]), hunks });
    } else { i++; /* мусор между секциями — пропускаем (lenient) */ }
  }
  return out;
}

function parseHunks(lines: string[], start: number): [PatchHunk[], number] {
  const hunks: PatchHunk[] = []; let i = start; let cur: PatchHunk | null = null;
  const flush = () => { if (cur && cur.ops.length) hunks.push(cur); cur = null; };
  const stop = (l: string) => /^\*\*\* /.test(l);
  while (i < lines.length && !stop(lines[i])) {
    const l = lines[i];
    if (l.startsWith("@@")) { flush(); cur = mkHunk(l.slice(2).trim() || undefined); i++; continue; }
    if (!cur) cur = mkHunk();
    const k = l[0];
    if (k === " " || k === "-" || k === "+") {
      const text = l.slice(1);
      cur.ops.push({ kind: k as any, text });
      if (k !== "+") cur.context.push(text), (k === "-" && cur.remove.push(text));
      if (k === "+") cur.add.push(text);
      if (k === " ") { /* уже в context */ }
      i++;
    } else if (l.trim() === "") { cur.ops.push({ kind: " ", text: "" }); i++; } // пустая = контекст
    else break; // неизвестный маркер → конец хунка
  }
  flush();
  return [hunks, i];
}
```
`normPath(p)` = `p.replace(/\\/g,"/").replace(/^\.\//,"").trim()`.

Ошибки парсера — actionable: `"Патч без file-директив: ожидалась строка '*** Update File: <путь>'"`.

---

# 2. Толерантный матчер (seek.ts) — Req 3.2, 3.10

## 2.1 Контракт

```ts
export interface SeekResult {
  found: boolean;
  index: number;        // индекс строки в haystack, где начинается совпадение (0-based)
  level: 0 | 1 | 2 | 3; // уровень строгости, на котором совпало
  matches: number[];    // все стартовые индексы (для детекта >1)
}

/** Ищет needle (последовательность строк) в haystack (массив строк файла). */
export function seekSequence(haystack: string[], needle: string[], fromLevel = 0): SeekResult;
```

**Правило нормализации (незыблемое, Req 3.8/3.10):** *normalize for compare, keep original bytes for write.* Матчинг сравнивает **нормализованные** строки, но apply вырезает/вставляет по **индексам** в исходном `haystack` (оригинальные байты). Нормализованные строки нигде не пишутся на диск.

## 2.2 Четыре уровня (по убыванию строгости)

Каждый уровень определяется функцией `normLine(level, s)`:

- **Level 0 — Exact.** `norm0(s) = s`. Побайтовое равенство строк (после единого разбиения по `\n`; CR уже отделён).
- **Level 1 — Trim trailing.** `norm1(s) = s.replace(/[ \t\f\v]+$/,"")`. Игнор хвостовых пробелов/табов (частый источник расхождений).
- **Level 2 — Trim leading+trailing + collapse inner ws.** `norm2(s) = s.trim().replace(/[ \t]+/g," ")`. Игнор отступов и схлопывание внутренних пробелов (модель переформатировала индентацию).
- **Level 3 — Unicode-normalize.** `norm3(s) = normalizeUnicode(norm2(s))` — плюс нормализация пунктуации/пробелов/формы (см. 2.3).

Матчинг идёт снизу вверх по строгости: сначала Level 0 по всему файлу; если 0 совпадений — Level 1; и т.д. Найденный уровень фиксируется в `SeekResult.level`. Чем выше `level`, тем «мягче» совпадение — это метаданные для UI/аудита.

## 2.3 Точный набор Unicode-нормализации (Level 3) — Req 3.10

Заменяем **конкретные кодпоинты** (список фиксирован):

| Категория | Кодпоинты (from) | → (to) |
|---|---|---|
| Dashes | en dash `U+2013`, em dash `U+2014`, minus sign `U+2212`, figure dash `U+2012`, horizontal bar `U+2015` | ASCII hyphen-minus `U+002D` `-` |
| Single quotes | `U+2018` ‘, `U+2019` ’, `U+201A` ‚, `U+201B` ‛, prime `U+2032` ′ | ASCII apostrophe `U+0027` `'` |
| Double quotes | `U+201C` “, `U+201D` ”, `U+201E` „, `U+201F` ‟, double prime `U+2033` ″ | ASCII quote `U+0022` `"` |
| No-break / special spaces | nbsp `U+00A0`, narrow nbsp `U+202F`, `U+2007`, `U+2009`, `U+2002`, `U+2003`, ideographic space `U+3000` | ASCII space `U+0020` |
| Zero-width | ZWSP `U+200B`, ZWNJ `U+200C`, ZWJ `U+200D`, BOM/ZWNBSP `U+FEFF`, word joiner `U+2060` | `""` (удалить) |
| Line/para separators | `U+2028`, `U+2029` | `\n` (но строки уже разбиты — эффективно удаляются внутри строки) |
| Ellipsis | `U+2026` … | `...` |
| Форма | — | применить **NFC** ко всей строке (`s.normalize("NFC")`) |

```ts
const MAP: Record<string,string> = {
  "\u2013":"-","\u2014":"-","\u2212":"-","\u2012":"-","\u2015":"-",
  "\u2018":"'","\u2019":"'","\u201A":"'","\u201B":"'","\u2032":"'",
  "\u201C":'"',"\u201D":'"',"\u201E":'"',"\u201F":'"',"\u2033":'"',
  "\u00A0":" ","\u202F":" ","\u2007":" ","\u2009":" ","\u2002":" ","\u2003":" ","\u3000":" ",
  "\u200B":"","\u200C":"","\u200D":"","\uFEFF":"","\u2060":"",
  "\u2028":"","\u2029":"","\u2026":"...",
};
export function normalizeUnicode(s: string): string {
  const replaced = s.replace(/[\u2013\u2014\u2212\u2012\u2015\u2018\u2019\u201A\u201B\u2032\u201C\u201D\u201E\u201F\u2033\u00A0\u202F\u2007\u2009\u2002\u2003\u3000\u200B\u200C\u200D\uFEFF\u2060\u2028\u2029\u2026]/g, c => MAP[c] ?? c);
  return replaced.normalize("NFC");
}
```
Порядок: сначала `norm2` (trim + collapse), затем замена кодпоинтов, затем `NFC`. NFC после замен, чтобы схлопнуть комбинирующиеся диакритики к каноничной форме.

## 2.4 Алгоритм поиска (per level)

Скользящее окно длиной `needle.length` по `haystack`; на каждом уровне предварительно нормализуем обе стороны один раз (кэш нормализованных строк на уровень).

```ts
export function seekSequence(haystack: string[], needle: string[], fromLevel = 0): SeekResult {
  if (needle.length === 0) return { found:false, index:-1, level:0, matches:[] };
  for (let level = fromLevel as number; level <= 3; level++) {
    const nf = (s: string) => normLine(level as 0|1|2|3, s);
    const H = haystack.map(nf);
    const N = needle.map(nf);
    const matches: number[] = [];
    for (let i = 0; i + N.length <= H.length; i++) {
      let ok = true;
      for (let j = 0; j < N.length; j++) if (H[i+j] !== N[j]) { ok = false; break; }
      if (ok) matches.push(i);
    }
    if (matches.length >= 1)
      return { found: matches.length === 1, index: matches[0], level: level as any, matches };
  }
  return { found:false, index:-1, level:3, matches:[] };
}
```
Ключевой нюанс: **как только на каком-то уровне нашлось ≥1 совпадение — останавливаемся на этом уровне** (не «повышаем мягкость» дальше). Если на этом уровне совпадений >1 → это ошибка неоднозначности (см. 2.5), а не повод идти на уровень выше.

Матчинг **needle** для хунка = `context`-строки (` ` и `-`, т.е. всё, что должно быть в старом файле), в порядке следования в хунке. `+`-строки в needle не входят.

## 2.5 Детект >1 совпадения и actionable-текст — Req 3.3, 3.12

- `matches.length === 0` → ошибка **NOT_FOUND**.
- `matches.length > 1` → ошибка **AMBIGUOUS** (даже если сработала `@@`-подсказка; подсказка лишь фильтрует зону поиска, см. ниже).
- `matches.length === 1` → OK.

Использование `@@ hint`: если хунк имеет `anchor`, сначала ищем строку якоря (`seekSequence(haystack, [anchor])`); если якорь найден в 1 месте — ограничиваем поиск needle окном от индекса якоря до следующего якоря/EOF. Это снижает неоднозначность без «молчаливого» применения.

Текст ошибок (для модели — Req 3.12, actionable):
```ts
function ambiguousError(hunk: PatchHunk, res: SeekResult, haystack: string[]): string {
  const preview = hunk.context.slice(0, 3).join("\n");
  const locs = res.matches.map(i => i + 1).join(", ");
  return [
    `Якорь совпал в ${res.matches.length} местах (строки: ${locs}) — правка отклонена во избежание ошибочного применения.`,
    `Искомый контекст:`,
    "```", preview, "```",
    `Добавьте больше окружающих строк контекста (' ') или '@@'-подсказку с уникальным заголовком (имя функции/класса), чтобы однозначно указать место.`,
  ].join("\n");
}

function notFoundError(hunk: PatchHunk): string {
  const preview = hunk.context.slice(0, 5).join("\n");
  return [
    `Контекст правки не найден в файле (0 совпадений). Файл не изменён.`,
    `Искомый контекст:`,
    "```", preview, "```",
    `Проверьте актуальное содержимое файла (read_file) и обновите строки контекста — возможно, файл уже изменился.`,
  ].join("\n");
}
```

---

# 3. Применение хунков (apply.ts) — Req 3.8, 3.9, 3.11, 3.13, 3.15

## 3.1 Метаданные файла (детект и сохранение)

Перед правкой читаем файл как **байты** (`Buffer`), детектируем стиль и сохраняем для восстановления при записи.

```ts
interface FileMeta {
  bom: "utf8" | "utf16le" | "utf16be" | null; // какой BOM был
  eol: "lf" | "crlf" | "mixed";
  eolDominant: "\n" | "\r\n";                  // чем писать новые строки
  finalNewline: boolean;                        // был ли завершающий перевод строки
  encoding: "utf8" | "binary";
}

const BOM_UTF8 = Buffer.from([0xEF,0xBB,0xBF]);
const BOM_UTF16LE = Buffer.from([0xFF,0xFE]);
const BOM_UTF16BE = Buffer.from([0xFE,0xFF]);

function detectMeta(buf: Buffer): FileMeta {
  let bom: FileMeta["bom"] = null; let body = buf;
  if (buf.subarray(0,3).equals(BOM_UTF8)) { bom="utf8"; body=buf.subarray(3); }
  else if (buf.subarray(0,2).equals(BOM_UTF16LE)) { bom="utf16le"; body=buf.subarray(2); }
  else if (buf.subarray(0,2).equals(BOM_UTF16BE)) { bom="utf16be"; body=buf.subarray(2); }

  if (isBinary(body)) return { bom, eol:"lf", eolDominant:"\n", finalNewline:false, encoding:"binary" };

  const text = body.toString("utf8");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  const eol: FileMeta["eol"] = crlf>0 && lfOnly>0 ? "mixed" : crlf>0 ? "crlf" : "lf";
  const eolDominant = crlf >= lfOnly ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(text);
  return { bom, eol, eolDominant, finalNewline, encoding:"utf8" };
}
```

## 3.2 Детект бинарного/не-UTF-8 файла — Req 3.13

Эвристика (порядок):
1. **NUL-byte:** если в первых 8192 байтах тела встречается `0x00` → бинарный.
2. **UTF-8 validity:** декодировать через `new TextDecoder("utf-8", { fatal: true })`; исключение → не-UTF-8 → отказ.
3. **Control-ratio:** доля управляющих байт (`< 0x09`, кроме `\t\n\r\f`) > 30% в выборке → бинарный.

```ts
function isBinary(body: Buffer): boolean {
  const n = Math.min(body.length, 8192);
  if (n === 0) return false;
  let ctrl = 0;
  for (let i=0;i<n;i++){ const b=body[i];
    if (b===0) return true;
    if (b<0x09 || (b>0x0D && b<0x20)) ctrl++;
  }
  try { new TextDecoder("utf-8",{fatal:true}).decode(body.subarray(0,n)); }
  catch { return true; }
  return ctrl / n > 0.30;
}
```
Отказ: `"Файл бинарный или не в UTF-8 — текстовая правка отклонена, содержимое не тронуто (Req 3.13)."`

## 3.3 Применение одного хунка к массиву строк

```ts
interface ApplyHunkResult { ok: true; lines: string[] } | { ok:false; error:string; code:"NOT_FOUND"|"AMBIGUOUS"|"NOOP" }

function applyHunk(lines: string[], hunk: PatchHunk): ApplyHunkResult {
  const needle = hunk.ops.filter(o => o.kind !== "+").map(o => o.text); // context+remove
  if (needle.length === 0) {
    // чистая вставка: должен быть anchor или контекст. Без него — reject как небезопасную.
    return { ok:false, code:"NOT_FOUND", error:"Хунк без контекста для локализации вставки." };
  }
  // при наличии anchor — сузить зону
  const res = seekWithAnchor(lines, hunk);
  if (res.matches.length === 0) return { ok:false, code:"NOT_FOUND", error:notFoundError(hunk) };
  if (res.matches.length > 1)  return { ok:false, code:"AMBIGUOUS", error:ambiguousError(hunk,res,lines) };

  const start = res.index;
  // Построить новый фрагмент, проходя ops: ' ' и '+' попадают в вывод, '-' пропускаются.
  const out: string[] = [];
  let cursor = start;
  for (const op of hunk.ops) {
    if (op.kind === " ") { out.push(lines[cursor]); cursor++; }        // ОРИГИНАЛЬНЫЕ байты
    else if (op.kind === "-") { cursor++; }                            // пропустить (удалить)
    else if (op.kind === "+") { out.push(op.text); }                  // новая строка из патча
  }
  const consumed = cursor - start; // сколько исходных строк заменяем
  const next = [...lines.slice(0,start), ...out, ...lines.slice(start+consumed)];
  if (arraysEqual(next, lines)) return { ok:false, code:"NOOP", error:"Правка не меняет файл (no-op)." };
  return { ok:true, lines: next };
}
```
**Критично (Req 3.8):** для ` `-строк в вывод кладём `lines[cursor]` — исходные байты файла, НЕ нормализованный `op.text`. Так сохраняется индентация/пунктуация, даже если матч был на Level 2/3.

## 3.4 Сборка байтов при записи (EOL/BOM/EOF) — Req 3.8, 3.9

```ts
function serialize(lines: string[], meta: FileMeta): Buffer {
  const eol = meta.eolDominant;
  let text = lines.join(eol);
  if (meta.finalNewline) text += eol;              // сохранить/не добавлять финальный перевод
  let body = Buffer.from(text, "utf8");
  if (meta.bom === "utf8") body = Buffer.concat([BOM_UTF8, body]);
  // utf16 BOM-файлы: конвертация вне scope текстовой правки (детект→utf8-only), см. отказ
  return body;
}
```
Для `mixed` EOL пишем `eolDominant` (доминирующий), фиксируя это в метаданных результата (UI-нотис «нормализованы смешанные EOL к CRLF»). Изменённые строки получают доминирующий EOL; неизменённые контекст-строки — тоже (join единым EOL). Это осознанный компромисс: сохранить mixed побайтово при line-level правке невозможно без пер-строчного хранения EOL. **Опция строгого режима:** хранить `perLineEol: string[]` и реконструировать — включается флагом `preserveMixedEol`, по умолчанию off.

## 3.5 Add / Delete / Move семантика

- **add:** файл не должен существовать (иначе reject `"Файл уже существует: <p> — используйте Update"`). Тело = `addBody.join("\n")`; meta по умолчанию: `eol` = платформенный дефолт для нового файла (**на Windows `\r\n`**, конфигурируемо `newFileEol`), `finalNewline=true`, `bom=null`.
- **delete:** файл должен существовать; в стейджинге помечается на удаление (реальное `unlink` — в фазе commit).
- **move:** прочитать источник, применить хунки (если есть) к его содержимому, записать в `dest`, удалить источник. `dest` не должен существовать. Оба пути — через jail.

## 3.6 Транзакционная мультифайловая правка — Req 3.11, 3.15

Модель: **stage all → snapshot → write all → rollback on any failure**. Ни один файл не пишется на диск, пока все хунки всех файлов не применены в памяти успешно.

```ts
interface StagedFile { path:string; op:FilePatch["op"]; nextBytes?:Buffer; meta?:FileMeta; dest?:string; }

export async function applyPatch(ws: string, patches: FilePatch[], snap: SnapshotStore): Promise<ApplyReport> {
  // ---- ФАЗА 1: stage (in-memory), без записи ----
  const staged: StagedFile[] = [];
  for (const p of patches) {
    const abs = safePath(ws, p.file);
    if (p.op === "delete") { await assertExists(abs); staged.push({ path:abs, op:"delete" }); continue; }
    if (p.op === "add") {
      await assertNotExists(abs);
      const meta = defaultNewMeta();
      staged.push({ path:abs, op:"add", meta, nextBytes: serialize(p.addBody ?? [], meta) });
      continue;
    }
    // update / move
    const srcAbs = abs;
    const buf = await fs.readFile(srcAbs);
    const meta = detectMeta(buf);
    if (meta.encoding === "binary") throw new ApplyError("BINARY", srcAbs);
    const lines = decodeToLines(buf, meta);
    let cur = lines;
    for (const h of p.hunks) {
      const r = applyHunk(cur, h);
      if (!r.ok) throw new ApplyError(r.code, srcAbs, r.error); // прерываем ВСЮ транзакцию
      cur = r.lines;
    }
    const destAbs = p.op === "move" ? safePath(ws, p.dest!) : srcAbs;
    if (p.op === "move") await assertNotExists(destAbs);
    staged.push({ path:destAbs, op:p.op, meta, nextBytes: serialize(cur, meta), dest: p.op==="move"?srcAbs:undefined });
  }

  // ---- ФАЗА 2: snapshot (обратимость перед любой записью) ----
  const affected = patches.flatMap(p => p.op==="move" ? [p.file,p.dest!] : [p.file]);
  const snapshotId = await snap.create(affected);

  // ---- ФАЗА 3: write all (атомарно per-file) + журнал сделанного для rollback ----
  const done: Array<() => Promise<void>> = [];
  try {
    for (const s of staged) {
      if (s.op === "delete") { const bak = await backupTmp(s.path); await fs.rm(s.path); done.push(async()=>fs.rename(bak,s.path)); }
      else if (s.op === "move") { await atomicWrite(s.path, s.nextBytes!); await fs.rm(s.dest!); done.push(async()=>{ await fs.rm(s.path).catch(()=>{}); }); }
      else { const existed = await exists(s.path); const prev = existed ? await fs.readFile(s.path) : null;
             await atomicWrite(s.path, s.nextBytes!);
             done.push(async()=> prev ? atomicWrite(s.path, prev) : fs.rm(s.path).catch(()=>{})); }
    }
  } catch (err) {
    for (const undo of done.reverse()) await undo().catch(()=>{}); // best-effort inline rollback
    await snap.restore(snapshotId);                                 // авторитетный откат по снапшоту
    throw err;
  }
  return { snapshotId, files: staged.map(s=>({ path: rel(ws,s.path), op:s.op })) };
}
```
Любой сбой в ФАЗЕ 1 (NOT_FOUND/AMBIGUOUS/NOOP/BINARY) → **исключение до записи** → на диске ничего не изменилось (Property 10, 11). Сбой в ФАЗЕ 3 → inline-undo + `snap.restore` (двойная защита).

## 3.7 Атомарная запись (temp + rename, тот же том) — Req 3.15 + Windows

Rename на Windows атомарен только в пределах одного тома. Temp-файл создаём **в той же директории**, что и целевой (значит — тот же том, даже на `F:\`).

```ts
async function atomicWrite(target: string, data: Buffer): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.kyrei-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fh = await fs.open(tmp, "wx");            // wx: fail если существует
  try {
    await fh.writeFile(data);
    await fh.sync();                               // fsync — durability до rename
  } finally { await fh.close(); }
  await renameWithRetry(tmp, target);              // см. §7 EBUSY-retry
}
```
`fs.rename` на Windows перезаписывает существующий целевой файл (ОК). При `EPERM`/`EBUSY` (антивирус/индексатор держит хэндл) — retry с backoff (§7.4). Temp-файлы `.kyrei-tmp-*` попадают в `.gitignore`.

---

# 4. Снапшоты (snapshot.ts) — Req 3.7, Property 3

## 4.1 Решение git-vs-copy

```
существует ли `.git` в workspace И `git` в PATH И файл трекается git?
  ДА  → git-снапшот (blob через `git hash-object -w`, дёшево, дедуп)
  НЕТ → copy-снапшот (полная копия затронутых файлов в .kyrei/snapshots/)
```
Детект один раз на старте сессии, кэшируем. Даже в git-репо для untracked/ignored файлов используем copy-путь (git их не хранит).

## 4.2 Интерфейс

```ts
interface SnapshotStore {
  create(relPaths: string[]): Promise<string>;   // → snapshotId
  restore(id: string): Promise<void>;
  list(): Promise<SnapshotInfo[]>;
  gc(): Promise<{ removed: number }>;
}
interface SnapshotInfo { id:string; ts:number; files:string[]; kind:"git"|"copy"; }
```

## 4.3 Copy-путь (non-git и untracked)

Хранилище: `<workspace>/.kyrei/snapshots/<id>/`, где `id = <ISO-timestamp>-<rand>`. Внутри — копии файлов с сохранением относительной структуры + `manifest.json`:
```jsonc
{ "id":"20260712T101500-a3f9", "ts":1765531200000, "kind":"copy",
  "files":[{"rel":"src/app.ts","existed":true,"bytes":1234,"sha256":"…"},
           {"rel":"src/env.ts","existed":false}] }  // existed:false → при restore файл удаляется
```
`create`: для каждого пути — если существовал, копируем байты (через `atomicWrite` в snapshot-dir); если нет — пишем `existed:false` (restore удалит созданный).
`restore`: читаем manifest; для `existed:true` — `atomicWrite(target, snapshotBytes)`; для `existed:false` — `fs.rm(target)`. Возвращает файлы к байтам на момент снапшота.

## 4.4 Git-путь

`create`: `git hash-object -w <file>` для каждого трекуемого пути → сохраняем `{rel, blobSha, existed}` в manifest (blob лежит в git object store, дедуп бесплатно). Для нового файла `existed:false`.
`restore`: `git cat-file -p <blobSha>` → `atomicWrite`; `existed:false` → `fs.rm`. Не трогаем git index/HEAD (снапшот не делает коммит).

## 4.5 Retention / GC

Политика (конфиг `snapshot: { maxCount:50, maxAgeDays:7, maxTotalMB:200 }`):
- Хранить последние `maxCount` снапшотов И не старше `maxAgeDays`.
- Если суммарный размер copy-снапшотов > `maxTotalMB` — удалять старейшие, пока не влезет.
- `gc()` запускается: после каждого успешного `create` (дёшево, проверка счётчика) + при старте сессии.
- git-blobs не удаляем вручную (отдадутся штатному `git gc`); удаляем только manifest-записи.
- `.kyrei/snapshots/` — в `.gitignore`.

---

# 5. Diff (diff.ts) — Req 3.4

Переносим `lineDiff` из v1 (LCS, `Int32Array` DP) без изменений логики; добавляем счётчик и режимы рендера.

```ts
export interface DiffResult { text: string; added: number; removed: number; }

export function computeDiff(oldStr: string, newStr: string, maxLines = 2000): DiffResult {
  const a = oldStr.split("\n"), b = newStr.split("\n");
  if (a.length > maxLines || b.length > maxLines)
    return { text:"", added:0, removed:0 }; // слишком большой — UI покажет «diff скрыт»
  // ... LCS DP как в v1 ...
  let added=0, removed=0; const out:string[]=[];
  // при построении: '+' → added++, '-' → removed++
  return { text: out.join("\n"), added, removed };
}

export function renderCounter(d: DiffResult): string { return `+${d.added} −${d.removed}`; }
```

Рендер для трёх случаев (для `tool.complete.inline_diff` + UI):
- **new file:** каждая строка с префиксом `+`, счётчик `+N −0`, заголовок `A  <path>`.
- **modified:** контекст/`-`/`+`; заголовок `M  <path>  (+N −M)`.
- **deleted:** каждая строка с `-`, `+0 −N`, заголовок `D  <path>`.

```ts
export function renderFileDiff(kind:"add"|"modify"|"delete", rel:string, oldStr:string, newStr:string): {header:string; body:string; counter:string} {
  const d = kind==="add"  ? computeDiff("", newStr)
          : kind==="delete"? computeDiff(oldStr, "")
          : computeDiff(oldStr, newStr);
  const tag = kind==="add"?"A":kind==="delete"?"D":"M";
  return { header:`${tag}  ${rel}`, body:d.text, counter:renderCounter(d) };
}
```

---

# 6. Инструменты (tools/*) — Req 4

Единый контракт (Req 4.3). Zod-схемы (Req 4.2). Ошибки → `tool-error`, не throw в цикл (Req 4.6).

```ts
export interface ToolResult { title: string; output: string; metadata?: Record<string, unknown>; }
// title — короткая строка для UI; output — текст для модели; metadata — структурные данные/превью.
```

Усечение head+tail (Req 4.4, 4.8) — codepoint-safe (не рвать суррогатные пары):
```ts
function truncateHeadTail(s: string, limit = 12000): {text:string; truncated:boolean; orig:number} {
  const cp = Array.from(s);              // Array.from режет по кодпоинтам, не по UTF-16 units
  if (cp.length <= limit) return { text:s, truncated:false, orig:cp.length };
  const head = cp.slice(0, Math.floor(limit*0.6)).join("");
  const tail = cp.slice(cp.length - Math.floor(limit*0.4)).join("");
  const marker = `\n… [вывод обрезан: ${cp.length}→${limit} символов, показаны начало и конец] …\n`;
  return { text: head + marker + tail, truncated:true, orig: cp.length };
}
```

## 6.1 `read_file` — диапазоны строк + safe truncation

```ts
inputSchema: z.object({
  path: z.string(),
  start_line: z.number().int().min(1).optional(),  // 1-based, включительно
  end_line: z.number().int().min(1).optional(),    // включительно
})
```
Логика:
1. `safePath` + `detectMeta`; бинарный → `ToolResult` с `output:"[бинарный файл, чтение как текст отклонено]"`, `metadata.binary=true` (не throw).
2. Разбить на строки, применить диапазон (`start_line..end_line`); дефолт — весь файл.
3. Если результат > лимита символов → `truncateHeadTail` **по строкам** (резать на границе строк, затем при необходимости внутри — по кодпоинтам), маркер `[вывод обрезан: X→Y]`.
4. Нумеровать строки в `output` (`  12│ code`) для последующих правок.

```ts
{ title: `read ${rel} (${from}-${to} из ${total})`,
  output: numbered.join("\n") + (truncated ? marker : ""),
  metadata: { total, from, to, eol: meta.eol, bom: !!meta.bom, truncated } }
```

## 6.2 `edit_file` / `write_file` — правило границы (Req 3.5, 3.16)

Порог `WRITE_THRESHOLD = 400` строк (конфиг `editThresholdLines`).
- `write_file` (полная перезапись) — разрешён когда: **файл новый** ИЛИ текущий размер ≤ порога.
- `edit_file` (патч через apply-движок) — иначе (файл существует и > порога).
- Нарушение → `tool-error` с подсказкой: `"Файл N строк (> 400) — используйте edit_file (точечная правка), а не write_file"`. Это защита от случайного затирания больших файлов.

```ts
// edit_file
inputSchema: z.object({ patch: z.string().describe("codex-style *** Update/Add/Delete/Move File ...") })
execute: async ({ patch }, { abortSignal }) => {
  const parsed = parsePatch(patch);
  if (parsed.length === 0) return { title:"edit: пустой патч", output: notFoundHint };
  try {
    const report = await applyPatch(ws, parsed, snapshotStore);
    const diffs = report.files.map(f => renderFileDiff(mapKind(f.op), f.path, ...));
    return { title:`edit ${report.files.length} файл(ов)`,
             output: diffs.map(d=>`${d.header} (${d.counter})`).join("\n"),
             metadata: { snapshotId: report.snapshotId, inline_diff: diffs.map(d=>d.body).join("\n---\n") } };
  } catch (e) {
    return { title:"edit: отклонено", output: (e as ApplyError).message }; // actionable, не throw
  }
}

// write_file
inputSchema: z.object({ path: z.string(), content: z.string() })
execute: async ({ path: p, content }) => {
  const abs = safePath(ws, p);
  const existed = await exists(abs);
  if (existed) {
    const buf = await fs.readFile(abs); const meta = detectMeta(buf);
    if (meta.encoding==="binary") return { title:"write: отклонено", output:"Бинарный файл — правка отклонена" };
    const lineCount = buf.toString("utf8").split("\n").length;
    if (lineCount > WRITE_THRESHOLD) return { title:"write: отклонено", output:`Файл ${lineCount} строк (>${WRITE_THRESHOLD}) — используйте edit_file` };
    const snapId = await snapshotStore.create([p]);
    const nextMeta = meta;                                   // сохранить EOL/BOM исходника
    await atomicWrite(abs, serialize(content.split(/\r?\n/), nextMeta));
    const d = renderFileDiff("modify", p, buf.toString("utf8"), content);
    return { title:`write ${p} (${d.counter})`, output:`M  ${p} (${d.counter})`, metadata:{ snapshotId:snapId, inline_diff:d.body } };
  } else {
    const meta = defaultNewMeta();                            // Windows → CRLF, finalNewline:true
    await mkdirp(path.dirname(abs));
    await atomicWrite(abs, serialize(content.split(/\r?\n/), meta));
    const d = renderFileDiff("add", p, "", content);
    return { title:`create ${p} (${d.counter})`, output:`A  ${p} (${d.counter})`, metadata:{ inline_diff:d.body } };
  }
}
```

## 6.3 `grep_search` — @vscode/ripgrep + fallback (Req 4.11)

```ts
inputSchema: z.object({
  query: z.string(),
  path: z.string().optional(),          // относительно ws
  glob: z.string().optional(),          // фильтр включения
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().optional(),  // деф. 100
})
```
Разрешение бинаря `rg` (по порядку):
1. `require("@vscode/ripgrep").rgPath` — бандленный, работает офлайн, per-OS.
2. системный `rg` из PATH (детект `where rg` на Windows / `which rg`).
3. **JS-fallback** (если оба недоступны) — рекурсивный обход + `RegExp` построчно (медленно, только для деградации).

Запуск rg (JSON-вывод для надёжного парсинга):
```ts
const args = ["--json","--line-number","--column","-m", String(maxResults),
              caseSensitive ? "--case-sensitive" : "--smart-case"];
if (glob) args.push("--glob", glob);
args.push("--", query, path.join(ws, sub ?? "."));
const child = spawn(rgPath, args, { cwd: ws, windowsHide: true, signal: abortSignal });
```
Парсим stream JSON-строк (`type:"match"` → `{path, line_number, submatches}`). Результаты клипаем `truncateHeadTail`. `metadata: { matches:[{file,line,col,text}], engine:"rg-bundled|rg-system|js" }`.
`abortSignal` пробрасываем в `spawn` (Node ≥ 15 поддерживает `signal`).

## 6.4 `find_path` — glob (fast-glob)

```ts
inputSchema: z.object({ pattern: z.string(), cwd: z.string().optional(), limit: z.number().optional() })
execute: async ({ pattern, cwd, limit=200 }) => {
  const base = safePath(ws, cwd ?? ".");
  const entries = await fg(pattern, {
    cwd: base, dot: false, onlyFiles: false, absolute: false,
    followSymbolicLinks: false,                 // защита jail
    ignore: ["**/node_modules/**","**/.git/**",".kyrei/**"],
    suppressErrors: true,
  });
  // пост-фильтр: каждый результат прогнать через safePath (защита от симлинк-выхода)
  const safe = entries.filter(e => { try { safePath(ws, path.join(cwd??".",e)); return true; } catch { return false; } });
  const clipped = safe.slice(0, limit);
  return { title:`find ${pattern} → ${safe.length}`, output: clipped.join("\n") || "(нет совпадений)",
           metadata:{ total: safe.length, truncated: safe.length>limit } };
}
```
На Windows `fast-glob` требует forward-slash в паттерне; нормализуем `pattern.replace(/\\/g,"/")`. Результаты возвращаем с платформенными разделителями через `path.normalize` для отображения, но jail-проверку делаем на нормализованном.

## 6.5 `run_command` — bg-process manager (Req 4.7, 4.10)

Менеджер процессов с реестром по `id`, инкрементальным буфером, kill дерева, `abortSignal`, таймаутом.

```ts
interface ProcHandle { id:string; child:ChildProcess; buf:RingBuffer; status:"running"|"exited"|"killed"; code:number|null; startedAt:number; }
class ProcessManager {
  private procs = new Map<string, ProcHandle>();
  start(command: string, opts: { cwd:string; timeoutMs:number; abortSignal?:AbortSignal; env?:Record<string,string> }): string { /* см. ниже */ }
  read(id: string, sinceOffset = 0): { chunk:string; offset:number; status:string } { /* инкремент из RingBuffer */ }
  kill(id: string): Promise<void> { return killTree(this.procs.get(id)!.child); }
  wait(id: string, timeoutMs: number): Promise<{code:number|null; output:string; timedOut:boolean}> { /* … */ }
}
```
`start`:
```ts
const shell = process.platform === "win32"
  ? { cmd: "cmd.exe", pre: ["/d","/s","/c"] }        // см. §7.2 про pwsh-опцию
  : { cmd: "/bin/sh", pre: ["-c"] };
const child = spawn(shell.cmd, [...shell.pre, command], {
  cwd, windowsHide: true, signal: abortSignal,
  env: sanitizeEnv(opts.env),                         // минимизированный env (Req 8.9)
  detached: process.platform !== "win32",             // POSIX: своя process group для kill
});
const timer = setTimeout(() => killTree(child), opts.timeoutMs);
child.stdout.on("data", d => h.buf.push(d)); child.stderr.on("data", d => h.buf.push(d));
child.on("exit", (code) => { clearTimeout(timer); h.status = h.killed ? "killed" : "exited"; h.code = code; });
```
`abortSignal` → Node сам шлёт SIGTERM; дополнительно вешаем `abortSignal.addEventListener("abort", ()=>killTree(child))` для kill дерева (Node убивает только корневой процесс).

Два режима использования инструментом:
- **sync** (дефолт): `start` → `wait(id, timeoutMs)` → вернуть `{code, output(clipped)}`.
- **background**: `run_command({ command, background:true })` → сразу вернуть `{id}`; далее модель зовёт `run_command({ action:"read", id })` / `{action:"kill", id}`.

```ts
inputSchema: z.object({
  command: z.string().optional(),
  background: z.boolean().optional(),
  action: z.enum(["start","read","kill"]).optional(),
  id: z.string().optional(),
  since: z.number().optional(),
})
```
`output` таймаута: `"[превышен таймаут ${timeoutMs}ms — процесс и его дерево убиты]"`.

## 6.6 `batch` — параллельные read-only (Req 4.5)

Только для read-only инструментов (`list_dir`, `read_file`, `grep_search`, `find_path`). Writer-инструменты запрещены (single-writer). Partial-success shape:
```ts
inputSchema: z.object({ calls: z.array(z.object({ tool: z.string(), args: z.record(z.unknown()) })).max(16) })
execute: async ({ calls }, ctx) => {
  const READONLY = new Set(["list_dir","read_file","grep_search","find_path"]);
  const results = await Promise.allSettled(calls.map(c => {
    if (!READONLY.has(c.tool)) throw new Error(`batch: инструмент '${c.tool}' не read-only`);
    return TOOLS[c.tool].execute(c.args, ctx);
  }));
  const out = results.map((r,i) => r.status==="fulfilled"
    ? { tool:calls[i].tool, ok:true, output:r.value.output }
    : { tool:calls[i].tool, ok:false, error:String((r as PromiseRejectedResult).reason?.message ?? r.reason) });
  return { title:`batch ${calls.length} (${out.filter(o=>o.ok).length} ок)`,
           output: out.map(o=>`## ${o.tool} ${o.ok?"✓":"✗"}\n${o.ok?o.output:o.error}`).join("\n\n"),
           metadata:{ results: out } };  // частичный успех: одни ✓, другие ✗ в одном ответе
}
```

## 6.7 `diagnostics` — детект LSP/линтера (Req 4.1)

Без постоянного LSP-клиента (вне scope фазы) — детект по экосистеме + запуск существующих чекеров, парсинг в единый формат.

```ts
interface Diagnostic { file:string; line:number; col:number; severity:"error"|"warning"|"info"; message:string; source:string; }
```
Детект (по маркер-файлам в ws):
- `tsconfig.json` → `tsc --noEmit --pretty false` (парсинг `file(line,col): error TSxxxx: msg`).
- `.eslintrc*`/`eslint.config.*` → `eslint -f json .` (JSON → Diagnostic[]).
- `pyproject.toml`/`ruff.toml` → `ruff check --output-format json`.
- `Cargo.toml` → `cargo check --message-format=json`.
Если ни один не найден → `ToolResult{ output:"[линтер/LSP не обнаружен в проекте]" }`. Запуск через `ProcessManager` с таймаутом; `abortSignal` пробрасывается. `metadata.diagnostics: Diagnostic[]`, `output` — сгруппированный по файлам человекочитаемый список (clipped).

---

# 7. Windows-специфика — Req 4.10, 8.1, NFR

## 7.1 Обработка путей (jail на Windows) — Property 12

`safePath` должен отклонять специфичные Windows-векторы обхода. Резолвим симлинки через `fs.realpathSync.native` (учитывает junctions/reparse-точки).

```ts
import { realpathSync } from "node:fs";
import path from "node:path";

export function safePath(workspace: string, target: string): string {
  if (target == null) target = ".";
  // 1. drive-relative "C:rel" (без слэша после двоеточия) — запрет
  if (/^[a-zA-Z]:(?![\\/])/.test(target)) throw new JailError("drive-relative путь запрещён", target);
  // 2. UNC "\\server\share" и extended "\\?\", "\\.\", device — запрет
  if (/^\\\\/.test(target) || /^\/\//.test(target)) throw new JailError("UNC/device путь запрещён", target);
  // 3. resolve относительно workspace
  const abs = path.resolve(workspace, target);
  // 4. реальный путь workspace (canonical) — учитывает junctions и регистр
  const realWs = realpathSync.native(workspace);
  // 5. реальный путь цели, если существует; иначе — реальный путь ближайшего существующего предка
  const realAbs = resolveRealOrParent(abs);
  // 6. сравнение с учётом NTFS case-insensitivity
  const rel = path.relative(realWs, realAbs);
  if (rel === "" ) return realAbs;
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new JailError("путь вне рабочей папки", target);
  // 7. регистронезависимая доп-проверка (NTFS): нормализуем оба к нижнему регистру
  if (!realAbs.toLowerCase().startsWith(realWs.toLowerCase() + path.sep.toLowerCase()) && realAbs.toLowerCase() !== realWs.toLowerCase())
    throw new JailError("путь вне рабочей папки (case)", target);
  return realAbs;
}
```
`resolveRealOrParent(abs)`: если `abs` существует → `realpathSync.native(abs)`; иначе идти вверх до существующего предка, взять его realpath, дописать остаток. Это ловит `..`-обход И симлинк-выход даже для ещё-не-созданных файлов (нужно для `add`).

Векторы, которые отклоняет (Property 12): `..\..\outside`, `C:rel`, `\\server\share\x`, `\\?\C:\x`, junction, указывающий наружу, и любой путь, чей realpath не под `realWs`.

## 7.2 cmd vs pwsh

Дефолтный шелл для `run_command` на Windows — **`cmd.exe /d /s /c`** (быстрый старт, предсказуемый парсинг, `/d` — без autorun-скриптов, `/s` — корректная обработка кавычек). Конфиг `windowsShell: "cmd" | "powershell" | "pwsh"`:
- `powershell` → `powershell.exe -NoProfile -NonInteractive -Command <cmd>` (тяжелее, но нужен для PS-синтаксиса).
- `pwsh` → `pwsh -NoProfile -NonInteractive -Command <cmd>` (если установлен PowerShell 7+, детект `where pwsh`).
`-NoProfile` обязателен (не подтягивать пользовательский профиль → детерминизм + безопасность). Аргументы никогда не интерполируем в строку шелла вручную для внутренних вызовов (tsc/eslint/rg) — используем `spawn(bin, argsArray)` без `shell:true`, чтобы избежать инъекции. `shell:true`/`cmd /c` — только для пользовательского `command`, где это ожидаемо.

## 7.3 Kill дерева процессов — Req 4.10

Node `child.kill()` убивает только корень; дочерние (напр. `npm` → `node`) остаются. Дерево:
```ts
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((res) => {
    if (!child.pid) return res();
    if (process.platform === "win32") {
      // taskkill убивает всё дерево по PID
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide:true })
        .on("exit", () => res());
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } // negative pid = process group (нужен detached:true)
      catch { try { child.kill("SIGKILL"); } catch {} }
      res();
    }
  });
}
```
`/T` — дерево, `/F` — force. На POSIX `detached:true` при spawn создаёт process group, `kill(-pid)` убивает группу.

## 7.4 Файловые локи (EBUSY/EPERM retry) — Windows

Антивирус/Search Indexer/другой процесс временно держат хэндл → `rename`/`unlink`/`open` кидают `EBUSY`, `EPERM`, `EACCES`, `ENOTEMPTY`. Retry с экспоненциальным backoff:
```ts
async function retryOnBusy<T>(op: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let delay = 20;
  for (let i = 0; i < tries; i++) {
    try { return await op(); }
    catch (e:any) {
      const busy = ["EBUSY","EPERM","EACCES","ENOTEMPTY"].includes(e.code);
      if (!busy || i === tries-1) throw e;
      await sleep(delay + Math.random()*delay); delay = Math.min(delay*2, 500);
    }
  }
  throw new Error(`unreachable ${label}`);
}
const renameWithRetry = (from:string,to:string) => retryOnBusy(()=>fs.rename(from,to), `rename ${to}`);
```
Применяется к `rename`, `rm`, `open(wx)`. Если после ретраев всё ещё занят — actionable-ошибка: `"Файл занят другим процессом (EBUSY) — закройте программу, держащую <path>, и повторите"`. При этом транзакция откатывается по снапшоту (файл не в полу-записанном состоянии, т.к. писали через temp+rename).

## 7.5 Прочее Windows

- **`.gitattributes`** в `tests/fixtures/**` → `-text` (запрет autocrlf), иначе EOL-тесты apply/seek падают только на Windows (см. design.md «Cross-platform Packaging»).
- **Длинные пути** (>260): при работе с очень глубокими путями префиксовать `\\?\` для нативных вызовов — но такие пути НЕ принимаем от модели (jail их режет); формируем внутренне только для собственных temp/snapshot операций при `abs.length > 240`.
- **`@vscode/ripgrep`**: бинарь `rg.exe` лежит в `node_modules/@vscode/ripgrep/bin/rg.exe`; при упаковке Electron — `asarUnpack` этой папки, грузить по распакованному пути (`process.resourcesPath`).

---

# 8. Карта файлов и порядок реализации

```
core/engine/apply/
  parse-patch.ts   § 1     — sanitizePatch, parsePatch, normPath
  seek.ts          § 2     — normLine, normalizeUnicode, seekSequence, seekWithAnchor, *Error
  apply.ts         § 3     — detectMeta, isBinary, applyHunk, serialize, applyPatch, atomicWrite
  snapshot.ts      § 4     — SnapshotStore (git|copy), retention/gc, restore
  diff.ts          § 5     — computeDiff, renderCounter, renderFileDiff
core/engine/tools/
  index.ts                 — реестр TOOLS, единый ToolResult, truncateHeadTail
  read-file.ts     § 6.1
  edit-write.ts    § 6.2
  grep.ts          § 6.3   — rg-resolve + JSON parse + JS fallback
  find-path.ts     § 6.4   — fast-glob
  run-command.ts   § 6.5   — ProcessManager, killTree, sanitizeEnv
  batch.ts         § 6.6
  diagnostics.ts   § 6.7
core/engine/security/
  jail.ts          § 7.1   — safePath (Windows-aware), JailError
core/engine/win/
  proc.ts          § 7.3   — killTree
  fs-retry.ts      § 7.4   — retryOnBusy, renameWithRetry
```

Порядок (каждый шаг завершается unit-тестами, соответствие design.md Фаза 2):
1. `jail.ts` (+ Property 1/12 тесты) — фундамент безопасности всех инструментов.
2. `seek.ts` (+ 4-уровневые тесты, Unicode-набор) — чистая функция, легко тестировать.
3. `parse-patch.ts` (+ lenient-тесты: heredoc/fences/мусор).
4. `diff.ts` (перенос v1 + счётчик).
5. `apply.ts` (+ Property 2/9/10/11: уникальность, EOL/BOM, reject≠порча, транзакционность).
6. `snapshot.ts` (+ Property 3: обратимость; git и copy пути).
7. Инструменты 6.1→6.7 поверх готового apply/seek/jail.
8. Windows `proc.ts`/`fs-retry.ts` + Win-only тесты в CI (`os: windows-latest`).

## 8.1 Соответствие Correctness Properties (design.md)

| Property | Где обеспечивается |
|---|---|
| P1 Jail | `safePath` §7.1 + realpath |
| P2 Уникальность якоря | `seekSequence`/`applyHunk` §2.4, §3.3 (reject при matches≠1) |
| P3 Обратимость | `SnapshotStore.create` до записи §3.6/§4 |
| P9 EOL/BOM/EOF | `detectMeta`+`serialize`, original bytes для context §3.1/§3.4 |
| P10 Reject≠порча | стейджинг в памяти, throw до записи §3.6 |
| P11 Транзакционность | stage-all→snapshot→write-all→rollback §3.6 |
| P12 Windows-jail | `safePath` UNC/`\\?\`/junction/drive-rel/case §7.1 |

---

# 9. Открытые допущения (зафиксированы, не догадки)

1. **Mixed-EOL:** по умолчанию сводим к доминирующему при line-правке (строгий побайтовый mixed — опция `preserveMixedEol`, off). Обосновано в §3.4.
2. **UTF-16 BOM файлы:** детектируются, но текстовая правка отклоняется (движок работает в UTF-8); конвертация вне scope. §3.1.
3. **Новый файл на Windows:** EOL по умолчанию `\r\n` (конфиг `newFileEol: "crlf"`). Обосновано платформой.
4. **run_command сдерживание:** только CWD-jail + deny-list + approval; сеть/абсолютные пути не сдерживаются без OS-sandbox (design.md «Honest Limits»).
5. **diagnostics:** без persistent-LSP; запуск batch-чекеров экосистемы. Полноценный LSP-клиент — поздняя фаза.
