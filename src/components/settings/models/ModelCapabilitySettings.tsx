import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui";
import { compactTokenCount, effectiveModelLimits, orderedModalities } from "@/lib/model-metadata";
import type {
  ModelCapabilityConfidence,
  ModelCapabilityMetadata,
  ModelCapabilitySource,
  ModelModality,
} from "@/lib/types";
import {
  getModelPreset,
  normalizeModelLimitOverride,
  setModelPreset,
  useModelPreset,
} from "@/store/model-presets";

export interface ModelCapabilitySettingsCopy {
  title: string;
  description: string;
  contextWindow: string;
  maxOutput: string;
  detected: string;
  overridePlaceholder: string;
  overrideActive: string;
  reset: string;
  invalidValue: string;
  unknown: string;
  inputModalities: string;
  outputModalities: string;
  features: string;
  featureTools: string;
  featureReasoning: string;
  featureStreaming: string;
  supported: string;
  unsupported: string;
  source: Record<ModelCapabilitySource, string>;
  confidence: Record<ModelCapabilityConfidence, string>;
  modality: Record<ModelModality, string>;
}

interface ModelCapabilitySettingsProps {
  providerId: string;
  modelId: string;
  metadata?: ModelCapabilityMetadata;
  locale: "en" | "ru";
  copy: ModelCapabilitySettingsCopy;
  disabled?: boolean;
  onOverrideChange?: (limits: { contextWindow?: number; maxOutput?: number }) => void;
}

function draftValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function ModelCapabilitySettings({
  providerId,
  modelId,
  metadata,
  locale,
  copy,
  disabled = false,
  onOverrideChange,
}: ModelCapabilitySettingsProps) {
  const preset = useModelPreset(providerId, modelId);
  const [contextDraft, setContextDraft] = useState(draftValue(preset.contextWindowOverride));
  const [outputDraft, setOutputDraft] = useState(draftValue(preset.maxOutputOverride));
  const [invalid, setInvalid] = useState<"contextWindow" | "maxOutput" | null>(null);
  const effective = effectiveModelLimits(metadata, preset);

  useEffect(() => {
    const current = getModelPreset(providerId, modelId);
    setContextDraft(draftValue(current.contextWindowOverride));
    setOutputDraft(draftValue(current.maxOutputOverride));
    setInvalid(null);
  }, [providerId, modelId]);

  const publish = (contextWindow: number | undefined, maxOutput: number | undefined) => {
    setModelPreset(providerId, modelId, { contextWindowOverride: contextWindow, maxOutputOverride: maxOutput });
    onOverrideChange?.({
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
    });
  };

  const commitContext = () => {
    const normalized = normalizeModelLimitOverride(contextDraft, "contextWindow");
    if (contextDraft.trim() && normalized === undefined) {
      setInvalid("contextWindow");
      return;
    }
    setInvalid(null);
    setContextDraft(draftValue(normalized));
    publish(normalized, preset.maxOutputOverride);
  };

  const commitOutput = () => {
    const normalized = normalizeModelLimitOverride(outputDraft, "maxOutput");
    if (outputDraft.trim() && normalized === undefined) {
      setInvalid("maxOutput");
      return;
    }
    setInvalid(null);
    setOutputDraft(draftValue(normalized));
    publish(preset.contextWindowOverride, normalized);
  };

  const reset = () => {
    setContextDraft("");
    setOutputDraft("");
    setInvalid(null);
    publish(undefined, undefined);
  };

  const renderModalities = (values: readonly ModelModality[] | undefined) => {
    const modalities = orderedModalities(values);
    return modalities.length
      ? modalities.map((value) => <span key={value} className="rounded border border-border-soft px-1.5 py-0.5">{copy.modality[value]}</span>)
      : <span>{copy.unknown}</span>;
  };

  return (
    <section className="max-w-4xl space-y-3" aria-labelledby="model-capability-settings-title">
      <div>
        <h3 id="model-capability-settings-title" className="text-[12px] font-semibold text-foreground">{copy.title}</h3>
        <p className="mt-1 text-[10.5px] leading-4 text-muted">{copy.description}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="flex items-center justify-between gap-3 text-[10.5px] text-muted">
            <span>{copy.contextWindow}</span>
            <span>{copy.detected}: {compactTokenCount(metadata?.limits?.contextWindow, locale)}</span>
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={256}
            max={100_000_000}
            step={1}
            value={contextDraft}
            disabled={disabled || !modelId}
            aria-invalid={invalid === "contextWindow"}
            placeholder={copy.overridePlaceholder}
            onChange={(event) => { setContextDraft(event.target.value); setInvalid(null); }}
            onBlur={commitContext}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            className="h-8 w-full rounded-md border border-border bg-surface px-2.5 font-mono text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
          />
        </label>
        <label className="space-y-1">
          <span className="flex items-center justify-between gap-3 text-[10.5px] text-muted">
            <span>{copy.maxOutput}</span>
            <span>{copy.detected}: {compactTokenCount(metadata?.limits?.maxOutput, locale)}</span>
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000_000}
            step={1}
            value={outputDraft}
            disabled={disabled || !modelId}
            aria-invalid={invalid === "maxOutput"}
            placeholder={copy.overridePlaceholder}
            onChange={(event) => { setOutputDraft(event.target.value); setInvalid(null); }}
            onBlur={commitOutput}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            className="h-8 w-full rounded-md border border-border bg-surface px-2.5 font-mono text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
          />
        </label>
      </div>

      {invalid ? <p className="text-[10px] text-danger" role="alert">{copy.invalidValue}</p> : null}

      <div className="grid gap-2 border-y border-border-soft py-3 text-[10px] text-muted sm:grid-cols-3">
        <div className="space-y-1">
          <span className="block font-medium text-secondary">{copy.inputModalities}</span>
          <span className="flex flex-wrap gap-1">{renderModalities(metadata?.modalities?.input)}</span>
        </div>
        <div className="space-y-1">
          <span className="block font-medium text-secondary">{copy.outputModalities}</span>
          <span className="flex flex-wrap gap-1">{renderModalities(metadata?.modalities?.output)}</span>
        </div>
        <div className="space-y-1">
          <span className="block font-medium text-secondary">{copy.features}</span>
          <span className="flex flex-wrap gap-x-2 gap-y-1">
            {(["tools", "reasoning", "streaming"] as const).map((feature) => {
              const value = metadata?.features?.[feature];
              const label = feature === "tools" ? copy.featureTools : feature === "reasoning" ? copy.featureReasoning : copy.featureStreaming;
              return <span key={feature}>{label}: {value === undefined ? copy.unknown : value ? copy.supported : copy.unsupported}</span>;
            })}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[9.5px] text-muted">
        <span>
          {copy.source[metadata?.provenance.source ?? "unknown"]} · {copy.confidence[metadata?.provenance.confidence ?? "unknown"]}
          {effective.contextSource === "override" || effective.outputSource === "override" ? ` · ${copy.overrideActive}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || (preset.contextWindowOverride === undefined && preset.maxOutputOverride === undefined)}
          onClick={reset}
        >
          <RotateCcw className="size-3" aria-hidden />
          {copy.reset}
        </Button>
      </div>
    </section>
  );
}
