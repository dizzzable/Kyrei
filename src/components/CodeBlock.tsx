import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { getHighlighter, normalizeLang, shikiTheme } from "@/lib/highlighter";
import { useThemeId } from "@/lib/theme";
import { useI18n } from "@/i18n";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const theme = useThemeId();
  const { t } = useI18n();

  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then(hl => hl.codeToHtml(code, { lang: normalizeLang(lang), theme: shikiTheme(theme) }))
      .then(out => { if (alive) setHtml(out); })
      .catch(() => { if (alive) setHtml(""); });
    return () => { alive = false; };
  }, [code, lang, theme]);

  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const light = theme === "light";

  return (
    <div className={`my-3 overflow-hidden rounded-lg border border-border-soft ${light ? "bg-surface" : "bg-elevated"}`}>
      <div className="flex items-center justify-between border-b border-border-soft px-3 py-1.5 text-[11px] text-muted">
        <span className="font-mono">{lang || t("chat.code.language")}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-(--ui-row-hover) hover:text-foreground"
          aria-label={copied ? t("chat.code.copied") : t("chat.code.copy")}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t("chat.code.copied") : t("chat.code.copy")}
        </button>
      </div>
      <div className="overflow-x-auto p-3">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="m-0 font-mono text-[12.5px] leading-relaxed text-secondary">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
