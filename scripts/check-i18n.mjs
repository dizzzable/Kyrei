import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(process.cwd(), "src");
const checkedExtensions = new Set([".tsx"]);
const ignoredSegments = new Set(["i18n", "__fixtures__"]);
const textPattern = /[A-Za-z\u0400-\u04ff]/u;
const attributePattern = /\b(alt|aria-description|aria-label|description|hint|label|placeholder|title)\s*=\s*(["'])(.*?)\2/giu;
const jsxTextPattern = /(?<![=])>\s*([^<{]*[A-Za-z\u0400-\u04ff][^<{]*)\s*<(?=[A-Za-z/])/gu;
const dialogPattern = /\b(?:window\.)?(alert|confirm|prompt)\s*\(\s*(["'])(.*?)\2/giu;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredSegments.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (checkedExtensions.has(extname(entry.name)) && !entry.name.includes(".test.")) files.push(path);
  }
  return files;
}

function compact(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 120);
}

function isTechnicalData(value, kind) {
  const text = compact(value);
  if (["K", "Kyrei", "Kyrei Engine v2"].includes(text)) return true;
  if (/^(?:Ctrl|Cmd|Alt|Shift)(?:\s|\+)[A-Z0-9`]+$/i.test(text)) return true;
  if (kind === "placeholder") {
    if (/^https?:\/\//i.test(text) || /^[^\s@]+@[^\s@]+$/.test(text)) return true;
    if (["gbrain", "personal"].includes(text)) return true;
    if (/^[a-z0-9][a-z0-9_.-]*(?:\s*,\s*[a-z0-9][a-z0-9_.-]*)+$/i.test(text)) return true;
    if (/^[a-z]+-\d/i.test(text)) return true;
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(text)) return true;
  }
  return false;
}

function scanLine(line, lineNumber) {
  if (line.includes("i18n-data-ok")) return [];
  if (/^\s*(?:export\s+)?(?:interface|type)\b/.test(line)) return [];
  const violations = [];
  for (const match of line.matchAll(attributePattern)) {
    if (textPattern.test(match[3]) && !isTechnicalData(match[3], match[1])) {
      violations.push({ line: lineNumber, kind: `attribute ${match[1]}`, value: match[3] });
    }
  }
  for (const match of line.matchAll(jsxTextPattern)) {
    if (!isTechnicalData(match[1], "JSX text")) violations.push({ line: lineNumber, kind: "JSX text", value: match[1] });
  }
  for (const match of line.matchAll(dialogPattern)) {
    if (textPattern.test(match[3])) violations.push({ line: lineNumber, kind: `${match[1]} copy`, value: match[3] });
  }
  return violations;
}

const files = await collectFiles(root);
const violations = [];
for (const file of files) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const violation of scanLine(line, index + 1)) violations.push({ file, ...violation });
  });
}

if (violations.length > 0) {
  console.error("User-facing literals must come from the typed i18n catalog:\n");
  for (const item of violations) {
    console.error(`${relative(process.cwd(), item.file)}:${item.line} [${item.kind}] ${JSON.stringify(compact(item.value))}`);
  }
  console.error("\nTechnical display data may be annotated with // i18n-data-ok on the same line.");
  process.exitCode = 1;
} else {
  console.log(`i18n hardcode check passed (${files.length} TSX files).`);
}
