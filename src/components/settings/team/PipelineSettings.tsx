import { Check, GitBranch, LoaderCircle, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button, Input, Switch } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type {
  AppConfig,
  PipelineDefinition,
  PipelineLimits,
  PipelinesConfig,
  PipelineStageDefinition,
} from "@/lib/types";

interface PipelineSettingsProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

const EMPTY_PIPELINES: PipelinesConfig = { version: 1, generation: 0, definitions: [] };
const DEFAULT_LIMITS: PipelineLimits = {
  maxInputTokens: 1_000_000,
  maxOutputTokens: 250_000,
  maxTotalTokens: 1_250_000,
  maxCalls: 256,
  maxCostUsd: 100,
  maxWallTimeMs: 14_400_000,
  maxRepairCycles: 3,
  maxAssistanceRequests: 12,
  maxConcurrency: 4,
};
const SELECT_CLASS = "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50";

function clonePipelines(value?: PipelinesConfig): PipelinesConfig {
  return JSON.parse(JSON.stringify(value ?? EMPTY_PIPELINES)) as PipelinesConfig;
}

function uniquePipelineId(definitions: PipelineDefinition[]): string {
  const known = new Set(definitions.map((definition) => definition.id));
  if (!known.has("coding-product")) return "coding-product";
  let suffix = 2;
  while (known.has(`coding-product-${suffix}`)) suffix += 1;
  return `coding-product-${suffix}`;
}

