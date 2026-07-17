import { Plus, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button, Input, Textarea } from "@/components/ui";
import { useI18n } from "@/i18n";
import type { PromptProfile } from "@/lib/types";
import {
  BUILTIN_PROMPT_PROFILE_IDS,
  createPromptProfile,
  mergeBuiltinPromptProfiles,
  type PromptProfilesDraft,
} from "./team-profile";

const SELECT_CLASS = "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50";

interface PromptProfilesEditorProps {
  draft: PromptProfilesDraft;
  disabled: boolean;
  onChange: (draft: PromptProfilesDraft) => void;
}

export function PromptProfilesEditor({ draft, disabled, onChange }: PromptProfilesEditorProps) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(() => draft.promptProfiles[0]?.id ?? "");
  const selected = useMemo(
    () => draft.promptProfiles.find((profile) => profile.id === selectedId) ?? draft.promptProfiles[0],
    [draft.promptProfiles, selectedId],
  );

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (!selected && selectedId) setSelectedId("");
  }, [selected, selectedId]);

  const updateSelected = (updater: (profile: PromptProfile) => PromptProfile) => {
    if (!selected) return;
    onChange({
      ...draft,
      promptProfiles: draft.promptProfiles.map((profile) => profile.id === selected.id ? updater(profile) : profile),
    });
  };

  const addProfile = () => {
    const next = createPromptProfile({
      name: `${t("settings.promptProfiles.title")} ${draft.promptProfiles.length + 1}`,
      existingIds: draft.promptProfiles.map((profile) => profile.id),
    });
    onChange({ ...draft, promptProfiles: [...draft.promptProfiles, next] });
    setSelectedId(next.id);
  };

  const deleteSelected = () => {
    if (!selected) return;
    const promptProfiles = draft.promptProfiles.filter((profile) => profile.id !== selected.id);
    const nextSelected = promptProfiles[0]?.id ?? "";
    onChange({
      promptProfiles,
      activePromptProfileId: draft.activePromptProfileId === selected.id ? "" : draft.activePromptProfileId,
    });
    setSelectedId(nextSelected);
  };

  const seedStarters = () => {
    const next = mergeBuiltinPromptProfiles(draft);
    onChange(next);
    if (!selectedId && next.promptProfiles[0]) setSelectedId(next.promptProfiles[0].id);
  };

  const useMainBuiltin = () => {
    const next = mergeBuiltinPromptProfiles(draft);
    onChange({
      ...next,
      activePromptProfileId: BUILTIN_PROMPT_PROFILE_IDS.main,
    });
    setSelectedId(BUILTIN_PROMPT_PROFILE_IDS.main);
  };

  return (
    <section className="max-w-4xl space-y-3 border-t border-border-soft pt-6" aria-labelledby="prompt-profile-settings-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
          <ShieldCheck className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="prompt-profile-settings-title" className="text-[12px] font-semibold text-foreground">
            {t("settings.promptProfiles.title")}
          </h3>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.promptProfiles.hint")}</p>
          <p className="mt-1 max-w-2xl text-[10px] leading-4 text-faint">{t("settings.promptProfiles.oobHint")}</p>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border-soft bg-surface/45 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="space-y-1">
          <span className="text-[10px] text-muted">{t("settings.promptProfiles.mainAssignment")}</span>
          <select
            value={draft.activePromptProfileId}
            disabled={disabled}
            className={SELECT_CLASS}
            onChange={(event) => onChange({ ...draft, activePromptProfileId: event.target.value })}
          >
            <option value="">{t("settings.promptProfiles.none")}</option>
            {draft.promptProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[10px] text-muted">{t("settings.promptProfiles.title")}</span>
          <select
            value={selected?.id ?? ""}
            disabled={disabled || draft.promptProfiles.length === 0}
            className={SELECT_CLASS}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {draft.promptProfiles.length === 0 ? <option value="">{t("settings.promptProfiles.none")}</option> : null}
            {draft.promptProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>

        <div className="flex flex-wrap items-end gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={seedStarters} title={t("settings.promptProfiles.seedStartersHint")}>
            <Sparkles className="size-3.5" aria-hidden />
            {t("settings.promptProfiles.seedStarters")}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={useMainBuiltin} title={t("settings.promptProfiles.useMainHint")}>
            {t("settings.promptProfiles.useMain")}
          </Button>
          <Button variant="outline" size="sm" disabled={disabled || draft.promptProfiles.length >= 64} onClick={addProfile}>
            <Plus className="size-3.5" aria-hidden />{t("settings.promptProfiles.add")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled || !selected}
            onClick={deleteSelected}
            aria-label={t("settings.promptProfiles.delete")}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {selected ? (
        <div className="grid gap-3 rounded-lg border border-border-soft bg-surface/35 p-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[10px] text-muted">{t("settings.promptProfiles.name")}</span>
            <Input
              value={selected.name}
              maxLength={120}
              disabled={disabled}
              onChange={(event) => updateSelected((profile) => ({ ...profile, name: event.target.value }))}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-muted">{t("settings.promptProfiles.description")}</span>
            <Input
              value={selected.description}
              maxLength={1_000}
              disabled={disabled}
              onChange={(event) => updateSelected((profile) => ({ ...profile, description: event.target.value }))}
            />
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="flex items-center justify-between gap-3 text-[10px] text-muted">
              <span>{t("settings.promptProfiles.systemPrompt")}</span>
              <span className="font-mono text-[9px] text-faint">{selected.systemPrompt.length}/20000</span>
            </span>
            <Textarea
              value={selected.systemPrompt}
              maxLength={20_000}
              disabled={disabled}
              className="min-h-28 resize-y font-mono text-[10.5px] leading-4"
              onChange={(event) => updateSelected((profile) => ({ ...profile, systemPrompt: event.target.value }))}
            />
            <span className="block text-[9.5px] leading-4 text-muted">{t("settings.promptProfiles.systemPromptHint")}</span>
          </label>
        </div>
      ) : null}
    </section>
  );
}
