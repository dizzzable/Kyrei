import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, FolderOpen, Plus, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  Textarea,
} from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type { SkillInfo, SkillProvenance, SkillRoot } from "@/lib/types";
import { cn } from "@/lib/utils";

type SkillsCuratorPreview = {
  fileName: string;
  status?: string;
  at?: string;
  via?: string;
  proposalCount?: number;
  preview?: Array<{
    id?: string;
    skillId?: string;
    skillName?: string;
    action?: string;
    kind?: string;
    reason?: string;
    detail?: string;
    owned?: boolean;
    patchSummary?: string;
    suggestedDescription?: string;
    hasContentPatch?: boolean;
  }>;
};

export function SkillsSettings({
  workspace,
  getEngineField,
  setEngineField,
}: {
  workspace: string;
  getEngineField?: (path: string, fallback: unknown) => unknown;
  setEngineField?: (path: string, value: unknown, persistImmediately?: boolean) => void;
}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [roots, setRoots] = useState<SkillRoot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillInfo | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [curatorBusy, setCuratorBusy] = useState(false);
  const [curatorMsg, setCuratorMsg] = useState<string | null>(null);
  const [curatorProposals, setCuratorProposals] = useState<SkillsCuratorPreview[]>([]);

  const curatorEnabled = Boolean(getEngineField?.("skills.curator.enabled", false));
  const curatorApplyMode = String(getEngineField?.("skills.curator.applyMode", "propose") || "propose") === "apply_safe"
    ? "apply_safe"
    : "propose";
  const staleDays = Number(getEngineField?.("skills.curator.staleDays", 90) ?? 90);
  const curatorUseLlm = Boolean(getEngineField?.("skills.curator.useLlm", false));
  const curatorModelSourceRaw = String(getEngineField?.("skills.curator.modelSource", "worker") || "worker");
  const curatorModelSource = curatorModelSourceRaw === "session" || curatorModelSourceRaw === "default"
    ? curatorModelSourceRaw
    : "worker";

  const refresh = useCallback(async (preferredId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await gateway.listSkills();
      setSkills(next.skills);
      setRoots(next.roots);
      const candidate = preferredId && next.skills.some((skill) => skill.id === preferredId)
        ? preferredId
        : selectedId && next.skills.some((skill) => skill.id === selectedId)
          ? selectedId
          : next.skills[0]?.id ?? null;
      setSelectedId(candidate);
    } catch {
      setError(t("settings.skills.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [selectedId, t]);

  const refreshCuratorProposals = useCallback(async () => {
    try {
      const next = await gateway.listSkillsCuratorProposals();
      setCuratorProposals(next.proposals ?? []);
    } catch {
      setCuratorProposals([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (curatorEnabled) void refreshCuratorProposals();
  }, [curatorEnabled, refreshCuratorProposals]);

  useEffect(() => {
    setConfirmDelete(false);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    gateway.getSkill(selectedId)
      .then((skill) => { if (alive) setDetail(skill); })
      .catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [selectedId]);

  const runCuratorScan = async () => {
    setCuratorBusy(true);
    setCuratorMsg(null);
    setError(null);
    try {
      const result = await gateway.scanSkillsCurator({ applyMode: curatorApplyMode });
      if (!result.ok) {
        setError(result.error === "curator_disabled"
          ? t("settings.skills.curator.disabledError")
          : (result.error || t("settings.skills.operationFailed")));
      } else {
        setCuratorMsg(result.summary || t("settings.skills.curator.scanOk", {
          count: Array.isArray(result.proposals) ? result.proposals.length : 0,
        }));
        await refresh();
        await refreshCuratorProposals();
      }
    } catch {
      setError(t("settings.skills.operationFailed"));
    } finally {
      setCuratorBusy(false);
    }
  };

  const applyCuratorFile = async (fileName: string) => {
    setCuratorBusy(true);
    setError(null);
    try {
      const result = await gateway.applySkillsCuratorProposal(fileName);
      setCuratorMsg(result.summary || t("settings.skills.curator.applyOk", {
        count: result.applied?.length ?? 0,
      }));
      await refresh();
      await refreshCuratorProposals();
    } catch {
      setError(t("settings.skills.operationFailed"));
    } finally {
      setCuratorBusy(false);
    }
  };

  const applyOne = async (
    skillId: string,
    action: "enable" | "disable" | "apply_patch" | "suggest_patch",
    opts?: { fileName?: string; proposalId?: string },
  ) => {
    if (action === "apply_patch") {
      if (!window.confirm(t("settings.skills.curator.applyPatchConfirm"))) return;
    }
    setBusyId(skillId);
    setError(null);
    try {
      const result = await gateway.applySkillsCuratorOne(skillId, action, opts);
      if (!result.ok) {
        setError(result.error || t("settings.skills.operationFailed"));
      } else {
        setCuratorMsg(
          result.patched
            ? t("settings.skills.curator.patchApplied")
            : t("settings.skills.curator.applyOk", { count: 1 }),
        );
      }
      await refresh();
      await refreshCuratorProposals();
    } catch {
      setError(t("settings.skills.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalized));
  }, [query, skills]);
  const ownedRoots = useMemo(() => roots.filter((root) => root.owned), [roots]);

  const toggle = async (skill: SkillInfo, enabled: boolean) => {
    setBusyId(skill.id);
    setError(null);
    setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, enabled } : item));
    try {
      const updated = await gateway.setSkillEnabled(skill.id, enabled);
      setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, ...updated } : item));
      if (detail?.id === skill.id) setDetail((current) => current ? { ...current, ...updated } : current);
    } catch {
      setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, enabled: !enabled } : item));
      setError(t("settings.skills.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const addRoot = async () => {
    setError(null);
    try {
      await gateway.addSkillRoot();
      await refresh();
    } catch {
      setError(t("settings.skills.operationFailed"));
    }
  };

  const removeRoot = async (root: SkillRoot) => {
    setBusyId(root.id);
    try {
      await gateway.removeSkillRoot(root.id);
      await refresh();
    } catch {
      setError(t("settings.skills.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const removeSkill = async () => {
    if (!detail?.owned) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusyId(detail.id);
    try {
      await gateway.deleteSkill(detail.id);
      setDetail(null);
      setSelectedId(null);
      await refresh();
    } catch {
      setError(t("settings.skills.operationFailed"));
    } finally {
      setBusyId(null);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="max-w-3xl text-[12px] leading-5 text-muted">{t("settings.skills.description")}</p>
        <p className="mt-1 text-[10px] text-faint">{t("settings.skills.applyNewTurns")}</p>
      </div>

      <section aria-labelledby="skills-workflow-title" className="rounded-lg border border-border-soft bg-elevated/35 p-3">
        <div className="flex items-start gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border-soft bg-bg/60 text-primary">
            <FileText className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h4 id="skills-workflow-title" className="text-[11px] font-semibold text-secondary">{t("settings.skills.workflow.title")}</h4>
            <p className="mt-0.5 text-[10px] leading-4 text-muted">{t("settings.skills.workflow.standalone")}</p>
          </div>
        </div>
        <ol className="mt-3 grid gap-1.5 text-[10px] leading-4 text-muted md:grid-cols-3">
          {([
            "settings.skills.workflow.auto",
            "settings.skills.workflow.single",
            "settings.skills.workflow.team",
          ] as const).map((key, index) => (
            <li key={key} className="flex min-w-0 gap-1.5">
              <span className="grid size-4 shrink-0 place-items-center rounded-full bg-bg font-mono text-[8.5px] text-primary">{index + 1}</span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ol>
      </section>

      {getEngineField && setEngineField && (
        <section aria-labelledby="skills-curator-title" className="rounded-lg border border-border-soft bg-elevated/35 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border-soft bg-bg/60 text-primary">
                <Sparkles className="size-3.5" aria-hidden />
              </span>
              <div className="min-w-0">
                <h4 id="skills-curator-title" className="text-[11px] font-semibold text-secondary">
                  {t("settings.skills.curator.title")}
                </h4>
                <p className="mt-0.5 text-[10px] leading-4 text-muted">{t("settings.skills.curator.hint")}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted">{t("settings.skills.curator.enabled")}</span>
              <Switch
                checked={curatorEnabled}
                size="xs"
                aria-label={t("settings.skills.curator.enabled")}
                onCheckedChange={(value) => setEngineField("skills.curator.enabled", value, true)}
              />
            </div>
          </div>

          {curatorEnabled && (
            <div className="mt-3 space-y-3 border-t border-border-soft pt-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-[10px] text-secondary">
                  <span>{t("settings.skills.curator.applyMode")}</span>
                  <select
                    className="h-8 rounded-md border border-border-soft bg-bg px-2 text-[11px] text-secondary"
                    value={curatorApplyMode}
                    onChange={(event) => setEngineField(
                      "skills.curator.applyMode",
                      event.target.value === "apply_safe" ? "apply_safe" : "propose",
                      true,
                    )}
                  >
                    <option value="propose">{t("settings.skills.curator.applyPropose")}</option>
                    <option value="apply_safe">{t("settings.skills.curator.applySafe")}</option>
                  </select>
                  <span className="text-[9.5px] text-faint">{t("settings.skills.curator.applyModeHint")}</span>
                </label>
                <label className="grid gap-1 text-[10px] text-secondary">
                  <span>{t("settings.skills.curator.staleDays")}</span>
                  <Input
                    type="number"
                    min={7}
                    max={3650}
                    value={Number.isFinite(staleDays) ? staleDays : 90}
                    onChange={(event) => {
                      const next = Math.max(7, Math.min(3650, Number(event.target.value) || 90));
                      setEngineField("skills.curator.staleDays", next);
                    }}
                  />
                  <span className="text-[9.5px] text-faint">{t("settings.skills.curator.staleDaysHint")}</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-bg/40 px-2.5 py-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-medium text-secondary">{t("settings.skills.curator.useLlm")}</div>
                  <p className="mt-0.5 text-[9.5px] leading-4 text-faint">{t("settings.skills.curator.useLlmHint")}</p>
                </div>
                <Switch
                  checked={curatorUseLlm}
                  size="xs"
                  aria-label={t("settings.skills.curator.useLlm")}
                  onCheckedChange={(value) => setEngineField("skills.curator.useLlm", value, true)}
                />
              </div>
              {curatorUseLlm && (
                <label className="grid gap-1 text-[10px] text-secondary">
                  <span>{t("settings.skills.curator.modelSource")}</span>
                  <select
                    className="h-8 rounded-md border border-border-soft bg-bg px-2 text-[11px] text-secondary"
                    value={curatorModelSource}
                    onChange={(event) => {
                      const value = event.target.value;
                      setEngineField(
                        "skills.curator.modelSource",
                        value === "session" || value === "default" ? value : "worker",
                        true,
                      );
                    }}
                  >
                    <option value="worker">{t("settings.options.curatorModelWorker")}</option>
                    <option value="session">{t("settings.options.curatorModelSession")}</option>
                    <option value="default">{t("settings.options.curatorModelDefault")}</option>
                  </select>
                  <span className="text-[9.5px] text-faint">{t("settings.skills.curator.modelSourceHint")}</span>
                </label>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void runCuratorScan()} disabled={curatorBusy}>
                  <RefreshCw className={cn("size-3.5", curatorBusy && "animate-spin")} />
                  {t("settings.skills.curator.scan")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void refreshCuratorProposals()} disabled={curatorBusy}>
                  {t("settings.skills.curator.refreshProposals")}
                </Button>
              </div>

              {curatorMsg && (
                <div className="rounded-md border border-success/25 bg-success/8 px-3 py-2 text-[10px] text-secondary">
                  {curatorMsg}
                </div>
              )}

              <div>
                <div className="mb-1 text-[10px] font-medium text-muted">{t("settings.skills.curator.proposalsTitle")}</div>
                <p className="mb-2 text-[9.5px] leading-4 text-faint">{t("settings.skills.curator.proposalsHint")}</p>
                {curatorProposals.length === 0 ? (
                  <p className="text-[10px] text-faint">{t("settings.skills.curator.noProposals")}</p>
                ) : (
                  <ul className="max-h-56 space-y-2 overflow-y-auto">
                    {curatorProposals.slice(0, 12).map((row) => (
                      <li key={row.fileName} className="rounded-md border border-border-soft bg-bg/50 px-2.5 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-mono text-[9px] text-secondary">{row.fileName}</div>
                            <div className="mt-0.5 text-[9px] text-muted">
                              {row.status ?? "pending"}
                              {row.via ? ` · ${row.via}` : ""}
                              {" · "}
                              {row.proposalCount ?? 0}
                              {" · "}
                              {row.at ? new Date(row.at).toLocaleString() : "—"}
                            </div>
                          </div>
                          {row.status !== "applied" && (
                            <Button size="sm" variant="outline" disabled={curatorBusy} onClick={() => void applyCuratorFile(row.fileName)}>
                              {t("settings.skills.curator.applySafeBtn")}
                            </Button>
                          )}
                        </div>
                        {row.preview?.length ? (
                          <ul className="mt-2 space-y-1 border-t border-border-soft pt-2">
                            {row.preview.slice(0, 5).map((item, index) => (
                              <li key={item.id ?? `${row.fileName}-${index}`} className="flex min-w-0 items-start justify-between gap-2 text-[9.5px]">
                                <div className="min-w-0">
                                  <span className="font-medium text-secondary">{item.skillName || item.skillId}</span>
                                  <span className="text-muted"> · {item.action} · {item.kind}</span>
                                  <div className="truncate text-faint">{item.reason}{item.detail ? ` — ${item.detail}` : ""}</div>
                                  {item.suggestedDescription && (
                                    <div className="mt-0.5 line-clamp-2 text-secondary">
                                      {t("settings.skills.curator.suggestedDesc")}: {item.suggestedDescription}
                                    </div>
                                  )}
                                  {item.hasContentPatch && (
                                    <div className="mt-0.5 text-faint">{t("settings.skills.curator.hasContentPatch")}</div>
                                  )}
                                </div>
                                <div className="flex shrink-0 flex-col gap-1">
                                  {(item.action === "disable" || item.action === "enable") && item.skillId && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-2 text-[9px]"
                                      disabled={busyId === item.skillId}
                                      onClick={() => void applyOne(item.skillId!, item.action as "enable" | "disable")}
                                    >
                                      {item.action === "disable"
                                        ? t("settings.skills.curator.disableOne")
                                        : t("settings.skills.curator.enableOne")}
                                    </Button>
                                  )}
                                  {(item.action === "suggest_patch" || item.kind === "llm_patch")
                                    && item.skillId
                                    && item.owned === true && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-2 text-[9px]"
                                      disabled={busyId === item.skillId}
                                      onClick={() => void applyOne(item.skillId!, "apply_patch", {
                                        fileName: row.fileName,
                                        proposalId: item.id,
                                      })}
                                    >
                                      {t("settings.skills.curator.applyPatch")}
                                    </Button>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{t("settings.skills.roots")}</h4>
            <p className="mt-0.5 text-[10px] text-faint">{t("settings.skills.rootsHint")}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void addRoot()}><Plus className="size-3.5" />{t("settings.skills.addFolder")}</Button>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />{t("settings.skills.refresh")}</Button>
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          {roots.map((root) => (
            <div key={root.id} className="min-w-0 rounded-lg border border-border-soft bg-bg/40 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <FolderOpen className="size-3.5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium text-secondary">{provenanceLabel(root.provenance, t)}</div>
                  <div className="truncate font-mono text-[9px] text-faint" title={root.path}>{root.path}</div>
                </div>
                <button type="button" className="shell-icon-button" title={t("settings.skills.openFolder")} aria-label={t("settings.skills.openFolder")} onClick={() => void gateway.openSkillRoot(root.id)}>
                  <ExternalLink className="size-3.5" aria-hidden />
                </button>
                {root.provenance === "custom" && (
                  <button type="button" className="shell-icon-button hover:text-danger" title={t("settings.skills.removeFolder")} aria-label={t("settings.skills.removeFolder")} disabled={busyId === root.id} onClick={() => void removeRoot(root)}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.skills.search")} className="pl-8" />
          </label>
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" />{t("settings.skills.create")}</Button>
        </div>

        {error && <div className="mb-2 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">{error}</div>}

        <div className="grid min-h-[22rem] overflow-hidden rounded-lg border border-border-soft bg-bg/25 min-[980px]:grid-cols-[17rem_minmax(0,1fr)]">
          <div className="max-h-[32rem] overflow-y-auto border-b border-border-soft min-[980px]:border-b-0 min-[980px]:border-r">
            {loading ? (
              <div className="grid min-h-32 place-items-center"><RefreshCw className="size-4 animate-spin text-muted" aria-hidden /></div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <div className="text-[11px] font-medium text-secondary">{t("settings.skills.empty")}</div>
                <p className="mt-1 text-[10px] leading-4 text-muted">{t("settings.skills.emptyHint")}</p>
              </div>
            ) : filtered.map((skill) => (
              <div key={skill.id} className={cn("flex min-w-0 items-center gap-2 border-b border-border-soft px-2.5 py-2", selectedId === skill.id && "bg-(--ui-row-active)")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(skill.id)}>
                  <div className="truncate text-[11px] font-medium text-secondary">{skill.name}</div>
                  <div className="mt-0.5 truncate text-[9px] text-muted">{skill.description || provenanceLabel(skill.provenance, t)}</div>
                </button>
                <Switch checked={skill.enabled} disabled={busyId === skill.id} size="xs" aria-label={skill.name} onCheckedChange={(enabled) => void toggle(skill, enabled)} />
              </div>
            ))}
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            {detail ? (
              <div>
                <div className="flex min-w-0 items-start gap-3">
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-primary"><FileText className="size-4" aria-hidden /></div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[14px] font-semibold text-foreground">{detail.name}</h3>
                    <p className="mt-0.5 text-[10px] leading-4 text-muted">{detail.description}</p>
                  </div>
                  <span className={cn("rounded px-1.5 py-0.5 text-[9px]", detail.enabled ? "bg-success/10 text-success" : "bg-elevated text-muted")}>
                    {detail.enabled ? t("settings.skills.enabled") : t("settings.skills.disabled")}
                  </span>
                </div>
                <dl className="mt-4 grid gap-2 text-[10px] sm:grid-cols-2">
                  <div><dt className="text-muted">{t("settings.skills.location")}</dt><dd className="mt-0.5 text-secondary">{provenanceLabel(detail.provenance, t)}</dd></div>
                  <div><dt className="text-muted">{t("settings.skills.usageLabel")}</dt><dd className="mt-0.5 text-secondary">{t("settings.skills.usage", { count: detail.usage })}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-muted">{t("settings.skills.id")}</dt><dd className="mt-0.5 break-all font-mono text-[9px] text-secondary">{detail.id}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-muted">{t("settings.skills.path")}</dt><dd className="mt-0.5 break-all font-mono text-[9px] text-secondary">{detail.relativePath}</dd></div>
                </dl>
                <div className="mt-4">
                  <div className="mb-1.5 text-[10px] font-medium text-muted">{t("settings.skills.content")}</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border-soft bg-bg p-3 font-mono text-[9.5px] leading-4 text-secondary">{detail.content}</pre>
                </div>
                <div className="mt-4 rounded-md border border-border-soft bg-bg/45 p-3">
                  <div className="text-[10px] font-medium text-secondary">{t("settings.skills.linkedDocs")}</div>
                  <p className="mt-1 text-[9.5px] leading-4 text-muted">{t("settings.skills.linkedDocsHint")}</p>
                  {detail.references?.length ? (
                    <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1" aria-label={t("settings.skills.linkedDocs")}>
                      {detail.references.map((reference) => (
                        <li key={reference.id} className="min-w-0 rounded border border-border-soft bg-surface/55 px-2.5 py-2">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span className="truncate text-[10px] font-medium text-secondary" title={reference.label}>{reference.label}</span>
                            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[8.5px] text-muted">
                              {t(reference.source === "kiro-docs" ? "settings.skills.documentKiro" : "settings.skills.documentLocal")}
                            </span>
                          </div>
                          <div className="mt-1 truncate font-mono text-[8.5px] text-faint" title={reference.relativePath}>{reference.relativePath}</div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[9.5px] text-faint">{t("settings.skills.noLinkedDocs")}</p>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  {!detail.owned && <span className="text-[9.5px] text-muted">{t("settings.skills.readOnly")}</span>}
                  {detail.owned && (
                    <Button variant={confirmDelete ? "destructive" : "outline"} size="sm" onClick={() => void removeSkill()} disabled={busyId === detail.id}>
                      <Trash2 className="size-3.5" />{confirmDelete ? t("settings.skills.confirmDelete") : t("settings.skills.delete")}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid min-h-48 place-items-center text-[11px] text-muted">{t("settings.skills.select")}</div>
            )}
          </div>
        </div>
      </section>

      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        roots={ownedRoots}
        workspace={workspace}
        onCreated={(skill) => void refresh(skill.id)}
      />
    </div>
  );
}

function CreateSkillDialog({ open, onOpenChange, roots, workspace, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roots: SkillRoot[];
  workspace: string;
  onCreated: (skill: SkillInfo) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [rootId, setRootId] = useState("global");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setContent("");
    setRootId(roots.find((root) => root.id === "global")?.id ?? roots[0]?.id ?? "global");
    setError(null);
  }, [open, roots]);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const skill = await gateway.createSkill({ name: name.trim(), description: description.trim(), content, rootId });
      onCreated(skill);
      onOpenChange(false);
    } catch {
      setError(t("settings.skills.operationFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="w-[min(92vw,38rem)]" showClose={!saving}>
        <DialogHeader>
          <DialogTitle>{t("settings.skills.newTitle")}</DialogTitle>
          <DialogDescription>{t("settings.skills.newDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-[11px] text-secondary">
            <span>{t("settings.skills.name")}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.skills.namePlaceholder")} />
          </label>
          <label className="grid gap-1 text-[11px] text-secondary">
            <span>{t("settings.skills.summary")}</span>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("settings.skills.summaryPlaceholder")} />
          </label>
          <label className="grid gap-1 text-[11px] text-secondary">
            <span>{t("settings.skills.instructions")}</span>
            <Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={t("settings.skills.instructionsPlaceholder")} className="min-h-36 font-mono" />
          </label>
          <label className="grid gap-1 text-[11px] text-secondary">
            <span>{t("settings.skills.location")}</span>
            <select value={rootId} onChange={(event) => setRootId(event.target.value)} className="h-9 rounded-md border border-border bg-bg px-2 text-[12px] text-foreground outline-none">
              {roots.map((root) => <option key={root.id} value={root.id}>{provenanceLabel(root.provenance, t)}</option>)}
            </select>
            {!workspace && <span className="text-[9px] text-muted">{t("settings.skills.noWorkspace")}</span>}
          </label>
          {error && <div className="text-[11px] text-danger">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t("common.cancel")}</Button>
          <Button onClick={() => void submit()} disabled={saving || !name.trim() || roots.length === 0}>{t("settings.skills.createAction")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function provenanceLabel(provenance: SkillProvenance, t: ReturnType<typeof useI18n>["t"]): string {
  switch (provenance) {
    case "workspace": return t("settings.skills.workspace");
    case "custom": return t("settings.skills.custom");
    case "kiro": return t("settings.skills.documentKiro");
    default: return t("settings.skills.global");
  }
}
