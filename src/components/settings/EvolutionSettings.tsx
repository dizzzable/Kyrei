import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Input, Switch } from "@/components/ui";
import { EnumField } from "@/components/settings/ConfigField";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type { AppConfig, EvolutionRuntimeConfig } from "@/lib/types";

const CLAMP = {
  maxCandidates: { min: 10, max: 10_000, fallback: 500 },
  retentionDays: { min: 7, max: 3_650, fallback: 180 },
} as const;
const COST = { min: 0.01, max: 10_000 } as const;

function clampInt(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/** Cost ceiling is nullable: empty/0/invalid → null ("no limit"). */
function clampCost(value: unknown): number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(COST.max, Math.max(COST.min, n));
}

/**
 * Read the evolution subtree from the engine config, mirroring the gateway's
 * `currentEvolutionConfig()` defaulting/clamping so the panel shows the same
 * values the runtime will use. Single source of truth is `config.engine`.
 */
function evolutionFromEngine(engine: Record<string, unknown> | undefined): EvolutionRuntimeConfig {
  const raw = engine && typeof engine.evolution === "object" && engine.evolution
    ? (engine.evolution as Record<string, unknown>)
    : {};
  const cost = Number(raw.maxEvaluationCostUsd);
  return {
    harvestEnabled: raw.harvestEnabled !== false,
    evaluationEnabled: raw.evaluationEnabled === true,
    promotionMode:
      raw.promotionMode === "off" || raw.promotionMode === "low-risk-canary"
        ? raw.promotionMode
        : "manual",
    maxCandidates: clampInt(raw.maxCandidates ?? CLAMP.maxCandidates.fallback, CLAMP.maxCandidates),
    retentionDays: clampInt(raw.retentionDays ?? CLAMP.retentionDays.fallback, CLAMP.retentionDays),
    maxEvaluationCostUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
  };
}

/** Full engine spread + evolution subtree — never send a bare partial. */
function withEvolution(
  engine: Record<string, unknown> | undefined,
  evolution: EvolutionRuntimeConfig,
): Record<string, unknown> {
  return { ...(engine ?? {}), evolution };
}

interface EvolutionSettingsProps {
  config?: AppConfig | null;
  /** Reads the Settings modal's latest engine draft, not a stale config prop. */
  getCurrentEngine?: () => Record<string, unknown>;
  onSaved?: (config: AppConfig) => void;
}

