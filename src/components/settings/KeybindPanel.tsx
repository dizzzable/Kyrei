import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import { comboFromEvent, formatCombo } from "@/lib/keybinds/combo";
import {
  KEYBIND_ACTIONS,
  KEYBIND_CATEGORIES,
  KEYBIND_READONLY,
  type KeybindCategory,
} from "@/lib/keybinds/actions";
import { keybindOverrides, bindings, conflictsFor, rebind, reset, resetAll } from "@/store/keybinds";
import { useAtom } from "@/store/atom";
import { cn } from "@/lib/utils";
import { useI18n, type TranslationKey, type Translator } from "@/i18n";

const CATEGORY_LABELS = {
  composer: "settings.keybinds.category.composer",
  session: "settings.keybinds.category.session",
  navigation: "settings.keybinds.category.navigation",
  view: "settings.keybinds.category.view",
} as const satisfies Record<KeybindCategory, TranslationKey>;

const ACTION_LABELS = {
  "composer.focus": "settings.keybinds.action.composerFocus",
  "composer.modelPicker": "settings.keybinds.action.modelPicker",
  "composer.send": "settings.keybinds.action.send",
  "composer.newline": "settings.keybinds.action.newline",
  "composer.cancel": "settings.keybinds.action.cancel",
  "composer.mention": "settings.keybinds.action.mention",
  "composer.slash": "settings.keybinds.action.slash",
  "session.new": "settings.keybinds.action.newSession",
  "session.next": "settings.keybinds.action.nextSession",
  "session.prev": "settings.keybinds.action.prevSession",
  "session.focusSearch": "settings.keybinds.action.sessionSearch",
  "session.togglePin": "settings.keybinds.action.togglePin",
  "nav.commandPalette": "settings.keybinds.action.commandPalette",
  "nav.settings": "settings.keybinds.action.settings",
  "view.toggleSidebar": "settings.keybinds.action.toggleSidebar",
  "view.toggleExplorer": "settings.keybinds.action.toggleExplorer",
  "appearance.toggleMode": "settings.keybinds.action.toggleMode",
  "keybinds.openPanel": "settings.keybinds.action.openPanel",
} as const satisfies Record<string, TranslationKey>;

function actionLabel(t: Translator<TranslationKey>, id: string): string {
  const key = ACTION_LABELS[id as keyof typeof ACTION_LABELS];
  return key ? t(key) : id;
}

function CaptureRow({ actionId, combos }: { actionId: string; combos: string[] }) {
  const { t } = useI18n();
  const [capturing, setCapturing] = useState(false);
  const [conflict, setConflict] = useState<string[]>([]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const clashes = conflictsFor(actionId, combo);
      if (clashes.length) {
        setConflict(clashes);
        return;
      }
      rebind(actionId, [combo]);
      setConflict([]);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, actionId]);

  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">{actionLabel(t, actionId)}</span>
      <div className="flex items-center gap-2">
        {capturing ? (
          <span className="text-[12px] text-primary">{t("settings.keybinds.capture")}</span>
        ) : combos.length ? (
          combos.map((combo) => <Kbd key={combo}>{formatCombo(combo)}</Kbd>)
        ) : (
          <span className="text-[12px] text-muted">{t("settings.keybinds.unassigned")}</span>
        )}
        <Button size="sm" variant="outline" onClick={() => { setConflict([]); setCapturing((value) => !value); }}>
          {capturing ? "…" : t("settings.keybinds.change")}
        </Button>
        {combos.length > 0 && (
          <Button size="icon-sm" variant="ghost" title={t("settings.keybinds.reset")} onClick={() => reset(actionId)}>
            <RotateCcw className="size-3.5" />
          </Button>
        )}
      </div>
      {conflict.length > 0 && (
        <span className="text-[11px] text-warning">
          {t("settings.keybinds.conflict", { actions: conflict.map((id) => actionLabel(t, id)).join(", ") })}
        </span>
      )}
    </div>
  );
}

export function KeybindPanel() {
  const { t } = useI18n();
  useAtom(keybindOverrides);
  const current = bindings();

  const byCategory = useMemo(() => {
    const map = new Map<KeybindCategory, string[]>();
    for (const action of KEYBIND_ACTIONS) {
      const list = map.get(action.category) ?? [];
      list.push(action.id);
      map.set(action.category, list);
    }
    return map;
  }, []);

  const readonlyByCategory = useMemo(() => {
    const map = new Map<KeybindCategory, (typeof KEYBIND_READONLY)[number][]>();
    for (const readonlyAction of KEYBIND_READONLY) {
      const list = map.get(readonlyAction.category) ?? [];
      list.push(readonlyAction);
      map.set(readonlyAction.category, list);
    }
    return map;
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[12px] text-muted">{t("settings.keybinds.description")}</p>
        <Button size="sm" variant="outline" onClick={resetAll}>{t("settings.keybinds.resetAll")}</Button>
      </div>

      {KEYBIND_CATEGORIES.map((category) => {
        const actions = byCategory.get(category) ?? [];
        const readonly = readonlyByCategory.get(category) ?? [];
        if (actions.length === 0 && readonly.length === 0) return null;
        return (
          <section key={category}>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{t(CATEGORY_LABELS[category])}</h4>
            <div className="divide-y divide-border-soft">
              {actions.map((id) => (
                <CaptureRow key={id} actionId={id} combos={current[id] ?? []} />
              ))}
              {readonly.map((entry) => (
                <div key={entry.id} className={cn("flex items-center justify-between gap-3 py-1.5")}>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{actionLabel(t, entry.id)}</span>
                  <div className="flex items-center gap-1">
                    {entry.keys.map((key) => <Kbd key={key}>{formatCombo(key)}</Kbd>)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
