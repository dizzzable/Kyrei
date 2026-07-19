import { Check, Gauge, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button, Switch } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import { allowsConfiguredEndpointTuning, supportsModelTuning } from "@/lib/model-capabilities";
import type { AppConfig, ModelRef } from "@/lib/types";
import { getModelPreset, setModelPreset } from "@/store/model-presets";
import { ModelAssignmentRow } from "./ModelAssignmentRow";
import { isSameModelRef, modelOptionsForProvider, selectableModelProviders } from "./model-options";
import { TeamSettings } from "../team/TeamSettings";
import { PipelineSettings } from "../team/PipelineSettings";
import { FallbackChainEditor } from "./FallbackChainEditor";
import {
  ModelCapabilitySettings,
  type ModelCapabilitySettingsCopy,
} from "./ModelCapabilitySettings";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "max"] as const;

interface ModelSettingsProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

export function ModelSettings({ config, onSaved }: ModelSettingsProps) {
  const { t, lang } = useI18n();
  const [providerId, setProviderId] = useState(config.activeProviderId);
  const [modelId, setModelId] = useState(config.activeModelId);
  const [effort, setEffort] = useState("medium");
  const [fast, setFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const selectableProviders = useMemo(
    () => selectableModelProviders(config.providers, config.activeProviderId),
    [config.activeProviderId, config.providers],
  );
  const models = useMemo(() => modelOptionsForProvider(config.providers, providerId), [config.providers, providerId]);
  const selectedProvider = config.providers.find((provider) => provider.id === providerId);
  const selectedModel = models.find((model) => model.id === modelId);
  const hasFixedReasoning = selectedProvider?.protocol === "openai-chat"
    && selectedProvider.reasoningTransport === "kimi-k3-reasoning-max";
  const capabilityCopy: ModelCapabilitySettingsCopy = {
    title: t("settings.model.capabilities.title"),
    description: t("settings.model.capabilities.description"),
    contextWindow: t("settings.model.capabilities.contextWindow"),
    maxOutput: t("settings.model.capabilities.maxOutput"),
    detected: t("settings.model.capabilities.detected"),
    overridePlaceholder: t("settings.model.capabilities.overridePlaceholder"),
    overrideActive: t("settings.model.capabilities.overrideActive"),
    reset: t("settings.model.capabilities.reset"),
    invalidValue: t("settings.model.capabilities.invalidValue"),
    unknown: t("settings.model.capabilities.unknown"),
    inputModalities: t("settings.model.capabilities.inputModalities"),
    outputModalities: t("settings.model.capabilities.outputModalities"),
    features: t("settings.model.capabilities.features"),
    featureTools: t("settings.model.capabilities.feature.tools"),
    featureReasoning: t("settings.model.capabilities.feature.reasoning"),
    featureStreaming: t("settings.model.capabilities.feature.streaming"),
    supported: t("settings.model.capabilities.supported"),
    unsupported: t("settings.model.capabilities.unsupported"),
    source: {
      "live-provider": t("settings.model.capabilities.source.live"),
      curated: t("settings.model.capabilities.source.curated"),
      mixed: t("settings.model.capabilities.source.mixed"),
      "user-override": t("settings.model.capabilities.source.override"),
      unknown: t("settings.model.capabilities.source.unknown"),
    },
    confidence: {
      high: t("settings.model.capabilities.confidence.high"),
      medium: t("settings.model.capabilities.confidence.medium"),
      low: t("settings.model.capabilities.confidence.low"),
      unknown: t("settings.model.capabilities.confidence.unknown"),
    },
    modality: {
      text: t("settings.model.capabilities.modality.text"),
      image: t("settings.model.capabilities.modality.image"),
      audio: t("settings.model.capabilities.modality.audio"),
      video: t("settings.model.capabilities.modality.video"),
      file: t("settings.model.capabilities.modality.file"),
    },
  };
  const tuningSupported = supportsModelTuning(
    selectedProvider?.protocol,
    selectedModel?.capabilities,
    {
      // A custom OpenAI-compatible endpoint is deliberately selected by the
      // operator. Its catalog may omit reasoning metadata even though the
      // endpoint accepts `reasoning_effort`; keep the Settings controls in
      // parity with the composer instead of hiding an executable setting.
      allowConfiguredEndpointTuning: allowsConfiguredEndpointTuning(selectedProvider),
    },
  );

  useEffect(() => {
    setProviderId(config.activeProviderId);
    setModelId(config.activeModelId);
  }, [config.activeProviderId, config.activeModelId]);

  useEffect(() => {
    const preset = getModelPreset(providerId, modelId);
    setEffort(preset.thinking === false ? "off" : preset.effort || "medium");
    setFast(Boolean(preset.fast));
  }, [providerId, modelId]);

  const storedPreset = getModelPreset(providerId, modelId);
  const storedEffort = storedPreset.thinking === false ? "off" : storedPreset.effort || "medium";
  const tuningEditable = tuningSupported && !hasFixedReasoning;
  const dirty = providerId !== config.activeProviderId
    || modelId !== config.activeModelId
    || (tuningEditable && (effort !== storedEffort || fast !== Boolean(storedPreset.fast)));

  const chooseProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setModelId(modelOptionsForProvider(config.providers, nextProviderId)[0]?.id ?? "");
    setSaved(false);
  };

  const applyDefault = async () => {
    if (!providerId || !modelId) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await gateway.setConfig({ activeProviderId: providerId, activeModelId: modelId });
      if (tuningEditable) {
        setModelPreset(providerId, modelId, { thinking: effort !== "off", effort: effort === "off" ? undefined : effort, fast });
      }
      onSaved(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1400);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const saveAssignment = async (
    role: "worker" | "build" | "polish" | "plan" | "deepreep",
    value: ModelRef | undefined,
  ) => {
    setBusy(true);
    setFailed(false);
    try {
      const nextAssignments = { ...(config.modelAssignments ?? {}) };
      if (value) nextAssignments[role] = value;
      else delete nextAssignments[role];
      onSaved(await gateway.setConfig({ modelAssignments: nextAssignments }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const saveFallbacks = async (fallbacks: ModelRef[]) => {
    setBusy(true);
    setFailed(false);
    try {
      onSaved(await gateway.setConfig({
        modelAssignments: { ...(config.modelAssignments ?? {}), fallbacks },
      }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const main: ModelRef = { providerId: config.activeProviderId, modelId: config.activeModelId };
  const draftMain: ModelRef = { providerId, modelId };
  const mainChanged = !isSameModelRef(main, draftMain);

  return (
    <div className="space-y-8">
      <header className="max-w-3xl">
        <h2 className="text-[14px] font-semibold text-foreground">{t("settings.model.pageTitle")}</h2>
        <p className="mt-1 text-[11px] leading-5 text-muted">{t("settings.model.pageDescription")}</p>
      </header>

      <section className="max-w-4xl space-y-4" aria-labelledby="default-model-title">
        <div>
          <h3 id="default-model-title" className="text-[12px] font-semibold text-foreground">{t("settings.model.defaultTitle")}</h3>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">{t("settings.model.defaultHint")}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]">
          <label className="space-y-1">
            <span className="text-[10.5px] text-muted">{t("settings.model.provider")}</span>
            <select value={providerId} disabled={busy} onChange={(event) => chooseProvider(event.target.value)} className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25">
              {selectableProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[10.5px] text-muted">{t("settings.model.model")}</span>
            <select value={modelId} disabled={busy} onChange={(event) => { setModelId(event.target.value); setSaved(false); }} className="h-8 w-full rounded-md border border-border bg-surface px-2.5 font-mono text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25">
              {models.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button disabled={busy || !dirty || !modelId} onClick={() => void applyDefault()} className="w-full md:w-auto">
              {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
              {!busy && saved ? <Check className="size-3.5" aria-hidden /> : null}
              {saved ? t("settings.saved") : t("settings.model.apply")}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-5 border-y border-border-soft py-3">
          <span className="inline-flex items-center gap-2 text-[11px] font-medium text-secondary"><Gauge className="size-3.5 text-muted" aria-hidden />{t("settings.model.defaults")}</span>
          <label className="inline-flex items-center gap-2 text-[10.5px] text-muted">
            <span>{t("settings.model.reasoning")}</span>
            <select
              value={tuningEditable ? effort : "off"}
              disabled={busy || !tuningEditable}
              aria-describedby={!tuningEditable ? "model-tuning-unavailable" : undefined}
              onChange={(event) => { setEffort(event.target.value); setFast(false); setSaved(false); }}
              className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none focus:border-primary/60"
            >
              {EFFORTS.map((value) => <option key={value} value={value}>{t(`settings.model.effort.${value}`)}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 text-[10.5px] text-muted">
            <span>{t("settings.model.fast")}</span>
            <Switch
              size="xs"
              checked={tuningEditable && fast}
              disabled={busy || !tuningEditable}
              aria-describedby={!tuningEditable ? "model-tuning-unavailable" : undefined}
              onCheckedChange={(value) => { setFast(value); if (value) setEffort("minimal"); setSaved(false); }}
              aria-label={t("settings.model.fast")}
            />
          </label>
          {mainChanged ? <span className="ml-auto text-[9.5px] text-warning">{t("settings.model.pendingDefault")}</span> : null}
        </div>
        {hasFixedReasoning ? (
          <p id="model-tuning-unavailable" className="text-[10px] leading-4 text-muted">
            {t("settings.model.fixedReasoning")}
          </p>
        ) : !tuningSupported ? (
          <p id="model-tuning-unavailable" className="text-[10px] leading-4 text-muted">
            {t("settings.model.tuningUnavailable")}
          </p>
        ) : null}
        <ModelCapabilitySettings
          providerId={providerId}
          modelId={modelId}
          metadata={selectedModel?.capabilities}
          locale={lang}
          copy={capabilityCopy}
          disabled={busy}
        />
        {failed ? <p className="text-[10.5px] text-danger" role="alert">{t("settings.model.saveFailed")}</p> : null}
      </section>

      <section className="max-w-4xl" aria-labelledby="auxiliary-models-title">
        <div className="mb-2">
          <h3 id="auxiliary-models-title" className="text-[12px] font-semibold text-foreground">{t("settings.model.auxiliaryTitle")}</h3>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">{t("settings.model.auxiliaryHint")}</p>
        </div>
        <ModelAssignmentRow
          main={main}
          assignment={config.modelAssignments?.worker}
          providers={config.providers}
          busy={busy}
          onChange={(worker) => void saveAssignment("worker", worker)}
        />
        <ModelAssignmentRow
          main={main}
          assignment={config.modelAssignments?.build}
          providers={config.providers}
          busy={busy}
          onChange={(build) => void saveAssignment("build", build)}
          labelKey="settings.model.build.label"
          badgeKey="settings.model.build.badge"
          descriptionKey="settings.model.build.description"
          dialogTitleKey="settings.model.build.dialogTitle"
          dialogDescriptionKey="settings.model.build.dialogDescription"
        />
        <ModelAssignmentRow
          main={main}
          assignment={config.modelAssignments?.polish}
          providers={config.providers}
          busy={busy}
          onChange={(polish) => void saveAssignment("polish", polish)}
          labelKey="settings.model.polish.label"
          badgeKey="settings.model.polish.badge"
          descriptionKey="settings.model.polish.description"
          dialogTitleKey="settings.model.polish.dialogTitle"
          dialogDescriptionKey="settings.model.polish.dialogDescription"
        />
        <ModelAssignmentRow
          main={main}
          assignment={config.modelAssignments?.plan}
          providers={config.providers}
          busy={busy}
          onChange={(plan) => void saveAssignment("plan", plan)}
          labelKey="settings.model.plan.label"
          badgeKey="settings.model.plan.badge"
          descriptionKey="settings.model.plan.description"
          dialogTitleKey="settings.model.plan.dialogTitle"
          dialogDescriptionKey="settings.model.plan.dialogDescription"
        />
        <ModelAssignmentRow
          main={main}
          assignment={config.modelAssignments?.deepreep}
          providers={config.providers}
          busy={busy}
          onChange={(deepreep) => void saveAssignment("deepreep", deepreep)}
          labelKey="settings.model.deepreep.label"
          badgeKey="settings.model.deepreep.badge"
          descriptionKey="settings.model.deepreep.description"
          dialogTitleKey="settings.model.deepreep.dialogTitle"
          dialogDescriptionKey="settings.model.deepreep.dialogDescription"
        />
      </section>

      <FallbackChainEditor
        main={main}
        values={config.modelAssignments?.fallbacks ?? []}
        providers={config.providers}
        busy={busy}
        onChange={(fallbacks) => void saveFallbacks(fallbacks)}
      />

      <TeamSettings config={config} onSaved={onSaved} />
      <PipelineSettings config={config} onSaved={onSaved} />
    </div>
  );
}