export function PipelineSettings({ config, onSaved }: PipelineSettingsProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => clonePipelines(config.pipelines));
  const [selectedId, setSelectedId] = useState(() => config.pipelines?.definitions[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const profiles = useMemo(
    () => (config.orchestration?.profiles ?? []).filter((profile) => profile.enabled),
    [config.orchestration?.profiles],
  );

  useEffect(() => {
    const next = clonePipelines(config.pipelines);
    setDraft(next);
    setSelectedId((current) => next.definitions.some((definition) => definition.id === current)
      ? current
      : next.definitions[0]?.id ?? "");
    setSaved(false);
  }, [config.pipelines]);

  const selected = draft.definitions.find((definition) => definition.id === selectedId)
    ?? draft.definitions[0];
  const persisted = useMemo(() => clonePipelines(config.pipelines), [config.pipelines]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(persisted);
  const invalid = draft.definitions.some((definition) => (
    !definition.name.trim()
    || definition.stages.some((stage) => stage.kind === "department" && !profiles.some((profile) => profile.id === stage.teamProfileId))
    || definition.limits.maxConcurrency > definition.limits.maxCalls
    || definition.limits.maxInputTokens > definition.limits.maxTotalTokens
    || definition.limits.maxOutputTokens > definition.limits.maxTotalTokens
  ));

  const changeDraft = (updater: (current: PipelinesConfig) => PipelinesConfig) => {
    setDraft((current) => updater(clonePipelines(current)));
    setSaved(false);
    setFailed(false);
  };

  const updateSelected = (updater: (definition: PipelineDefinition) => PipelineDefinition) => {
    if (!selected) return;
    changeDraft((current) => ({
      ...current,
      definitions: current.definitions.map((definition) => definition.id === selected.id
        ? updater(definition)
        : definition),
    }));
  };

  const createDefault = () => {
    const profileId = profiles[0]?.id;
    if (!profileId) return;
    const id = uniquePipelineId(draft.definitions);
    const retry = { maxAttempts: 1, backoffMs: 1_000 };
    const department = (
      stageId: string,
      name: string,
      dependsOn: string[],
      allowedHelpFrom: string[],
    ): PipelineStageDefinition => ({
      id: stageId,
      name,
      kind: "department",
      teamProfileId: profileId,
      dependsOn,
      allowedHelpFrom,
      retry: { ...retry, maxAttempts: 2 },
    });
    const definition: PipelineDefinition = {
      id,
      name: t("settings.pipeline.defaultName"),
      revision: 1,
      enabled: true,
      stages: [
        department("research", t("settings.pipeline.stage.research"), [], []),
        department("planning", t("settings.pipeline.stage.planning"), ["research"], ["research"]),
        {
          id: "approve-plan",
          name: t("settings.pipeline.stage.approval"),
          kind: "approval",
          dependsOn: ["planning"],
          allowedHelpFrom: [],
          retry,
        },
        department("implementation", t("settings.pipeline.stage.execution"), ["approve-plan"], ["research", "planning"]),
        {
          id: "approve-implementation",
          name: t("settings.pipeline.stage.approval"),
          kind: "approval",
          dependsOn: ["implementation"],
          allowedHelpFrom: [],
          retry,
        },
        {
          id: "apply-changes",
          name: t("settings.pipeline.stage.action"),
          kind: "action",
          action: "workspace.apply",
          dependsOn: ["approve-implementation"],
          allowedHelpFrom: [],
          retry,
        },
        department("verification", t("settings.pipeline.stage.verification"), ["apply-changes"], ["research"]),
        {
          id: "acceptance",
          name: t("settings.pipeline.stage.truthGate"),
          kind: "truth-gate",
          dependsOn: ["verification"],
          allowedHelpFrom: [],
          retry,
          checks: [{ id: "unit", command: "npm test --silent", ecosystem: "node" }],
        },
      ],
      limits: { ...DEFAULT_LIMITS },
    };
    changeDraft((current) => ({ ...current, definitions: [...current.definitions, definition] }));
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (!selected) return;
    changeDraft((current) => {
      const definitions = current.definitions.filter((definition) => definition.id !== selected.id);
      setSelectedId(definitions[0]?.id ?? "");
      return { ...current, definitions };
    });
  };

  const updateLimit = (key: keyof PipelineLimits, raw: string) => {
    const value = key === "maxCostUsd" ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return;
    updateSelected((definition) => ({
      ...definition,
      limits: { ...definition.limits, [key]: Math.max(0, value) },
    }));
  };

  const save = async () => {
    if (!dirty || invalid) return;
    setBusy(true);
    setFailed(false);
    try {
      const submitted = clonePipelines(draft);
      submitted.definitions = submitted.definitions.map((definition) => {
        const previous = persisted.definitions.find((candidate) => candidate.id === definition.id);
        if (!previous || JSON.stringify(previous) === JSON.stringify(definition)) return definition;
        return { ...definition, revision: previous.revision + 1 };
      });
      const next = await gateway.setConfig({ pipelines: submitted });
      setDraft(clonePipelines(next.pipelines));
      onSaved(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1_400);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="max-w-4xl space-y-4 border-t border-border-soft pt-6" aria-labelledby="pipeline-settings-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
          <GitBranch className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="pipeline-settings-title" className="text-[12px] font-semibold text-foreground">{t("settings.pipeline.title")}</h3>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.pipeline.hint")}</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy || profiles.length === 0} onClick={createDefault}>
          <Plus className="size-3.5" aria-hidden />{t("settings.pipeline.add")}
        </Button>
      </div>

      {profiles.length === 0 ? (
        <p className="rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-[10.5px] text-warning">
          {t("settings.pipeline.needsTeams")}
        </p>
      ) : null}

      {selected ? (
        <div className="space-y-4 rounded-lg border border-border-soft bg-surface/35 p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem_auto]">
            <label className="space-y-1">
              <span className="text-[10px] text-muted">{t("settings.pipeline.name")}</span>
              <Input value={selected.name} disabled={busy} onChange={(event) => updateSelected((definition) => ({ ...definition, name: event.target.value }))} />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-muted">{t("settings.pipeline.active")}</span>
              <select value={selected.id} disabled={busy} onChange={(event) => setSelectedId(event.target.value)} className={SELECT_CLASS}>
                {draft.definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Switch checked={selected.enabled} disabled={busy} onCheckedChange={(enabled) => updateSelected((definition) => ({ ...definition, enabled }))} aria-label={t("settings.pipeline.enabled")} />
              <Button variant="ghost" size="icon-sm" disabled={busy} onClick={deleteSelected} aria-label={t("settings.pipeline.delete")}>
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted">{t("settings.pipeline.departments")}</span>
              <span className="text-[9.5px] text-muted">{t("settings.pipeline.revision", { count: selected.revision })}</span>
            </div>
            <div className="divide-y divide-border-soft rounded-md border border-border-soft">
              {selected.stages.map((stage, index) => (
                <div key={stage.id} className="grid items-center gap-2 px-2.5 py-2 md:grid-cols-[1.25rem_minmax(0,1fr)_minmax(10rem,15rem)]">
                  <span className="grid size-5 place-items-center rounded bg-elevated text-[9px] text-muted">{index + 1}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[10.5px] font-medium text-secondary">{stage.name}</span>
                    <span className="block text-[9px] text-muted">{t(`settings.pipeline.kind.${stage.kind}`)}</span>
                  </span>
                  {stage.kind === "department" ? (
                    <select
                      value={stage.teamProfileId ?? ""}
                      disabled={busy}
                      onChange={(event) => updateSelected((definition) => ({
                        ...definition,
                        stages: definition.stages.map((candidate) => candidate.id === stage.id
                          ? { ...candidate, teamProfileId: event.target.value }
                          : candidate),
                      }))}
                      className={SELECT_CLASS}
                      aria-label={t("settings.pipeline.departmentFor", { name: stage.name })}
                    >
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  ) : (
                    <span className="inline-flex items-center justify-end gap-1.5 text-[9.5px] text-muted">
                      <ShieldCheck className="size-3" aria-hidden />{t("settings.pipeline.deterministic")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-2 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted">{t("settings.pipeline.budgets")}</span>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {([
                ["maxTotalTokens", "settings.pipeline.limit.tokens"],
                ["maxCalls", "settings.pipeline.limit.calls"],
                ["maxCostUsd", "settings.pipeline.limit.cost"],
                ["maxConcurrency", "settings.pipeline.limit.concurrency"],
                ["maxRepairCycles", "settings.pipeline.limit.repairs"],
              ] as const).map(([key, label]) => (
                <label key={key} className="space-y-1">
                  <span className="text-[9.5px] text-muted">{t(label)}</span>
                  <Input type="number" min={key === "maxRepairCycles" ? 0 : key === "maxCostUsd" ? 0.01 : 1} step={key === "maxCostUsd" ? 0.01 : 1} value={selected.limits[key]} disabled={busy} onChange={(event) => updateLimit(key, event.target.value)} />
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-border-soft bg-surface/35 px-3 py-4 text-center text-[10.5px] text-muted">{t("settings.pipeline.empty")}</p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-[9.5px] leading-4 text-muted">{t("settings.pipeline.safety")}</p>
        <Button disabled={busy || !dirty || invalid} onClick={() => void save()}>
          {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {!busy && saved ? <Check className="size-3.5" aria-hidden /> : null}
          {saved ? t("settings.saved") : t("settings.save")}
        </Button>
      </div>
      {invalid ? <p className="text-[10.5px] text-warning">{t("settings.pipeline.invalid")}</p> : null}
      {failed ? <p className="text-[10.5px] text-danger" role="alert">{t("settings.pipeline.saveFailed")}</p> : null}
    </section>
  );
}
