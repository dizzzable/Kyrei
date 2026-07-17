import { Check, LoaderCircle, Plus, Search, Trash2, UsersRound, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button, Input, Switch, Textarea } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type { AppConfig, ModelRef, PromptProfile, SkillInfo, TeamOrchestrationConfig, TeamProfile, TeamProfileLimits, TeamRoleProfile } from "@/lib/types";
import { modelOptionsForProvider, selectableModelProviders } from "../models/model-options";
import { PromptProfilesEditor } from "./PromptProfilesEditor";
import {
  boundedInteger,
  cloneTeamOrchestration,
  createBuiltinCodingTeamProfile,
  createTeamProfile,
  createTeamRole,
  defaultTeamModel,
  isPromptProfilesDraftValid,
  mergeBuiltinPromptProfiles,
  promptProfilesFromEngine,
  reconcileTeamPromptAssignments,
  teamModeForWorkflow,
  withPromptProfiles,
  withTeamCapability,
  withTeamSkillSelection,
} from "./team-profile";

interface TeamSettingsProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

const SELECT_CLASS = "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50";

export function TeamSettings({ config, onSaved }: TeamSettingsProps) {
  const { t } = useI18n();
  const [promptDraft, setPromptDraft] = useState(() => promptProfilesFromEngine(config.engine));
  const [draft, setDraft] = useState(() => reconcileTeamPromptAssignments(
    config.orchestration,
    promptProfilesFromEngine(config.engine).promptProfiles.map((profile) => profile.id),
  ));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<SkillInfo[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<"loading" | "ready" | "error">("loading");
  const mainModel = useMemo<ModelRef>(() => ({
    providerId: config.activeProviderId,
    modelId: config.activeModelId,
  }), [config.activeModelId, config.activeProviderId]);

  useEffect(() => {
    const nextPrompts = promptProfilesFromEngine(config.engine);
    setPromptDraft(nextPrompts);
    setDraft(reconcileTeamPromptAssignments(
      config.orchestration,
      nextPrompts.promptProfiles.map((profile) => profile.id),
    ));
    setSaved(false);
  }, [config.engine, config.orchestration]);

  useEffect(() => {
    let alive = true;
    setSkillsStatus("loading");
    gateway.listSkills()
      .then(({ skills }) => {
        if (!alive) return;
        setEnabledSkills(skills
          .filter((skill) => skill.enabled)
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)));
        setSkillsStatus("ready");
      })
      .catch(() => {
        if (!alive) return;
        setEnabledSkills([]);
        setSkillsStatus("error");
      });
    return () => { alive = false; };
  }, []);

  const teamEnabled = draft.defaultMode !== "single";
  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId)
    ?? draft.profiles[0];
  const currentValue = useMemo(() => JSON.stringify(cloneTeamOrchestration(config.orchestration)), [config.orchestration]);
  const currentPromptValue = useMemo(() => JSON.stringify(promptProfilesFromEngine(config.engine)), [config.engine]);
  const dirty = JSON.stringify(draft) !== currentValue || JSON.stringify(promptDraft) !== currentPromptValue;
  const enabledSkillIds = useMemo(() => new Set(enabledSkills.map((skill) => skill.id)), [enabledSkills]);
  const invalid = !isPromptProfilesDraftValid(promptDraft) || (teamEnabled && !activeProfile) || draft.profiles.some((profile) => (
    !profile.name.trim()
    || profile.roles.length === 0
    || (profile.enabled && profile.roles.some((role) => {
      const provider = config.providers.find((candidate) => candidate.id === role.model?.providerId);
      return !role.name.trim()
        || !role.model?.modelId
        || (skillsStatus === "ready" && role.skillIds.some((id) => !enabledSkillIds.has(id)))
        || !provider?.enabled
        || (provider.requiresApiKey && !provider.hasKey)
        || !provider.models.some((model) => model.id === role.model?.modelId);
    }))
  ));

  const changeDraft = (updater: (current: TeamOrchestrationConfig) => TeamOrchestrationConfig) => {
    setDraft((current) => updater(cloneTeamOrchestration(current)));
    setSaved(false);
    setFailed(false);
  };

  const changePromptDraft = (next: typeof promptDraft) => {
    setPromptDraft(next);
    const available = next.promptProfiles.map((profile) => profile.id);
    setDraft((current) => reconcileTeamPromptAssignments(current, available));
    setSaved(false);
    setFailed(false);
  };

  const updateActiveProfile = (updater: (profile: TeamProfile) => TeamProfile) => {
    if (!activeProfile) return;
    changeDraft((current) => ({
      ...current,
      profiles: current.profiles.map((profile) => profile.id === activeProfile.id
        ? { ...updater(profile), enabled: true, disabledReason: undefined }
        : profile),
    }));
  };

  const addProfile = () => {
    changeDraft((current) => {
      const profile = createTeamProfile({
        name: t("settings.team.defaultProfile", { count: current.profiles.length + 1 }),
        initialRoleName: t("settings.team.defaultRole", { count: 1 }),
        model: defaultTeamModel(config.providers, mainModel),
        existingIds: current.profiles.map((candidate) => candidate.id),
      });
      return {
        ...current,
        activeProfileId: profile.id,
        profiles: [...current.profiles, profile],
        defaultMode: current.defaultMode === "single" ? "single" : teamModeForWorkflow(profile.workflow),
      };
    });
  };

  const toggleTeam = (enabled: boolean) => {
    // Ensure starter prompts exist when enabling Team for the first time.
    if (enabled) {
      setPromptDraft((current) => mergeBuiltinPromptProfiles(current));
    }
    changeDraft((current) => {
      let profiles = current.profiles;
      let profile = profiles.find((candidate) => candidate.id === current.activeProfileId) ?? profiles[0];
      if (enabled && !profile) {
        // OOB: full coding team (researcher / critic / architect), not a blank role.
        profile = createBuiltinCodingTeamProfile(defaultTeamModel(config.providers, mainModel));
        profiles = [profile];
      } else if (enabled && profile) {
        profiles = profiles.map((candidate) => candidate.id === profile?.id
          ? { ...candidate, enabled: true, disabledReason: undefined }
          : candidate);
      }
      return {
        ...current,
        profiles,
        activeProfileId: profile?.id ?? "",
        defaultMode: enabled && profile ? teamModeForWorkflow(profile.workflow) : "single",
      };
    });
  };

  const deleteActiveProfile = () => {
    if (!activeProfile) return;
    changeDraft((current) => {
      const profiles = current.profiles.filter((profile) => profile.id !== activeProfile.id);
      const nextActive = profiles[0];
      return {
        ...current,
        profiles,
        activeProfileId: nextActive?.id ?? "",
        defaultMode: !nextActive || current.defaultMode === "single"
          ? "single"
          : teamModeForWorkflow(nextActive.workflow),
      };
    });
  };

  const save = async () => {
    if (!dirty || invalid) return;
    setBusy(true);
    setFailed(false);
    try {
      const submitted = cloneTeamOrchestration(draft);
      const submittedEngine = withPromptProfiles(config.engine, promptDraft);
      const response = await gateway.setConfig({ orchestration: submitted, engine: submittedEngine });
      const next = response.orchestration ? response : { ...response, orchestration: submitted };
      const nextPromptDraft = promptProfilesFromEngine(next.engine ?? submittedEngine);
      setPromptDraft(nextPromptDraft);
      setDraft(reconcileTeamPromptAssignments(
        next.orchestration,
        nextPromptDraft.promptProfiles.map((profile) => profile.id),
      ));
      onSaved(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1400);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const mainProvider = config.providers.find((provider) => provider.id === config.activeProviderId);
  const mainModelLabel = mainProvider?.models.find((model) => model.id === config.activeModelId)?.name
    ?? config.activeModelId;

  return (
    <>
      <PromptProfilesEditor draft={promptDraft} disabled={busy} onChange={changePromptDraft} />
      <section className="max-w-4xl space-y-4 border-t border-border-soft pt-6" aria-labelledby="team-settings-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
          <UsersRound className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="team-settings-title" className="text-[12px] font-semibold text-foreground">{t("settings.team.title")}</h3>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.team.hint")}</p>
        </div>
        <div className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
          <span>{teamEnabled ? t("settings.team.on") : t("settings.team.off")}</span>
          <Switch checked={teamEnabled} disabled={busy} onCheckedChange={toggleTeam} aria-label={t("settings.team.toggle")} />
        </div>
      </div>

      <div className="rounded-lg border border-border-soft bg-surface/45">
        <div className="grid gap-3 border-b border-border-soft p-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-elevated text-muted"><Workflow className="size-3.5" aria-hidden /></span>
            <span className="min-w-0">
              <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted">{t("settings.team.orchestrator")}</span>
              <span className="mt-0.5 block truncate text-[11px] text-foreground">
                {mainProvider?.name ?? config.activeProviderName} / {mainModelLabel}
              </span>
            </span>
          </div>
          <p className="self-center text-[9.5px] text-muted">{t("settings.team.orchestratorHint")}</p>
        </div>

        <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
          <label className="space-y-1">
            <span className="text-[10px] text-muted">{t("settings.team.activeProfile")}</span>
            <select
              value={activeProfile?.id ?? ""}
              disabled={busy || draft.profiles.length === 0}
              onChange={(event) => changeDraft((current) => {
                const profile = current.profiles.find((candidate) => candidate.id === event.target.value);
                return {
                  ...current,
                  activeProfileId: event.target.value,
                  profiles: current.profiles.map((candidate) => candidate.id === profile?.id
                    ? { ...candidate, enabled: true, disabledReason: undefined }
                    : candidate),
                  defaultMode: current.defaultMode === "single" || !profile
                    ? current.defaultMode
                    : teamModeForWorkflow(profile.workflow),
                };
              })}
              className={SELECT_CLASS}
            >
              {draft.profiles.length === 0 ? <option value="">{t("settings.team.noProfiles")}</option> : null}
              {draft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button variant="outline" size="sm" disabled={busy} onClick={addProfile}>
              <Plus className="size-3.5" aria-hidden />{t("settings.team.addProfile")}
            </Button>
          </div>
          <div className="flex items-end">
            <Button variant="ghost" size="icon-sm" disabled={busy || !activeProfile} onClick={deleteActiveProfile} aria-label={t("settings.team.deleteProfile")}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>

      {activeProfile ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
            <label className="space-y-1">
              <span className="text-[10px] text-muted">{t("settings.team.profileName")}</span>
              <Input
                value={activeProfile.name}
                disabled={busy}
                placeholder={t("settings.team.profileNamePlaceholder")}
                onChange={(event) => updateActiveProfile((profile) => ({ ...profile, name: event.target.value }))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-muted">{t("settings.team.workflow")}</span>
              <select
                value={activeProfile.workflow}
                disabled={busy}
                className={SELECT_CLASS}
                onChange={(event) => {
                  const workflow = event.target.value as TeamProfile["workflow"];
                  changeDraft((current) => ({
                    ...current,
                    defaultMode: current.defaultMode === "single" ? "single" : teamModeForWorkflow(workflow),
                    profiles: current.profiles.map((profile) => profile.id === activeProfile.id
                      ? { ...profile, workflow, enabled: true, disabledReason: undefined }
                      : profile),
                  }));
                }}
              >
                <option value="supervisor">{t("settings.team.workflow.supervisor")}</option>
                <option value="consensus">{t("settings.team.workflow.consensus")}</option>
              </select>
            </label>
          </div>

          <TeamLimits
            limits={activeProfile.limits}
            disabled={busy}
            onChange={(limits) => updateActiveProfile((profile) => ({ ...profile, limits }))}
          />

          <section className="rounded-md border border-border-soft bg-bg/30 px-3 py-2.5" aria-labelledby="team-research-workflow-title">
            <h4 id="team-research-workflow-title" className="text-[10.5px] font-medium text-secondary">{t("settings.team.research.title")}</h4>
            <p className="mt-0.5 text-[9.5px] leading-4 text-muted">{t("settings.team.research.hint")}</p>
            <ol className="mt-2 grid gap-1.5 text-[9.5px] leading-4 text-muted md:grid-cols-4">
              {([
                "settings.team.research.local",
                "settings.team.research.discover",
                "settings.team.research.verify",
                "settings.team.research.report",
              ] as const).map((key, index) => (
                <li key={key} className="flex min-w-0 gap-1.5">
                  <span className="font-mono text-primary">{index + 1}.</span>
                  <span>{t(key)}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 border-t border-border-soft pt-2 text-[9px] leading-4 text-faint">{t("settings.team.research.economy")}</p>
          </section>

          <div className="space-y-2">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h4 className="text-[11px] font-semibold text-foreground">{t("settings.team.roles")}</h4>
                <p className="mt-0.5 text-[9.5px] leading-4 text-muted">{t("settings.team.rolesHint")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => updateActiveProfile((profile) => ({
                  ...profile,
                  roles: [...profile.roles, createTeamRole({
                    name: t("settings.team.defaultRole", { count: profile.roles.length + 1 }),
                    model: defaultTeamModel(config.providers, mainModel),
                    existingIds: profile.roles.map((role) => role.id),
                  })],
                }))}
              >
                <Plus className="size-3.5" aria-hidden />{t("settings.team.addRole")}
              </Button>
            </div>

            {activeProfile.roles.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-[10.5px] text-muted">
                {t("settings.team.emptyRoles")}
              </div>
            ) : activeProfile.roles.map((role, index) => (
              <TeamRoleRow
                key={`${activeProfile.id}:${role.id}`}
                role={role}
                index={index}
                providers={config.providers}
                promptProfiles={promptDraft.promptProfiles}
                enabledSkills={enabledSkills}
                skillsStatus={skillsStatus}
                disabled={busy}
                onChange={(nextRole) => updateActiveProfile((profile) => ({
                  ...profile,
                  roles: profile.roles.map((candidate) => candidate.id === role.id ? nextRole : candidate),
                }))}
                onDelete={() => updateActiveProfile((profile) => ({
                  ...profile,
                  roles: profile.roles.filter((candidate) => candidate.id !== role.id),
                }))}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[10.5px] text-muted">
          {t("settings.team.emptyHint")}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-border-soft pt-3">
        {invalid ? <p className="mr-auto text-[10px] text-warning" role="status">{t("settings.team.incomplete")}</p> : null}
        {failed ? <p className="mr-auto text-[10px] text-danger" role="alert">{t("settings.team.saveFailed")}</p> : null}
        <Button disabled={busy || !dirty || invalid} onClick={() => void save()}>
          {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {!busy && saved ? <Check className="size-3.5" aria-hidden /> : null}
          {saved ? t("settings.saved") : t("common.save")}
        </Button>
      </div>
      </section>
    </>
  );
}

function TeamLimits({
  limits,
  disabled,
  onChange,
}: {
  limits: TeamProfileLimits;
  disabled: boolean;
  onChange: (limits: TeamProfileLimits) => void;
}) {
  const { t } = useI18n();
  const fields: Array<{ key: "maxParallel" | "maxDepth" | "maxAgents" | "maxTasks"; label: string; min: number; max: number }> = [
    { key: "maxParallel", label: t("settings.team.limits.parallel"), min: 1, max: 16 },
    { key: "maxDepth", label: t("settings.team.limits.depth"), min: 0, max: 2 },
    { key: "maxAgents", label: t("settings.team.limits.agents"), min: 1, max: 64 },
    { key: "maxTasks", label: t("settings.team.limits.tasks"), min: 1, max: 64 },
  ];
  return (
    <fieldset className="rounded-md border border-border-soft p-3">
      <legend className="px-1 text-[10px] font-medium text-secondary">{t("settings.team.limits")}</legend>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {fields.map((field) => (
          <label key={field.key} className="space-y-1">
            <span className="text-[9.5px] text-muted">{field.label}</span>
            <Input
              type="number"
              min={field.min}
              max={field.max}
              value={limits[field.key]}
              disabled={disabled}
              className="font-mono text-[11px]"
              onChange={(event) => {
                const value = boundedInteger(event.target.value, field.min, field.max);
                const next = { ...limits, [field.key]: value };
                next.maxParallel = Math.min(next.maxParallel, next.maxAgents, next.maxTasks);
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SkillMultiSelect({
  skills,
  selectedIds,
  status,
  disabled,
  onToggle,
}: {
  skills: readonly SkillInfo[];
  selectedIds: readonly string[];
  status: "loading" | "ready" | "error";
  disabled: boolean;
  onToggle: (skillId: string, selected: boolean) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const skillsById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => !normalized
      || `${skill.name}\n${skill.description}\n${skill.id}\n${skill.provenance}`
        .toLocaleLowerCase()
        .includes(normalized));
  }, [query, skills]);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[9.5px] text-muted">{t("settings.team.skills")}</span>
        <span className="text-[8.5px] text-faint">{t("settings.team.skillsSelected", { count: selectedIds.length })}</span>
      </div>
      <div className="rounded-md border border-border-soft bg-bg/35 p-2">
        {selectedIds.length ? (
          <div className="mb-2 flex flex-wrap gap-1" aria-label={t("settings.team.skillsSelected", { count: selectedIds.length })}>
            {selectedIds.map((id) => {
              const skill = skillsById.get(id);
              const name = skill?.name ?? t("settings.team.skillUnavailable");
              return (
                <span
                  key={id}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-border-soft bg-elevated px-1.5 py-1 text-[9px] text-secondary"
                  title={id}
                >
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    className="shrink-0 text-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => onToggle(id, false)}
                    aria-label={t("settings.team.skillRemove", { name })}
                  >
                    <X className="size-2.5" aria-hidden />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
        <label className="relative block">
          <span className="sr-only">{t("settings.team.skillsSearch")}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={query}
            disabled={disabled || status !== "ready"}
            placeholder={t("settings.team.skillsPlaceholder")}
            className="pl-8 text-[10px]"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="mt-1.5 text-[8.5px] leading-3 text-faint">{t("settings.team.skillsHint")}</p>
        {status === "loading" ? (
          <p className="mt-2 flex items-center gap-1.5 text-[9px] text-muted" role="status">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />{t("settings.team.skillsLoading")}
          </p>
        ) : status === "error" ? (
          <p className="mt-2 text-[9px] text-danger" role="alert">{t("settings.team.skillsLoadFailed")}</p>
        ) : skills.length === 0 ? (
          <p className="mt-2 text-[9px] text-muted">{t("settings.team.skillsEmpty")}</p>
        ) : matches.length === 0 ? (
          <p className="mt-2 text-[9px] text-muted">{t("settings.team.skillsNoMatch")}</p>
        ) : (
          <div
            className="mt-2 max-h-28 overflow-y-auto rounded border border-border-soft bg-surface/55 p-1"
            role="listbox"
            aria-multiselectable="true"
            aria-label={t("settings.team.skills")}
          >
            {matches.map((skill) => {
              const checked = selected.has(skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  disabled={disabled}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => onToggle(skill.id, !checked)}
                >
                  <span className="grid size-3.5 shrink-0 place-items-center rounded border border-border text-primary">
                    {checked ? <Check className="size-2.5" aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[9.5px] text-secondary">{skill.name}</span>
                    <span className="block truncate font-mono text-[8px] text-faint" title={skill.id}>{skill.id}</span>
                  </span>
                  <span className="shrink-0 text-[8px] text-faint">{skillProvenanceLabel(skill.provenance, t)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function skillProvenanceLabel(
  provenance: SkillInfo["provenance"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (provenance) {
    case "workspace": return t("settings.skills.workspace");
    case "custom": return t("settings.skills.custom");
    case "kiro": return t("settings.skills.documentKiro");
    default: return t("settings.skills.global");
  }
}

function TeamRoleRow({
  role,
  index,
  providers,
  promptProfiles,
  enabledSkills,
  skillsStatus,
  disabled,
  onChange,
  onDelete,
}: {
  role: TeamRoleProfile;
  index: number;
  providers: AppConfig["providers"];
  promptProfiles: readonly PromptProfile[];
  enabledSkills: readonly SkillInfo[];
  skillsStatus: "loading" | "ready" | "error";
  disabled: boolean;
  onChange: (role: TeamRoleProfile) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const providerOptions = selectableModelProviders(providers, role.model?.providerId);
  const models = modelOptionsForProvider(providerOptions, role.model?.providerId ?? "");
  const toggleCapability = (capability: "workspace.read" | "web" | "memory.read", enabled: boolean) => {
    onChange({
      ...role,
      capabilities: withTeamCapability(role.capabilities, capability, enabled),
    });
  };
  return (
    <article className="rounded-md border border-border-soft bg-surface/55 p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded bg-elevated font-mono text-[9px] text-muted">{index + 1}</span>
        <span className="text-[10px] font-medium text-secondary">{t("settings.team.role")}</span>
        <Button variant="ghost" size="icon-xs" disabled={disabled} onClick={onDelete} className="ml-auto" aria-label={t("settings.team.deleteRole", { count: index + 1 })}>
          <Trash2 className="size-3" aria-hidden />
        </Button>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1">
          <span className="text-[9.5px] text-muted">{t("settings.team.roleName")}</span>
          <Input value={role.name} disabled={disabled} placeholder={t("settings.team.roleNamePlaceholder")} onChange={(event) => onChange({ ...role, name: event.target.value })} />
        </label>
        <label className="space-y-1 xl:col-span-1">
          <span className="text-[9.5px] text-muted">{t("settings.team.roleDescription")}</span>
          <Input value={role.description} disabled={disabled} placeholder={t("settings.team.roleDescriptionPlaceholder")} onChange={(event) => onChange({ ...role, description: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-[9.5px] text-muted">{t("settings.model.provider")}</span>
          <select
            value={role.model?.providerId ?? ""}
            disabled={disabled || providerOptions.length === 0}
            className={SELECT_CLASS}
            onChange={(event) => {
              const modelId = modelOptionsForProvider(providerOptions, event.target.value)[0]?.id ?? "";
              onChange({ ...role, model: { providerId: event.target.value, modelId } });
            }}
          >
            {providerOptions.length === 0 ? <option value="">{t("settings.team.noProvider")}</option> : null}
            {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[9.5px] text-muted">{t("settings.model.model")}</span>
          <select
            value={role.model?.modelId ?? ""}
            disabled={disabled || models.length === 0}
            className={`${SELECT_CLASS} font-mono`}
            onChange={(event) => onChange({
              ...role,
              model: { providerId: role.model?.providerId ?? "", modelId: event.target.value },
            })}
          >
            {models.length === 0 ? <option value="">{t("settings.team.noModel")}</option> : null}
            {models.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-2 block space-y-1">
        <span className="text-[9.5px] text-muted">{t("settings.team.instructions")}</span>
        <Textarea
          value={role.instructions}
          disabled={disabled}
          placeholder={t("settings.team.instructionsPlaceholder")}
          className="min-h-14 resize-y text-[10.5px] leading-4"
          onChange={(event) => onChange({ ...role, instructions: event.target.value })}
        />
      </label>
      <label className="mt-2 block max-w-sm space-y-1">
        <span className="text-[9.5px] text-muted">{t("settings.promptProfiles.roleAssignment")}</span>
        <select
          value={role.promptProfileId ?? ""}
          disabled={disabled}
          className={SELECT_CLASS}
          onChange={(event) => onChange({
            ...role,
            promptProfileId: event.target.value || undefined,
          })}
        >
          <option value="">{t("settings.promptProfiles.none")}</option>
          {promptProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      <div className="mt-2">
        <SkillMultiSelect
          skills={enabledSkills}
          selectedIds={role.skillIds}
          status={skillsStatus}
          disabled={disabled}
          onToggle={(skillId, selected) => onChange(withTeamSkillSelection(role, skillId, selected))}
        />
      </div>
      <div className="mt-2 grid items-end gap-2 xl:grid-cols-[minmax(0,1fr)_auto_8rem]">
        <fieldset className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border-soft px-2.5 py-1">
          <legend className="sr-only">{t("settings.team.access")}</legend>
          {([
            ["workspace.read", "settings.team.capability.workspace"],
            ["web", "settings.team.capability.web"],
            ["memory.read", "settings.team.capability.memory"],
          ] as const).map(([capability, label]) => {
            const checked = role.capabilities.includes(capability);
            const isOnlyCapability = checked && role.capabilities.length === 1;
            return (
              <label key={capability} className="inline-flex items-center gap-1.5 whitespace-nowrap text-[9.5px] text-secondary">
                <Switch
                  size="xs"
                  checked={checked}
                  disabled={disabled || isOnlyCapability}
                  onCheckedChange={(enabled) => toggleCapability(capability, enabled)}
                  aria-label={t(label)}
                />
                <span>{t(label)}</span>
              </label>
            );
          })}
        </fieldset>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border-soft px-2.5 text-[10px] text-secondary">
          <Switch
            size="xs"
            checked={role.canSpawn}
            disabled={disabled}
            onCheckedChange={(canSpawn) => onChange({
              ...role,
              canSpawn,
              maxChildren: canSpawn ? Math.max(1, role.maxChildren) : 0,
              capabilities: withTeamCapability(role.capabilities, "delegate", canSpawn),
            })}
            aria-label={t("settings.team.canSpawn")}
          />
          <span>{t("settings.team.canSpawn")}</span>
        </label>
        <label className="space-y-1">
          <span className="text-[9.5px] text-muted">{t("settings.team.maxChildren")}</span>
          <Input
            type="number"
            min={1}
            max={12}
            value={role.maxChildren}
            disabled={disabled || !role.canSpawn}
            className="font-mono text-[11px]"
            onChange={(event) => onChange({ ...role, maxChildren: boundedInteger(event.target.value, 1, 12) })}
          />
        </label>
      </div>
    </article>
  );
}
