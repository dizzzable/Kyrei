import { memo, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { messageText } from "@/lib/chat-messages";
import { IconButton } from "@/components/ui";
import { useUiSettings } from "@/store/settings";
import { Markdown } from "./Markdown";
import { ToolRow } from "./ToolRow";
import { ThinkingDisclosure } from "./chat/ThinkingDisclosure";
import { ApprovalCard } from "./chat/ApprovalCard";
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

export const Message = memo(function Message({
  message,
  onRewind,
  onApprovalDecision,
}: {
  message: ChatMessage;
  onRewind?: (messageId: string) => void;
  onApprovalDecision?: (approvalId: string, approved: boolean) => Promise<void> | void;
}) {
  const { showReasoning } = useUiSettings();
  const { t } = useI18n();

  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="group flex justify-end">
        <div className="flex max-w-[82%] flex-col items-end">
          <div className="user-message w-fit whitespace-pre-wrap rounded-[14px] border border-border-soft px-4 py-2.5 text-[13px] leading-relaxed text-foreground">
            {text}
          </div>
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyAction getText={() => text} />
            {onRewind && (
              <IconButton tip={t("chat.message.rewind")} size="icon-xs" onClick={() => onRewind(message.id)}>
                <RotateCcw className="size-3.5" />
              </IconButton>
            )}
          </div>
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
        if (part.type === "approval") return <ApprovalCard key={part.approvalId || i} part={part} onDecision={onApprovalDecision} />;
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
