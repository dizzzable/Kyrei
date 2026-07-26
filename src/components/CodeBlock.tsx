import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { getHighlighter, normalizeLang, shikiTheme } from "@/lib/highlighter";
import { HIGHLIGHT_SKIP, highlightDelayMs } from "@/lib/highlight-schedule";
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

  // What is currently painted, so an append can be coalesced instead of
  // re-tokenizing the whole block on every streamed token.
  const rendered = useRef<{ code: string; style: string; at: number } | null>(null);

  useEffect(() => {
    const style = `${normalizeLang(lang)}|${shikiTheme(theme)}`;
    const painted = rendered.current;
    const delay = highlightDelayMs({
      previous: painted?.code ?? null,
      next: code,
      styleChanged: painted !== null && painted.style !== style,
      ...(painted ? { sinceLastPaintMs: Date.now() - painted.at } : {}),
    });
    if (delay === HIGHLIGHT_SKIP) return undefined;

    let alive = true;
    const run = () => {
      getHighlighter()
        .then(hl => {
          // Gate BEFORE tokenizing: without this every superseded run still
          // did the full Shiki pass, so N queued prefixes all executed on the
          // main thread once the highlighter resolved — the O(L²) freeze this
          // module exists to remove.
          if (!alive) return null;
          return hl.codeToHtml(code, { lang: normalizeLang(lang), theme: shikiTheme(theme) });
        })
        .then(out => {
          if (!alive || out === null) return;
          rendered.current = { code, style, at: Date.now() };
          setHtml(out);
        })
        // Fall back to the plain <pre>, which always shows the FULL current
        // source. Keeping the last good render instead would leave a silently
        // truncated prefix on screen with no indication anything was wrong.
        .catch(() => {
          if (!alive) return;
          rendered.current = null;
          setHtml("");
        });
    };

    if (delay === 0) {
      run();
      return () => { alive = false; };
    }
    // Trailing edge: each new token cancels the pending run and re-arms, so the
    // block always settles on the latest source, never on a stale prefix.
    const timer = setTimeout(run, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
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
