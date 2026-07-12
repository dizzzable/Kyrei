import { cn } from "@/lib/utils";

/**
 * Bottom status strip (Hermes-style): a 20px hairline footer with a LEFT group
 * (gateway/runtime state) and a RIGHT group (model / context / sessions /
 * version). 11px, muted, on the sidebar surface.
 */
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
  return (
    <footer className="statusbar flex h-5 shrink-0 items-stretch justify-between border-t border-border-soft px-1 text-[10px] text-muted">
      {/* Left group — runtime state */}
      <div className="flex min-w-0 items-stretch overflow-x-clip">
        <Item title={connected ? "Шлюз подключён" : "Подключение к шлюзу…"}>
          <Dot className={connected ? "bg-success" : "bg-warning"} />
          {connected ? "Готов" : "Подключение…"}
        </Item>
        {streaming && (
          <Item title="Идёт генерация">
            <Dot className="animate-pulse bg-primary" />
            Работает…
          </Item>
        )}
      </div>

      {/* Right group — model / context / sessions / version */}
      <div className="flex min-w-0 items-stretch overflow-x-clip">
        {provider && <Item className="hidden md:inline-flex" title={provider}>{stripScheme(provider)}</Item>}
        {tokens != null && tokens > 0 && (
          <Item title="Токенов в контексте">{formatTokens(tokens)} ток.</Item>
        )}
        <Item title="Активная модель">
          <Dot className={hasKey ? "bg-success" : "bg-warning"} />
          <span className="max-w-[16rem] truncate">{model || "нет модели"}</span>
        </Item>
        <Item>{sessionCount} {plural(sessionCount)}</Item>
        <Item className="text-faint" title="Версия">v{__APP_VERSION__}</Item>
      </div>
    </footer>
  );
}

function Item({ children, title, className }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex h-full items-center gap-1.5 px-1.5 transition-colors hover:text-foreground", className)}
    >
      {children}
    </span>
  );
}

function Dot({ className }: { className?: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", className)} />;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "диалог";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "диалога";
  return "диалогов";
}
