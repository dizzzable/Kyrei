import { memo, useState } from "react";
import { Check, Copy, GitFork, RotateCcw } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { messageText } from "@/lib/chat-messages";
import { sanitizeAssistantDisplayText } from "@/lib/assistant-display";
import { IconButton } from "@/components/ui";
import { useUiSettings } from "@/store/settings";
import { Markdown } from "./Markdown";
import { ToolRow } from "./ToolRow";
import { ThinkingDisclosure } from "./chat/ThinkingDisclosure";
import { ApprovalCard } from "./chat/ApprovalCard";
import { FileReviewCard } from "./chat/FileReviewCard";
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
  onFork,
  onApprovalDecision,
  onFileReviewDecision,
  onFileReviewFileDecision,
  onFileReviewHunkDecision,
}: {
  message: ChatMessage;
  onRewind?: (messageId: string) => void;
  /** Fork chat from this user message (new session, parent untouched). */
  onFork?: (messageId: string) => void;
  onApprovalDecision?: (
    approvalId: string,
    approved: boolean,
    options?: { always?: boolean },
  ) => Promise<void> | void;
  onFileReviewDecision?: (accept: boolean) => Promise<void> | void;
  onFileReviewFileDecision?: (path: string, accept: boolean) => Promise<void> | void;
  onFileReviewHunkDecision?: (path: string, hunkId: string, accept: boolean) => Promise<void> | void;
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
            {onFork && (
              <IconButton tip={t("chat.message.forkHint")} size="icon-xs" onClick={() => onFork(message.id)}>
                <GitFork className="size-3.5" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    );
  }

  const visibleText = message.parts
    .filter((part): part is Extract<ChatMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => sanitizeAssistantDisplayText(part.text))
    .join("");
  const hasText = visibleText.trim().length > 0;

  // Assistant: no avatar bubble — plain prose in a single 12px left gutter
  // (Hermes --message-text-indent), footer actions right-aligned on hover.
  return (
    <div className="assistant-message group min-w-0">
      {message.parts.map((part, i) => {
        if (part.type === "tool") return <ToolRow key={part.toolCallId || i} part={part} />;
        if (part.type === "approval") return <ApprovalCard key={part.approvalId || i} part={part} onDecision={onApprovalDecision} />;
        if (part.type === "reasoning" && showReasoning)
          return <ThinkingDisclosure key={i} text={part.text} pending={message.pending} />;
        if (part.type === "reasoning") return null;
        const text = sanitizeAssistantDisplayText(part.text);
        if (!text.trim()) return null;
        return <Markdown key={i} text={text} />;
      })}
      {message.fileReview && (
        <FileReviewCard
          review={message.fileReview}
          onDecision={
            message.fileReview.status === "pending" || message.fileReview.status === "partial"
              ? onFileReviewDecision
              : undefined
          }
          onFileDecision={
            message.fileReview.status === "pending" || message.fileReview.status === "partial"
              ? onFileReviewFileDecision
              : undefined
          }
          onHunkDecision={
            message.fileReview.status === "pending" || message.fileReview.status === "partial"
              ? onFileReviewHunkDecision
              : undefined
          }
        />
      )}
      {message.pending && <span className="caret" />}
      {!message.pending && hasText && (
        <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyAction getText={() => sanitizeAssistantDisplayText(messageText(message.parts))} />
        </div>
      )}
    </div>
  );
});
