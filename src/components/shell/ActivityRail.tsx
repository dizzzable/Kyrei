import {
  Archive,
  Blocks,
  BrainCircuit,
  Command,
  Home,
  MessageSquarePlus,
  MessagesSquare,
  ServerCog,
  Settings,
} from "lucide-react";

import { Sidebar } from "@/components/Sidebar";
import { useI18n } from "@/i18n";
import type { SessionInfo } from "@/lib/types";
import { ACTIVITY_REGISTRY, type ActivityId } from "./activity-registry";

const ACTIVITY_ICONS = {
  sessions: Home,
  capabilities: Blocks,
  messaging: MessagesSquare,
  artifacts: Archive,
  memory: BrainCircuit,
  providers: ServerCog,
} as const;

interface ActivityRailProps {
  sessions: SessionInfo[];
  currentId: string | null;
  workingId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onFork?: (id: string) => void;
  onContinue?: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenActivity: (id: Exclude<ActivityId, "sessions">) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}

export function ActivityRail({
  sessions,
  currentId,
  workingId,
  onSelect,
  onNew,
  onArchive,
  onDelete,
  onFork,
  onContinue,
  onRename,
  onOpenActivity,
  onHome,
  onOpenSettings,
  onOpenPalette,
}: ActivityRailProps) {
  const { t } = useI18n();

  return (
    <aside className="activity-rail flex h-full min-h-0 w-full flex-col bg-surface">
      <div className="activity-primary-nav">
        <button onClick={onNew} className="activity-new-button">
          <MessageSquarePlus size={14} aria-hidden />
          <span>{t("shell.session.new")}</span>
        </button>
        {ACTIVITY_REGISTRY.filter((item) => item.id !== "sessions").map((item) => {
          const Icon = ACTIVITY_ICONS[item.id];
          const unavailable = item.adapter === "unavailable";
          return (
            <button
              key={item.id}
              onClick={() => {
                if (!unavailable) onOpenActivity(item.id as Exclude<ActivityId, "sessions">);
              }}
              disabled={unavailable}
              className="activity-nav-row disabled:cursor-not-allowed disabled:opacity-45"
              title={unavailable ? `${t("shell.activity.unavailable")}: ${t(item.descriptionKey)}` : t(item.descriptionKey)}
              aria-disabled={unavailable}
            >
              <Icon size={14} aria-hidden />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>

      <Sidebar
        sessions={sessions}
        currentId={currentId}
        workingId={workingId}
        onSelect={onSelect}
        onArchive={onArchive}
        onDelete={onDelete}
        onFork={onFork}
        onContinue={onContinue}
        onRename={onRename}
      />

      <footer className="activity-rail-footer">
        <button type="button" onClick={onHome} className="shell-icon-button text-foreground" title={t("shell.activity.sessions")} aria-label={t("shell.activity.sessions")}>
          <Home size={14} aria-hidden />
        </button>
        <button type="button" onClick={onNew} className="shell-icon-button" title={t("shell.session.new")} aria-label={t("shell.session.new")}>
          <MessageSquarePlus size={14} aria-hidden />
        </button>
        <button type="button" onClick={onOpenPalette} className="shell-icon-button" title={t("shell.commandPalette.open")} aria-label={t("shell.commandPalette.open")}>
          <Command size={14} aria-hidden />
        </button>
        <button type="button" onClick={onOpenSettings} className="shell-icon-button ml-auto" title={t("shell.settings.open")} aria-label={t("shell.settings.open")}>
          <Settings size={14} aria-hidden />
        </button>
      </footer>
    </aside>
  );
}
