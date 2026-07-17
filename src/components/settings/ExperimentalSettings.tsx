import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Lock, ShieldAlert } from "lucide-react";

import { Button, Switch } from "@/components/ui";
import { ExperimentalRiskBadge } from "@/components/settings/ExperimentalRiskBadge";
import { BrowserSubscriptionAuthCard } from "@/components/settings/BrowserSubscriptionAuthCard";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import {
  EXPERIMENTAL_ACCEPT_PHRASE,
  buildAcceptExperimentalPayload,
  buildFeatureTogglePayload,
  buildRevokeExperimentalPayload,
  experimentalFromConfig,
} from "@/lib/experimental";
import type { AppConfig, ExperimentalFeatureId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ExperimentalSettingsProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

const FEATURES: readonly ExperimentalFeatureId[] = ["browserSubscriptionAuth"];

export function ExperimentalSettings({ config, onSaved }: ExperimentalSettingsProps) {
  const { t, date } = useI18n();
  const [draft, setDraft] = useState(() => experimentalFromConfig(config));
  const [phrase, setPhrase] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<"idle" | "saved" | "failed" | "phrase">("idle");
  const [revealForm, setRevealForm] = useState(false);

  useEffect(() => {
    setDraft(experimentalFromConfig(config));
    setPhrase("");
    setAck(false);
    setRevealForm(false);
  }, [config]);

  const phraseOk = phrase.trim() === EXPERIMENTAL_ACCEPT_PHRASE;
  const canAccept = !draft.companyLocked && phraseOk && ack && !busy;

  const save = async (
    next: ReturnType<typeof experimentalFromConfig>,
    extra?: { experimentalAcceptPhrase?: string },
  ) => {
    setBusy(true);
    setNote("idle");
    try {
      const saved = await gateway.setConfig({
        experimental: next,
        ...(extra?.experimentalAcceptPhrase
          ? { experimentalAcceptPhrase: extra.experimentalAcceptPhrase }
          : {}),
      });
      onSaved(saved);
      setDraft(experimentalFromConfig(saved));
      setNote("saved");
      setPhrase("");
      setAck(false);
      setRevealForm(false);
    } catch {
      setNote("failed");
    } finally {
      setBusy(false);
    }
  };

  const featureRows = useMemo(
    () => FEATURES.map((id) => ({
      id,
      enabled: draft.features[id] === true,
      title: t(`settings.experimental.feature.${id}.title`),
      hint: t(`settings.experimental.feature.${id}.hint`),
    })),
    [draft.features, t],
  );

  return (
    <section className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert className="size-4 text-warning" aria-hidden />
            <h4 className="text-[12px] font-semibold text-foreground">
              {t("settings.experimental.title")}
            </h4>
            <ExperimentalRiskBadge />
          </div>
          <p className="max-w-2xl text-[10.5px] leading-4 text-muted">
            {t("settings.experimental.hint")}
          </p>
        </div>
        {draft.companyLocked ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-border-soft bg-surface/60 px-2 py-1 text-[10px] text-muted">
            <Lock className="size-3" aria-hidden />
            {t("settings.experimental.companyLocked")}
          </span>
        ) : null}
      </div>

      <div className="rounded-md border border-border-soft bg-bg/40 px-2.5 py-2 text-[10.5px] leading-4 text-secondary">
        <p className="font-medium text-foreground">{t("settings.experimental.disclaimerTitle")}</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4">
          <li>{t("settings.experimental.disclaimer.1")}</li>
          <li>{t("settings.experimental.disclaimer.2")}</li>
          <li>{t("settings.experimental.disclaimer.3")}</li>
          <li>{t("settings.experimental.disclaimer.4")}</li>
        </ul>
        <p className="mt-2 text-[10px] text-muted">
          {t("settings.experimental.disclaimerVersion", { version: draft.disclaimerVersion })}
        </p>
      </div>

      {draft.unlocked && !draft.companyLocked ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/25 bg-success/5 px-2.5 py-2">
            <div>
              <p className="text-[11px] font-medium text-foreground">
                {t("settings.experimental.unlocked")}
              </p>
              {draft.acceptedAt ? (
                <p className="text-[10px] text-muted">
                  {t("settings.experimental.acceptedAt", {
                    time: date(Date.parse(draft.acceptedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void save(buildRevokeExperimentalPayload())}
            >
              {t("settings.experimental.revoke")}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              {t("settings.experimental.featuresTitle")}
            </p>
            {featureRows.map((row) => (
              <label
                key={row.id}
                className={cn(
                  "flex items-start gap-2 rounded-md border border-border-soft bg-surface/50 px-2.5 py-2",
                  !draft.unlocked && "opacity-60",
                )}
              >
                <Switch
                  checked={row.enabled}
                  disabled={busy || draft.companyLocked || !draft.unlocked}
                  onCheckedChange={(enabled) => {
                    const next = buildFeatureTogglePayload(draft, row.id, enabled);
                    setDraft(next);
                    void save(next);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground">{row.title}</span>
                    <ExperimentalRiskBadge />
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-muted">{row.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {!revealForm ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || draft.companyLocked}
              onClick={() => setRevealForm(true)}
            >
              <AlertTriangle className="size-3.5" aria-hidden />
              {t("settings.experimental.reveal")}
            </Button>
          ) : (
            <div className="space-y-2 rounded-md border border-border-soft bg-surface/40 p-2.5">
              <label className="block space-y-1">
                <span className="text-[10px] text-muted">
                  {t("settings.experimental.typePhrase", { phrase: EXPERIMENTAL_ACCEPT_PHRASE })}
                </span>
                <input
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  disabled={busy || draft.companyLocked}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 w-full max-w-md rounded-md border border-border bg-bg px-2 font-mono text-[11px] text-foreground"
                  aria-label={t("settings.experimental.typePhrase", { phrase: EXPERIMENTAL_ACCEPT_PHRASE })}
                />
              </label>
              <label className="flex items-start gap-2 text-[10.5px] leading-4 text-secondary">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy || draft.companyLocked}
                  onChange={(event) => setAck(event.target.checked)}
                  className="mt-0.5"
                />
                <span>{t("settings.experimental.ack")}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!canAccept}
                  onClick={() => {
                    if (!phraseOk) {
                      setNote("phrase");
                      return;
                    }
                    void save(buildAcceptExperimentalPayload(draft), {
                      experimentalAcceptPhrase: EXPERIMENTAL_ACCEPT_PHRASE,
                    });
                  }}
                >
                  {t("settings.experimental.accept")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setRevealForm(false);
                    setPhrase("");
                    setAck(false);
                  }}
                >
                  {t("settings.experimental.cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {note === "saved" ? (
        <p className="text-[10.5px] text-success">{t("settings.saved")}</p>
      ) : null}
      {note === "failed" ? (
        <p className="text-[10.5px] text-danger">{t("settings.saveFailed")}</p>
      ) : null}
      {note === "phrase" ? (
        <p className="text-[10.5px] text-danger">{t("settings.experimental.phraseError")}</p>
      ) : null}

      {draft.unlocked && !draft.companyLocked && draft.features.browserSubscriptionAuth ? (
        <BrowserSubscriptionAuthCard config={config} onSaved={onSaved} />
      ) : null}
    </section>
  );
}
