import {
  Building2,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, IconButton } from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type { KiroOrganizationPoolSnapshot } from "@/lib/kiro-organization-types";
import { cn } from "@/lib/utils";
import { KiroOrganizationPoolDialog, kiroOrganizationErrorKey } from "./KiroOrganizationPoolDialog";

export function KiroOrganizationPoolCard() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<KiroOrganizationPoolSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const load = useCallback(async (showBusy = true) => {
    if (showBusy) setLoading(true);
    setErrorKey(null);
    try {
      setSnapshot(await gateway.getKiroOrganizationPool());
    } catch (reason) {
      setErrorKey(kiroOrganizationErrorKey(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = snapshot?.accounts.filter((account) => account.status === "ready" && account.enabled).length ?? 0;
  const protectedStorage = snapshot?.protectedStorage === true;

  return (
    <>
      <section
        aria-labelledby="kiro-organization-pool-title"
        className="overflow-hidden rounded-lg border border-border-soft bg-surface/35"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft px-3 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/8 text-primary">
              <Building2 className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="kiro-organization-pool-title" className="text-[12px] font-semibold text-foreground">
                  {t("settings.providers.kiroOrganization.title")}
                </h3>
                {snapshot ? (
                  <Badge tone={snapshot.enabled ? "primary" : "neutral"}>
                    {t(snapshot.enabled
                      ? "settings.providers.kiroOrganization.enabled"
                      : "settings.providers.kiroOrganization.disabled")}
                  </Badge>
                ) : null}
                {snapshot ? (
                  <Badge tone={protectedStorage ? "success" : "danger"}>
                    {t(protectedStorage
                      ? "settings.providers.kiroOrganization.storageProtected"
                      : "settings.providers.kiroOrganization.storageUnavailableBadge")}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 max-w-3xl text-[10.5px] leading-4 text-muted">
                {t("settings.providers.kiroOrganization.description")}
              </p>
            </div>
          </div>
          <IconButton
            size="icon-sm"
            tip={t("settings.providers.kiroOrganization.refresh")}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
          </IconButton>
        </div>

        <div className="space-y-3 px-3 py-3">
          {errorKey ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-[10.5px] text-danger" role="alert">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{t(errorKey)}</span>
            </div>
          ) : null}

          {loading && !snapshot ? (
            <div className="flex min-h-16 items-center justify-center gap-2 text-[10.5px] text-muted" role="status">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              {t("settings.providers.kiroOrganization.loading")}
            </div>
          ) : null}

          {snapshot ? (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border border-border-soft bg-bg/25 px-3 py-2">
                  <span className="block text-[9px] uppercase tracking-[0.12em] text-muted">{t("settings.providers.kiroOrganization.summary.accounts")}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-foreground">{snapshot.accounts.length}</span>
                </div>
                <div className="rounded-md border border-border-soft bg-bg/25 px-3 py-2">
                  <span className="block text-[9px] uppercase tracking-[0.12em] text-muted">{t("settings.providers.kiroOrganization.summary.ready")}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-success">{ready}</span>
                </div>
                <div className="rounded-md border border-border-soft bg-bg/25 px-3 py-2">
                  <span className="block text-[9px] uppercase tracking-[0.12em] text-muted">{t("settings.providers.kiroOrganization.summary.transport")}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-secondary" title={snapshot.transport}>{snapshot.transport}</span>
                </div>
              </div>
              <Button variant="secondary" size="sm" disabled={!snapshot.protectedStorage} onClick={() => setDialogOpen(true)}>
                <Settings2 className="size-3.5" aria-hidden />
                {t("settings.providers.kiroOrganization.manage")}
              </Button>
            </div>
          ) : null}

          <div className="flex items-start gap-2 rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-[9.5px] leading-4 text-secondary">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <span>{t("settings.providers.kiroOrganization.boundaryHint")}</span>
          </div>
        </div>
      </section>

      {snapshot ? (
        <KiroOrganizationPoolDialog
          open={dialogOpen}
          snapshot={snapshot}
          onOpenChange={setDialogOpen}
          onSnapshot={setSnapshot}
        />
      ) : null}
    </>
  );
}
