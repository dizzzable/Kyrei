import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FileExplorer } from "@/components/FileExplorer";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type { ChatMessage } from "@/lib/types";
import { TerminalActivity } from "./TerminalActivity";

interface DeveloperRailProps {
  workspace?: string;
  sessionId?: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  split: number;
  onSplitChange: (split: number) => void;
  onWorkspaceOpen?: (path: string) => Promise<void> | void;
  onClose: () => void;
}

function workspaceName(workspace?: string): string {
  if (!workspace) return "Kyrei";
  const segments = workspace.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.at(-1) || "Kyrei";
}

export function DeveloperRail({
  workspace,
  sessionId,
  split,
  onSplitChange,
  onWorkspaceOpen,
  onClose,
}: DeveloperRailProps) {
  const { t } = useI18n();
  const railRef = useRef<HTMLElement | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState(workspace ?? "");

  useEffect(() => setActiveWorkspace(workspace ?? ""), [workspace]);

  const connectWorkspace = async (path: string) => {
    if (onWorkspaceOpen) await onWorkspaceOpen(path);
    else await gateway.setConfig({ workspace: path });
    setActiveWorkspace(path);
  };

  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rail = railRef.current;
    if (!rail) return;
    const bounds = rail.getBoundingClientRect();

    const move = (nextEvent: PointerEvent) => {
      const next = (nextEvent.clientY - bounds.top) / bounds.height;
      onSplitChange(Math.min(0.82, Math.max(0.34, next)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <aside ref={railRef} className="developer-rail flex h-full min-h-0 w-full flex-col bg-surface">
      <div className="relative min-h-0" style={{ height: `${split * 100}%` }}>
        <FileExplorer
          workspace={activeWorkspace}
          workspaceName={workspaceName(activeWorkspace)}
          onWorkspaceOpen={connectWorkspace}
          onClose={onClose}
        />
        <div
          className="absolute inset-x-0 bottom-0 z-30 h-1.5 translate-y-1/2 cursor-row-resize transition-colors hover:bg-primary/50"
          onPointerDown={startSplitResize}
          role="separator"
          aria-label={t("shell.terminal.resize")}
          aria-orientation="horizontal"
          aria-valuemin={34}
          aria-valuemax={82}
          aria-valuenow={Math.round(split * 100)}
        />
      </div>
      <div className="min-h-0 flex-1 border-t border-border-soft">
        <TerminalActivity ownerId={sessionId || "workspace"} workspace={activeWorkspace || undefined} />
      </div>
    </aside>
  );
}
