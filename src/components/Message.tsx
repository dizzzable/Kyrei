import { memo } from "react";
import type { ChatMessage } from "@/lib/types";
import { Markdown } from "./Markdown";
import { ToolRow } from "./ToolRow";

export const Message = memo(function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.parts.map(p => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-user px-4 py-2.5 leading-relaxed text-foreground">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-strong text-[12px] font-bold text-white">
        K
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        {message.parts.map((part, i) => {
          if (part.type === "tool") return <ToolRow key={part.toolCallId || i} part={part} />;
          if (part.type === "reasoning")
            return (
              <div key={i} className="my-1.5 border-l-2 border-border pl-3 text-[13px] italic text-muted">
                {part.text}
              </div>
            );
          return <Markdown key={i} text={part.text} />;
        })}
        {message.pending && <span className="caret" />}
      </div>
    </div>
  );
});
