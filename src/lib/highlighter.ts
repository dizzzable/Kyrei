import type { Highlighter } from "shiki";
import type { ThemeId } from "./theme";

// Curated language set — keeps the bundle to these grammars instead of the
// full Shiki registry (which the previous `codeToHtml` shorthand pulled in).
const LANGS = [
  "text", "typescript", "tsx", "javascript", "jsx", "json", "jsonc",
  "python", "rust", "go", "java", "c", "cpp", "csharp",
  "css", "scss", "html", "xml", "markdown", "yaml", "toml",
  "bash", "shellscript", "powershell", "sql", "diff",
  "vue", "svelte", "php", "ruby", "kotlin", "swift", "dockerfile", "ini",
];

const DARK = "github-dark-dimmed";
const LIGHT = "github-light-default";

let promise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!promise) {
    promise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: [DARK, LIGHT], langs: LANGS }),
    );
  }
  return promise;
}

export function shikiTheme(theme: ThemeId): string {
  return theme === "light" ? LIGHT : DARK;
}

const ALIAS: Record<string, string> = {
  shell: "shellscript", sh: "shellscript", zsh: "shellscript",
  ts: "typescript", js: "javascript", py: "python", rb: "ruby",
  yml: "yaml", md: "markdown", "c++": "cpp", "c#": "csharp", cs: "csharp",
  docker: "dockerfile",
};

export function normalizeLang(lang?: string): string {
  const l = (lang || "text").toLowerCase();
  const resolved = ALIAS[l] || l;
  return LANGS.includes(resolved) ? resolved : "text";
}
