import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import {
  checkForAppUpdate,
  KYREI_RELEASES_PAGE_URL,
  releaseTagUrl,
  type UpdateCheckResult,
} from "@/lib/app-update";
import {
  desktopShell,
  desktopUpdate,
  type DesktopUpdateStatus,
} from "@/lib/desktop";

type ManualPhase = "idle" | "checking" | UpdateCheckResult;

function currentAppVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
}

export function AboutUpdatePanel() {
  const { t } = useI18n();
  const [native, setNative] = useState<DesktopUpdateStatus | null>(null);
  const [manual, setManual] = useState<ManualPhase>("idle");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!desktopUpdate.available()) return;
    let cancelled = false;
    void desktopUpdate.getStatus().then((status) => {
      if (!cancelled) setNative(status);
    }).catch(() => undefined);
    const stop = desktopUpdate.onStatus((status) => {
      setNative(status);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const openUrl = useCallback(async (url: string) => {
    setOpening(true);
    try {
      if (desktopShell.available()) {
        await desktopShell.openExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setManual({
        status: "error",
        currentVersion: currentAppVersion(),
        error: "open_failed",
      });
    } finally {
      setOpening(false);
    }
  }, []);

  const canAutoInstall = native?.canAutoInstall === true;

  const onCheck = useCallback(async () => {
    setBusy(true);
    try {
      if (canAutoInstall && desktopUpdate.available()) {
        const status = await desktopUpdate.check();
        setNative(status);
        return;
      }
      setManual("checking");
      const result = await checkForAppUpdate({ currentVersion: currentAppVersion() });
      setManual(result);
    } catch {
      if (canAutoInstall) {
        setNative((prev) => prev ? { ...prev, phase: "error", error: "check_failed" } : prev);
      } else {
        setManual({
          status: "error",
          currentVersion: currentAppVersion(),
          error: "check_failed",
        });
      }
    } finally {
      setBusy(false);
    }
  }, [canAutoInstall]);

  const onDownload = useCallback(async () => {
    if (!canAutoInstall) return;
    if (!window.confirm(t("settings.about.updates.confirmDownload"))) return;
    setBusy(true);
    try {
      const status = await desktopUpdate.download();
      setNative(status);
    } catch {
      setNative((prev) => prev
        ? { ...prev, phase: "error", error: "download_failed" }
        : prev);
    } finally {
      setBusy(false);
    }
  }, [canAutoInstall, t]);

  const onInstall = useCallback(async () => {
    if (!canAutoInstall) return;
    if (!window.confirm(t("settings.about.updates.confirmInstall"))) return;
    setBusy(true);
    try {
      await desktopUpdate.install();
    } catch {
      setNative((prev) => prev
        ? { ...prev, phase: "error", error: "install_failed" }
        : prev);
      setBusy(false);
    }
  }, [canAutoInstall, t]);

  const statusText = (() => {
    if (canAutoInstall && native) {
      switch (native.phase) {
        case "idle":
          return t("settings.about.updates.hintInstall");
        case "checking":
          return t("settings.about.updates.checking");
        case "not-available":
          return t("settings.about.updates.upToDate", {
            version: native.latestVersion || native.currentVersion,
          });
        case "available":
          return t("settings.about.updates.availableInstall", {
            current: native.currentVersion,
            latest: native.latestVersion || "?",
          });
        case "downloading": {
          const pct = typeof native.percent === "number"
            ? Math.max(0, Math.min(100, Math.round(native.percent)))
            : null;
          return pct === null
            ? t("settings.about.updates.downloading")
            : t("settings.about.updates.downloadingPct", { percent: String(pct) });
        }
        case "downloaded":
          return t("settings.about.updates.downloaded", {
            version: native.latestVersion || "?",
          });
        case "error":
          return t("settings.about.updates.errorDetail", {
            detail: native.error || "error",
          });
        case "disabled":
          break;
        default:
          break;
      }
    }

    if (manual === "idle") {
      if (native?.reason === "portable") return t("settings.about.updates.hintPortable");
      if (native?.reason === "not_packaged") return t("settings.about.updates.hintDev");
      return t("settings.about.updates.hint");
    }
    if (manual === "checking") return t("settings.about.updates.checking");
    if (manual.status === "up_to_date") {
      return t("settings.about.updates.upToDate", { version: manual.latestVersion });
    }
    if (manual.status === "available") {
      return t("settings.about.updates.available", {
        current: manual.currentVersion,
        latest: manual.latestVersion,
      });
    }
    return t("settings.about.updates.error");
  })();

  const releaseUrl = (() => {
    if (canAutoInstall && native?.latestVersion) {
      return releaseTagUrl(native.latestVersion);
    }
    if (manual !== "idle" && manual !== "checking" && "releaseUrl" in manual) {
      return manual.releaseUrl;
    }
    return KYREI_RELEASES_PAGE_URL;
  })();

  const showDownload = canAutoInstall && native
    && (native.phase === "available" || (native.phase === "error" && Boolean(native.latestVersion)));
  const showInstall = canAutoInstall && native?.phase === "downloaded";
  const showManualOpen = !canAutoInstall && manual !== "idle" && manual !== "checking"
    && manual.status === "available";
  const checking = busy
    || manual === "checking"
    || native?.phase === "checking"
    || native?.phase === "downloading";

  return (
    <section className="rounded-md border border-border-soft bg-elevated/40 px-3 py-3">
      <div className="mb-1 text-[13px] font-medium text-foreground">
        {t("settings.about.updates.title")}
      </div>
      <p className="mb-3 text-[12px] leading-snug text-muted" role="status" aria-live="polite">
        {statusText}
      </p>
      {canAutoInstall && native?.phase === "downloading" && typeof native.percent === "number" && (
        <div
          className="mb-3 h-1.5 overflow-hidden rounded-full bg-border-soft"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(native.percent)}
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${Math.max(0, Math.min(100, native.percent))}%` }}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={checking}
          onClick={() => void onCheck()}
        >
          {checking && (manual === "checking" || native?.phase === "checking")
            ? t("settings.about.updates.checking")
            : t("settings.about.updates.check")}
        </Button>
        {showDownload && (
          <Button
            size="sm"
            variant="default"
            disabled={busy || native?.phase === "downloading"}
            onClick={() => void onDownload()}
          >
            {native?.phase === "downloading"
              ? t("settings.about.updates.downloading")
              : t("settings.about.updates.download")}
          </Button>
        )}
        {showInstall && (
          <Button
            size="sm"
            variant="default"
            disabled={busy}
            onClick={() => void onInstall()}
          >
            {t("settings.about.updates.install")}
          </Button>
        )}
        {(showManualOpen || showDownload || showInstall) && (
          <Button
            size="sm"
            variant="outline"
            disabled={opening}
            onClick={() => void openUrl(releaseUrl)}
          >
            {t("settings.about.updates.openRelease")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={opening}
          onClick={() => void openUrl(KYREI_RELEASES_PAGE_URL)}
        >
          {t("settings.about.updates.openAll")}
        </Button>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-faint">
        {canAutoInstall
          ? t("settings.about.updates.installNote")
          : t("settings.about.updates.manualNote")}
      </p>
    </section>
  );
}
