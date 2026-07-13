import { memo, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { messageText } from "@/lib/chat-messages";
import { IconButton } from "@/components/ui";
import { useUiSettings } from "@/store/settings";
import { Markdown } from "./Markdown";
import { ToolRow } from "./ToolRow";
import { ThinkingDisclosure } from "./chat/ThinkingDisclosure";
import { useI18n } from "@/i18n";

function CopyAction({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <IconButton
      tip={copied ? t("chat.message.copied") : t("chat.message.copy")}
      size="icon-xs"
      onClick={() => {
        navigator.clipboard.writeText(getText()).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

export const Message = memo(function Message({ message }: { message: ChatMessage }) {
  const { showReasoning } = useUiSettings();

  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="user-message max-w-[82%] whitespace-pre-wrap rounded-[14px] border border-border-soft px-4 py-2.5 text-[13px] leading-relaxed text-foreground">
          {text}
        </div>
      </div>
    );
  }

  const hasText = message.parts.some((p) => p.type === "text" && p.text.trim());

  // Assistant: no avatar bubble — plain prose in a single 12px left gutter
  // (Hermes --message-text-indent), footer actions right-aligned on hover.
  return (
    <div className="assistant-message group min-w-0 pl-4">
      {message.parts.map((part, i) => {
        if (part.type === "tool") return <ToolRow key={part.toolCallId || i} part={part} />;
        if (part.type === "reasoning" && showReasoning)
          return <ThinkingDisclosure key={i} text={part.text} pending={message.pending} />;
        if (part.type === "reasoning") return null;
        return <Markdown key={i} text={part.text} />;
      })}
      {message.pending && <span className="caret" />}
      {!message.pending && hasText && (
        <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyAction getText={() => messageText(message.parts)} />
        </div>
      )}
    </div>
  );
});
