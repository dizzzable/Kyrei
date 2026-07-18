import { BrainCircuit, FileJson2, FileText, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import type { EvolutionCandidate, EvolutionRuntimeConfig, MemoryAtlasNode, MemoryAtlasSnapshot } from "@/lib/types";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import { selectSkillForNextRequest } from "@/store/composer-skills";

export function MemoryAtlasInspector({ selected, atlas }: { selected: MemoryAtlasNode | null; atlas: MemoryAtlasSnapshot | null }) {
  const { t, number } = useI18n();
  const [skillQueued, setSkillQueued] = useState(false);
  const [candidate, setCandidate] = useState<EvolutionCandidate | null>(null);
  const [evolutionConfig, setEvolutionConfig] = useState<EvolutionRuntimeConfig | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);

  useEffect(() => {
    setSkillQueued(false);
    setCandidate(null);
    setCandidateError(null);
    if (selected?.kind !== "evolution" || !selected.entityId) return;
    let active = true;
    void gateway.getEvolutionCandidates().then((result) => {
      if (!active) return;
      setEvolutionConfig(result.config);
      setCandidate(result.candidates.find((item) => item.id === selected.entityId) ?? null);
    }).catch((error) => {
      if (active) setCandidateError(error instanceof Error ? error.message : "evolution_load_failed");
    });
    return () => { active = false; };
  }, [selected?.entityId, selected?.kind]);

  const rejectCandidate = async () => {
    if (!candidate || candidateBusy) return;
    setCandidateBusy(true);
    setCandidateError(null);
    try {
      const result = await gateway.transitionEvolutionCandidate(candidate.id, {
        expectedRevision: candidate.revision,
        status: "rejected",
        reason: "Rejected from Memory Atlas review",
      });
      setCandidate(result.candidate);
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : "evolution_transition_failed");
    } finally {
      setCandidateBusy(false);
    }
  };

  if (selected) return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <span className="mt-1 size-2.5 shrink-0 rounded-full bg-primary" />
        <div className="min-w-0">
          <div className="text-[9px] font-medium uppercase tracking-[0.13em] text-muted">{selected.kind}</div>
          <h3 className="mt-1 break-words text-[13px] font-semibold text-foreground">{selected.title}</h3>
        </div>
      </div>
      {selected.path && <div className="mt-4 break-all rounded-md border border-border-soft bg-bg/50 px-2.5 py-2 font-mono text-[9px] leading-4 text-secondary">{selected.path}</div>}
      {selected.subtitle && <p className="mt-3 text-[10px] leading-4 text-muted">{selected.subtitle}</p>}
      {selected.kind === "skill" && <div className="mt-3 flex flex-wrap gap-1.5 text-[9px]"><span className="rounded border border-border-soft px-1.5 py-0.5">{selected.enabled ? t("shell.memory.skill.enabled") : t("shell.memory.skill.disabled")}</span><span className="rounded border border-border-soft px-1.5 py-0.5">{selected.compatible ? t("shell.memory.skill.compatible") : t("shell.memory.skill.incompatible")}</span></div>}
      {selected.kind === "skill" && selected.entityId && <div className="mt-3"><Button size="sm" disabled={!selected.enabled || !selected.compatible || skillQueued} onClick={() => {
        if (selectSkillForNextRequest(selected.entityId!)) setSkillQueued(true);
      }}>{skillQueued ? t("shell.memory.skill.queued") : t("shell.memory.skill.useNext")}</Button></div>}
      {selected.kind === "evolution" && <div className="mt-4 rounded-lg border border-border-soft bg-bg/35 p-3 text-[9.5px] text-secondary">
        {candidate && <>
          <div className="flex items-center justify-between gap-2"><span>{t("shell.memory.evolution.status")}</span><span className="font-mono text-foreground">{candidate.status}</span></div>
          <div className="mt-2 flex items-center justify-between gap-2"><span>{t("shell.memory.evolution.revision")}</span><span className="font-mono text-foreground">{candidate.revision}</span></div>
          <div className="mt-2 flex items-center justify-between gap-2"><span>{t("shell.memory.evolution.receipts")}</span><span className="font-mono text-foreground">{candidate.evidence.receipts.length}</span></div>
          {!evolutionConfig?.evaluationEnabled && <p className="mt-3 text-warning">{t("shell.memory.evolution.evaluationDisabled")}</p>}
          {["pending", "evaluating", "approved"].includes(candidate.status) && <Button className="mt-3" size="sm" variant="outline" disabled={candidateBusy} onClick={() => void rejectCandidate()}>{candidateBusy ? t("shell.memory.evolution.rejecting") : t("shell.memory.evolution.reject")}</Button>}
        </>}
        {!candidate && !candidateError && <span>{t("shell.memory.evolution.loading")}</span>}
        {candidateError && <p role="alert" className="text-danger">{candidateError}</p>}
      </div>}
      {selected.preview && <div className="mt-4 border-t border-border-soft pt-4"><h4 className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted">{t("shell.memory.preview")}</h4><p className="mt-2 whitespace-pre-wrap text-[10.5px] leading-5 text-secondary">{selected.preview}</p></div>}
      {selected.digest && <p className="mt-4 break-all font-mono text-[8px] text-faint">sha256 {selected.digest}</p>}
    </div>
  );
  return (
    <div className="p-4">
      <div className="flex items-center gap-2"><BrainCircuit className="size-4 text-primary" /><h3 className="text-[12px] font-semibold text-foreground">{t("shell.memory.overview")}</h3></div>
      <p className="mt-2 text-[10px] leading-4 text-muted">{t("shell.memory.overviewHint")}</p>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Stat label={t("shell.memory.stat.code")} value={atlas?.stats.code ?? 0} />
        <Stat label={t("shell.memory.stat.documents")} value={atlas?.stats.documents ?? 0} />
        <Stat label={t("shell.memory.stat.decisions")} value={atlas?.stats.decisions ?? 0} />
        <Stat label={t("shell.memory.stat.sessions")} value={atlas?.stats.sessions ?? 0} />
        <Stat label={t("shell.memory.stat.skills")} value={atlas?.stats.skills ?? 0} />
        <Stat label={t("shell.memory.stat.sources")} value={atlas?.sources.length ?? 0} />
      </div>
      <div className="mt-5 space-y-2 border-t border-border-soft pt-4">
        {atlas?.sources.map((source) => <div key={source.id} className="flex items-center gap-2 text-[9.5px]"><span className={`size-1.5 rounded-full ${source.health === "ready" ? "bg-success" : source.health === "unavailable" ? "bg-danger" : "bg-warning"}`} /><span className="min-w-0 flex-1 truncate text-secondary">{source.label}</span><span className="text-faint">{source.capability}</span></div>)}
      </div>
      <div className="mt-5 border-t border-border-soft pt-4"><h4 className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted">{t("shell.memory.howItWorks")}</h4><ol className="mt-3 space-y-3 text-[10px] leading-4 text-secondary"><li className="flex gap-2"><FileJson2 className="mt-0.5 size-3.5 shrink-0 text-primary" />{t("shell.memory.howSessions")}</li><li className="flex gap-2"><FileText className="mt-0.5 size-3.5 shrink-0 text-primary" />{t("shell.memory.howDocuments")}</li><li className="flex gap-2"><Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />{t("shell.memory.howSkills")}</li></ol></div>
    </div>
  );

  function Stat({ label, value }: { label: string; value: number }) {
    return <div className="rounded-lg border border-border-soft bg-bg/35 p-2.5"><div className="font-mono text-[15px] font-semibold text-foreground">{number(value)}</div><div className="mt-0.5 text-[8.5px] uppercase tracking-wide text-muted">{label}</div></div>;
  }
}
