import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { memoizedRehypeKatex } from "@/lib/katex-memo";
import { CodeBlock } from "./CodeBlock";

function extractText(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in (children as any)) {
    return extractText((children as any).props?.children);
  }
  return "";
}

const components: Components = {
  code(props) {
    const { className, children } = props as { className?: string; children?: unknown };
    const match = /language-(\w+)/.exec(className || "");
    const text = extractText(children);
    // Block code: has a language class or spans multiple lines.
    if (match || text.includes("\n")) {
      return <CodeBlock code={text.replace(/\n$/, "")} lang={match?.[1]} />;
    }
    return (
      <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[0.86em] text-[#c3cdf5]">
        {children as any}
      </code>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <span title={href} className="text-primary underline decoration-primary/40 underline-offset-2">
        {children}
      </span>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border-soft">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border-b border-border-soft bg-white/5 px-3 py-1.5 text-left font-medium text-secondary">{children}</th>;
  },
  td({ children }) {
    return <td className="border-b border-border-soft/60 px-3 py-1.5 align-top">{children}</td>;
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-kyrei space-y-3 leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/50 [&_blockquote]:pl-3 [&_blockquote]:text-secondary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[memoizedRehypeKatex]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
