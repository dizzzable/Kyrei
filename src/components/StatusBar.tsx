import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export function StatusBar({
  model,
  provider,
  hasKey,
  connected,
  streaming,
  sessionCount,
  tokens,
}: {
  model: string;
  provider: string;
  hasKey: boolean;
  connected?: boolean;
  streaming: boolean;
  sessionCount: number;
  tokens?: number | null;
}) {
  const { t, number } = useI18n();
  const tokenLabel = tokens == null ? "" : t("shell.status.tokens", { count: formatTokens(tokens, number) });

  return (
    <footer className="statusbar flex h-5 shrink-0 items-stretch justify-between border-t border-border-soft px-1 font-mono text-[9px] text-muted">
      <div className="flex min-w-0 items-stretch overflow-hidden">
        <StatusItem title={connected ? t("shell.status.gatewayConnected") : t("shell.status.gatewayConnecting")}>
          <Dot className={connected ? "bg-success" : "bg-warning"} />
          {connected ? t("shell.status.ready") : t("shell.status.connecting")}
        </StatusItem>
        {streaming && (
          <StatusItem title={t("shell.status.generating")}>
            <Dot className="animate-pulse bg-primary" />
            {t("shell.status.working")}
          </StatusItem>
        )}
      </div>

      <div className="flex min-w-0 items-stretch overflow-hidden">
        {provider && <StatusItem className="hidden lg:inline-flex" title={provider}>{stripScheme(provider)}</StatusItem>}
        {tokens != null && tokens > 0 && (
          <StatusItem title={t("shell.status.contextTokens")}>{tokenLabel}</StatusItem>
        )}
        <StatusItem title={t("shell.status.activeModel")}>
          <Dot className={hasKey ? "bg-success" : "bg-warning"} />
          <span className="max-w-52 truncate">{model || t("shell.status.noModel")}</span>
        </StatusItem>
        <StatusItem>{t("shell.session.count", { count: sessionCount })}</StatusItem>
        <StatusItem className="text-faint" title={t("shell.status.version")}>v{__APP_VERSION__}</StatusItem>
      </div>
    </footer>
  );
}

function StatusItem({ children, title, className }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-full items-center gap-1.5 px-1.5 transition-colors hover:text-foreground", className)}>
      {children}
    </span>
  );
}

function Dot({ className }: { className?: string }) {
  return <span className={cn("size-1 shrink-0 rounded-full", className)} aria-hidden />;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function formatTokens(value: number, number: (value: number, options?: Intl.NumberFormatOptions) => string): string {
  return value >= 1000 ? number(value / 1000, { maximumFractionDigits: 1 }) + "k" : number(value);
}
