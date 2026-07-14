import { Ban, Code2, Pencil, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@/components/ui";
import { useI18n } from "@/i18n";
import {
  MAX_PERMISSION_RULES,
  classifyPermissionRule,
  createExactCommandPermissionRule,
  createExactPathPermissionRule,
  createExactToolPermissionRule,
  guidedPermissionRuleIdentity,
  permissionToolSupportsInteractiveAsk,
  type PathPermissionTool,
  type PermissionRule,
  type PermissionRuleAction,
  type PermissionRuleClassification,
} from "@/lib/permission-rules";
import { cn } from "@/lib/utils";

const GUIDED_TOOLS = [
  "run_command",
  "write_file",
  "edit_file",
  "diagnostics",
  "web_search",
  "web_fetch",
] as const;

type GuidedTool = typeof GUIDED_TOOLS[number];
type GuidedScope = "command" | "path" | "tool";

interface RuleDraft {
  action: PermissionRuleAction;
  scope: GuidedScope;
  tool: GuidedTool;
  pathTool: PathPermissionTool;
  value: string;
}

interface PermissionRulesEditorProps {
  rules: readonly PermissionRule[];
  importIssueCount?: number;
  onChange: (rules: PermissionRule[]) => void;
}

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground outline-none " +
  "focus:border-primary/60 focus:ring-2 focus:ring-primary/25";

function emptyDraft(): RuleDraft {
  return { action: "ask", scope: "command", tool: "run_command", pathTool: "write_file", value: "" };
}

function isGuidedTool(value: string): value is GuidedTool {
  return (GUIDED_TOOLS as readonly string[]).includes(value);
}

function draftFromClassification(
  classification: PermissionRuleClassification,
  action: PermissionRuleAction,
): RuleDraft | undefined {
  if (classification.mode !== "generated") return undefined;
  if (classification.kind === "command") {
    if (/[\u0000-\u001f\u007f]/.test(classification.command)) return undefined;
    return { action, scope: "command", tool: "run_command", pathTool: "write_file", value: classification.command };
  }
  if (classification.kind === "path") {
    if (/[\u0000-\u001f\u007f]/.test(classification.target)) return undefined;
    return { action, scope: "path", tool: classification.tool, pathTool: classification.tool, value: classification.target };
  }
  if (!isGuidedTool(classification.tool)) return undefined;
  if (!permissionToolSupportsInteractiveAsk(classification.tool) && action === "ask") return undefined;
  return { action, scope: "tool", tool: classification.tool, pathTool: "write_file", value: "" };
}

function buildRule(draft: RuleDraft): PermissionRule {
  if (draft.scope === "tool") return createExactToolPermissionRule(draft.tool, draft.action);
  if (!draft.value.trim()) throw new TypeError("permission_rule_value_required");
  return draft.scope === "command"
    ? createExactCommandPermissionRule(draft.value, draft.action)
    : createExactPathPermissionRule(draft.pathTool, draft.value, draft.action);
}

function actionTone(action: PermissionRuleAction): "success" | "warning" | "danger" {
  if (action === "allow") return "success";
  if (action === "deny") return "danger";
  return "warning";
}

export function PermissionRulesEditor({ rules, importIssueCount = 0, onChange }: PermissionRulesEditorProps) {
  const { t } = useI18n();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft);
  const [attempted, setAttempted] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const candidate = useMemo(() => {
    try {
      return { rule: buildRule(draft), error: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const isPathError = draft.scope === "path" && message.startsWith("permission_rule_path_");
      return {
        rule: undefined,
        error: isPathError
          ? t("settings.permissions.rules.error.pathRelative")
          : message === "permission_rule_value_required"
            ? t("settings.permissions.rules.error.required")
            : t("settings.permissions.rules.error.valueTooLong"),
      };
    }
  }, [draft, t]);

  const isWindows = typeof navigator !== "undefined" && /win/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const candidateIdentity = candidate.rule
    ? guidedPermissionRuleIdentity(candidate.rule, { caseInsensitive: isWindows })
    : undefined;
  const duplicate = candidate.rule
    ? rules.some((rule, index) => {
      if (index === editingIndex) return false;
      if (rule.pattern === candidate.rule?.pattern) return true;
      const identity = guidedPermissionRuleIdentity(rule, { caseInsensitive: isWindows });
      return Boolean(candidateIdentity && identity === candidateIdentity);
    })
    : false;
  const editorError = duplicate ? t("settings.permissions.rules.error.duplicate") : candidate.error;

  const openCreate = () => {
    if (importIssueCount > 0) return;
    setEditingIndex(null);
    setDraft(emptyDraft());
    setAttempted(false);
    setEditorOpen(true);
  };

  const openEdit = (index: number, classification: PermissionRuleClassification) => {
    const nextDraft = draftFromClassification(classification, rules[index].action);
    if (!nextDraft) return;
    setEditingIndex(index);
    setDraft(nextDraft);
    setAttempted(false);
    setEditorOpen(true);
  };

  const save = () => {
    setAttempted(true);
    if (!candidate.rule || duplicate || importIssueCount > 0) return;
    if (editingIndex === null) onChange([...rules, candidate.rule]);
    else onChange(rules.map((rule, index) => index === editingIndex ? candidate.rule as PermissionRule : rule));
    setEditorOpen(false);
  };

  const requestDelete = (index: number) => {
    if (importIssueCount > 0) return;
    const rule = rules[index];
    if (rule.action === "allow") {
      onChange(rules.filter((_, ruleIndex) => ruleIndex !== index));
      return;
    }
    setPendingDelete(index);
  };

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    onChange(rules.filter((_, index) => index !== pendingDelete));
    setPendingDelete(null);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };

  const toolLabel = (tool: string) => {
    if (isGuidedTool(tool)) return t(`settings.permissions.rules.tool.${tool}`);
    return tool;
  };
  const webAskUnavailable = draft.scope === "tool" && !permissionToolSupportsInteractiveAsk(draft.tool);
  const availableActions: PermissionRuleAction[] = webAskUnavailable
    ? ["allow", "deny"]
    : ["ask", "allow", "deny"];

  return (
    <div className="py-3" aria-labelledby="permission-rules-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="permission-rules-title" className="text-[13px] font-medium text-foreground">
              {t("settings.permissions.rules.label")}
            </h3>
            <Badge tone="neutral" className="text-[10px] normal-case tracking-normal">
              {t("settings.permissions.rules.count", { count: rules.length })}
            </Badge>
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-muted">{t("settings.permissions.rules.hint")}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={rules.length >= MAX_PERMISSION_RULES || importIssueCount > 0}
          onClick={openCreate}
        >
          <Plus className="size-3.5" aria-hidden />
          {t("settings.permissions.rules.add")}
        </Button>
      </div>

      {rules.length >= MAX_PERMISSION_RULES ? (
        <p className="mt-2 text-[12px] text-danger" role="alert">{t("settings.permissions.rules.error.limit")}</p>
      ) : null}
      {importIssueCount > 0 ? (
        <div className="mt-3 flex gap-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] leading-5 text-secondary" role="alert">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <span>{t("settings.permissions.rules.importBlocked", { count: importIssueCount })}</span>
        </div>
      ) : null}

      <div className="mt-3 overflow-hidden rounded-lg border border-border-soft bg-surface/30">
        {rules.length === 0 ? (
          <div className="flex min-h-24 items-start gap-3 border-dashed px-4 py-4">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="text-[13px] font-medium text-foreground">{t("settings.permissions.rules.empty")}</p>
              <p className="mt-1 max-w-3xl text-[12px] leading-5 text-muted">{t("settings.permissions.rules.emptyHint")}</p>
            </div>
          </div>
        ) : (
          <ol className="divide-y divide-border-soft">
            {rules.map((rule, index) => {
              const classification = classifyPermissionRule(rule);
              const guidedDraft = draftFromClassification(classification, rule.action);
              const isUnsupportedWebAsk = classification.mode === "generated"
                && classification.kind === "tool"
                && !permissionToolSupportsInteractiveAsk(classification.tool)
                && rule.action === "ask";
              const isAdvanced = classification.mode === "advanced"
                || (classification.mode === "generated" && !guidedDraft && !isUnsupportedWebAsk);
              const isInvalid = classification.mode === "invalid";
              const scopeLabel = isInvalid
                ? t("settings.permissions.rules.scope.invalid")
                : isUnsupportedWebAsk
                  ? t("settings.permissions.rules.scope.unsupported")
                  : isAdvanced
                  ? t("settings.permissions.rules.scope.advanced")
                  : t(`settings.permissions.rules.scope.${classification.kind}`);
              const detail = classification.mode === "generated" && classification.kind === "command"
                ? classification.command
                : classification.mode === "generated" && classification.kind === "path"
                  ? classification.target
                  : classification.mode === "generated" && classification.kind === "tool"
                    ? toolLabel(classification.tool)
                    : rule.pattern;
              const technicalScope = classification.mode === "generated"
                ? classification.kind === "command"
                  ? "run_command"
                  : classification.tool
                : "regex";

              return (
                <li key={`${index}:${rule.pattern}`} className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={actionTone(rule.action)} className="text-[10px]">
                        {rule.action === "allow" ? <ShieldCheck className="size-3" aria-hidden /> : null}
                        {rule.action === "ask" ? <ShieldAlert className="size-3" aria-hidden /> : null}
                        {rule.action === "deny" ? <Ban className="size-3" aria-hidden /> : null}
                        {t(`settings.permissions.rules.action.${rule.action}`)}
                      </Badge>
                      <span className="text-[12px] font-medium text-secondary">{scopeLabel}</span>
                      <code className="rounded bg-elevated px-1.5 py-0.5 text-[11px] text-muted">{technicalScope}</code>
                    </div>
                    <p className="mt-1.5 break-all font-mono text-[12px] leading-5 text-foreground">{detail}</p>
                    {isAdvanced || isInvalid || isUnsupportedWebAsk ? (
                      <p className={cn("mt-1 text-[11px] leading-4", isInvalid ? "text-danger" : "text-muted")}>
                        {t(isInvalid
                          ? "settings.permissions.rules.invalidHint"
                          : isUnsupportedWebAsk
                            ? "settings.permissions.rules.unsupportedWebAskHint"
                            : "settings.permissions.rules.advancedHint")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    {guidedDraft ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={importIssueCount > 0}
                        onClick={() => openEdit(index, classification)}
                        aria-label={t("settings.permissions.rules.edit")}
                        title={t("settings.permissions.rules.edit")}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                    ) : null}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={importIssueCount > 0}
                      onClick={() => requestDelete(index)}
                      aria-label={t("settings.permissions.rules.remove")}
                      title={t("settings.permissions.rules.remove")}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="mt-2 flex items-start gap-2 rounded-md bg-elevated/45 px-3 py-2 text-[11.5px] leading-5 text-muted">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <span>{t("settings.permissions.rules.precedence")} {t("settings.permissions.rules.caseHint")}</span>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent onKeyDown={handleEditorKeyDown}>
          <DialogHeader>
            <DialogTitle>
              {t(editingIndex === null ? "settings.permissions.rules.addTitle" : "settings.permissions.rules.editTitle")}
            </DialogTitle>
            <DialogDescription>{t("settings.permissions.rules.dialogHint")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[12px] font-medium text-secondary">{t("settings.permissions.rules.action")}</span>
              <select
                className={SELECT_CLASS}
                value={draft.action}
                onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value as PermissionRuleAction }))}
              >
                {availableActions.map((action) => (
                  <option key={action} value={action}>{t(`settings.permissions.rules.action.${action}`)}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[12px] font-medium text-secondary">{t("settings.permissions.rules.scope")}</span>
              <select
                className={SELECT_CLASS}
                value={draft.scope}
                onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as GuidedScope, value: "" }))}
              >
                {(["command", "path", "tool"] as const).map((scope) => (
                  <option key={scope} value={scope}>{t(`settings.permissions.rules.scope.${scope}`)}</option>
                ))}
              </select>
            </label>

            {draft.scope === "path" ? (
              <label className="space-y-1">
                <span className="text-[12px] font-medium text-secondary">{t("settings.permissions.rules.pathOperation")}</span>
                <select
                  className={SELECT_CLASS}
                  value={draft.pathTool}
                  onChange={(event) => setDraft((current) => ({ ...current, pathTool: event.target.value as PathPermissionTool }))}
                >
                  {(["write_file", "edit_file"] as const).map((tool) => (
                    <option key={tool} value={tool}>{t(`settings.permissions.rules.tool.${tool}`)}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {draft.scope === "tool" ? (
              <label className="space-y-1 sm:col-span-2">
                <span className="text-[12px] font-medium text-secondary">{t("settings.permissions.rules.tool")}</span>
                <select
                  className={SELECT_CLASS}
                  value={draft.tool}
                  onChange={(event) => {
                    const tool = event.target.value as GuidedTool;
                    setDraft((current) => ({
                      ...current,
                      tool,
                      action: !permissionToolSupportsInteractiveAsk(tool) && current.action === "ask"
                        ? "deny"
                        : current.action,
                    }));
                  }}
                >
                  {GUIDED_TOOLS.map((tool) => (
                    <option key={tool} value={tool}>{toolLabel(tool)} · {tool}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {draft.scope !== "tool" ? (
              <label className={cn("space-y-1", draft.scope === "command" ? "sm:col-span-2" : "") }>
                <span className="text-[12px] font-medium text-secondary">{t("settings.permissions.rules.value")}</span>
                <Input
                  autoFocus
                  value={draft.value}
                  maxLength={420}
                  aria-invalid={Boolean((attempted || draft.value) && editorError) || undefined}
                  aria-describedby={(attempted || draft.value) && editorError ? "permission-rule-error" : undefined}
                  placeholder={t(draft.scope === "command" ? "settings.permissions.rules.commandPlaceholder" : "settings.permissions.rules.pathPlaceholder")}
                  onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
                />
              </label>
            ) : null}
          </div>

          {draft.action === "allow" ? (
            <div className="mt-3 flex gap-2 rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] leading-5 text-secondary">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span>{t("settings.permissions.rules.allowWarning")}</span>
            </div>
          ) : null}
          {draft.scope === "tool" ? (
            <p className="mt-2 text-[12px] leading-5 text-muted">{t("settings.permissions.rules.toolWarning")}</p>
          ) : null}
          {(attempted || draft.value) && editorError ? (
            <p id="permission-rule-error" className="mt-2 text-[12px] text-danger" role="alert">{editorError}</p>
          ) : null}
          {candidate.rule && !duplicate ? (
            <div className="mt-3 rounded-md border border-border-soft bg-bg/55 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
                <Code2 className="size-3.5" aria-hidden />
                {t("settings.permissions.rules.preview")}
              </div>
              <code className="mt-1 block break-all text-[11px] leading-5 text-secondary">{candidate.rule.pattern}</code>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorOpen(false)}>{t("settings.permissions.rules.cancel")}</Button>
            <Button onClick={save}>{t("settings.permissions.rules.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.permissions.rules.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("settings.permissions.rules.deleteHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>{t("settings.permissions.rules.cancel")}</Button>
            <Button variant="destructive" onClick={confirmDelete}>{t("settings.permissions.rules.deleteAction")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