export function EvolutionSettings({ config, getCurrentEngine, onSaved }: EvolutionSettingsProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<EvolutionRuntimeConfig>(() => evolutionFromEngine(config?.engine));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<"idle" | "saved" | "failed">("idle");
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalResult, setEvalResult] = useState<string | null>(null);

  useEffect(() => {
    setDraft(evolutionFromEngine(config?.engine));
    setEvalResult(null);
  }, [config?.engine]);

  const runEvaluation = async () => {
    setEvalBusy(true);
    setEvalResult(null);
    try {
      const result = await gateway.evaluateEvolution();
      setEvalResult(
        result.ok
          ? t("settings.evolution.runResult", {
              evaluated: result.evaluated,
              approved: result.approved,
              rejected: result.rejected,
            })
          : t("settings.evolution.runDisabled"),
      );
    } catch {
      setEvalResult(t("settings.saveFailed"));
    } finally {
      setEvalBusy(false);
    }
  };

  const save = async (next: EvolutionRuntimeConfig) => {
    if (!config) return;
    setBusy(true);
    setNote("idle");
    try {
      const engine = withEvolution(getCurrentEngine?.() ?? config.engine, next);
      const saved = await gateway.setConfig({ engine });
      onSaved?.(saved);
      setDraft(evolutionFromEngine(saved.engine));
      setNote("saved");
      window.setTimeout(() => setNote("idle"), 1400);
    } catch {
      setNote("failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border-soft bg-surface/40 p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-accent" aria-hidden />
        <h4 className="text-[12px] font-semibold text-foreground">{t("settings.evolution.title")}</h4>
      </div>
      <p className="max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.evolution.hint")}</p>

      <label className="flex items-start gap-2 rounded-md border border-border-soft bg-bg/40 px-2.5 py-2">
        <Switch
          checked={draft.harvestEnabled}
          disabled={busy}
          onCheckedChange={(harvestEnabled) => {
            const next = { ...draft, harvestEnabled };
            setDraft(next);
            void save(next);
          }}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-[11px] font-medium text-foreground">
            {t("settings.evolution.harvest.label")}
          </span>
          <span className="mt-0.5 block text-[10px] leading-4 text-muted">
            {t("settings.evolution.harvest.hint")}
          </span>
        </span>
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-[10px] text-muted">{t("settings.evolution.maxCandidates.label")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={CLAMP.maxCandidates.min}
            max={CLAMP.maxCandidates.max}
            defaultValue={draft.maxCandidates}
            disabled={busy}
            onBlur={(event) => {
              const maxCandidates = clampInt(event.target.value, CLAMP.maxCandidates);
              if (maxCandidates === draft.maxCandidates) return;
              const next = { ...draft, maxCandidates };
              setDraft(next);
              void save(next);
            }}
          />
        </label>
        <label className="space-y-1">
          <span className="block text-[10px] text-muted">{t("settings.evolution.retentionDays.label")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={CLAMP.retentionDays.min}
            max={CLAMP.retentionDays.max}
            defaultValue={draft.retentionDays}
            disabled={busy}
            onBlur={(event) => {
              const retentionDays = clampInt(event.target.value, CLAMP.retentionDays);
              if (retentionDays === draft.retentionDays) return;
              const next = { ...draft, retentionDays };
              setDraft(next);
              void save(next);
            }}
          />
        </label>
      </div>

      <label className="flex items-start gap-2 rounded-md border border-border-soft bg-bg/40 px-2.5 py-2">
        <Switch
          checked={draft.evaluationEnabled}
          disabled={busy}
          onCheckedChange={(evaluationEnabled) => {
            const next = { ...draft, evaluationEnabled };
            setDraft(next);
            void save(next);
          }}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-[11px] font-medium text-foreground">
            {t("settings.evolution.evaluation.label")}
          </span>
          <span className="mt-0.5 block text-[10px] leading-4 text-muted">
            {t("settings.evolution.evaluation.hint")}
          </span>
        </span>
      </label>

      {draft.evaluationEnabled && (
        <>
          <label className="space-y-1">
            <span className="block text-[10px] text-muted">{t("settings.evolution.maxEvaluationCostUsd.label")}</span>
            <Input
              type="number"
              inputMode="decimal"
              min={COST.min}
              max={COST.max}
              step={0.01}
              defaultValue={draft.maxEvaluationCostUsd ?? ""}
              placeholder={t("settings.evolution.maxEvaluationCostUsd.placeholder")}
              disabled={busy}
              onBlur={(event) => {
                const maxEvaluationCostUsd = clampCost(event.target.value);
                if (maxEvaluationCostUsd === draft.maxEvaluationCostUsd) return;
                const next = { ...draft, maxEvaluationCostUsd };
                setDraft(next);
                void save(next);
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || evalBusy} onClick={() => void runEvaluation()}>
              {evalBusy ? t("settings.evolution.runNowBusy") : t("settings.evolution.runNow")}
            </Button>
            {evalResult && <span className="text-[10.5px] text-muted">{evalResult}</span>}
          </div>
        </>
      )}

      <EnumField
        label={t("settings.evolution.promotionMode.label")}
        hint={t("settings.evolution.promotionMode.hint")}
        disabled={busy}
        value={draft.promotionMode}
        options={[
          { value: "off", label: t("settings.evolution.promotionMode.off") },
          { value: "manual", label: t("settings.evolution.promotionMode.manual") },
          { value: "low-risk-canary", label: t("settings.evolution.promotionMode.low-risk-canary") },
        ]}
        onChange={(promotionMode) => {
          const next = { ...draft, promotionMode: promotionMode as EvolutionRuntimeConfig["promotionMode"] };
          setDraft(next);
          void save(next);
        }}
      />
      <p className="rounded-md border border-border-soft bg-bg/40 px-2.5 py-2 text-[10px] leading-4 text-muted">
        {t("settings.evolution.reviewOnly.note")}
      </p>

      {note === "saved" && <p className="text-[10.5px] text-success">{t("settings.saved")}</p>}
      {note === "failed" && <p className="text-[10.5px] text-danger">{t("settings.saveFailed")}</p>}
    </section>
  );
}
