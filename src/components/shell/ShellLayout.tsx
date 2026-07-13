import type { CSSProperties, ReactNode } from "react";

interface ShellLayoutProps {
  developer: ReactNode;
  conversation: ReactNode;
  activity: ReactNode;
  developerOpen: boolean;
  activityOpen: boolean;
  swapped: boolean;
  developerWidth: number;
  activityWidth: number;
}

export function ShellLayout({
  developer,
  conversation,
  activity,
  developerOpen,
  activityOpen,
  swapped,
  developerWidth,
  activityWidth,
}: ShellLayoutProps) {
  const style = {
    "--developer-rail-width": `${developerOpen ? developerWidth : 0}px`,
    "--activity-rail-width": `${activityOpen ? activityWidth : 0}px`,
  } as CSSProperties;

  const developerPane = developerOpen ? (
    <div className="shell-pane shell-pane-developer" data-shell-pane="developer">{developer}</div>
  ) : null;
  const conversationPane = (
    <div className="shell-pane shell-pane-conversation" data-shell-pane="conversation">{conversation}</div>
  );
  const activityPane = activityOpen ? (
    <div className="shell-pane shell-pane-activity" data-shell-pane="activity">{activity}</div>
  ) : null;

  return (
    <div className="shell-layout" data-swapped={swapped ? "true" : "false"} style={style}>
      {swapped ? activityPane : developerPane}
      {conversationPane}
      {swapped ? developerPane : activityPane}
    </div>
  );
}
