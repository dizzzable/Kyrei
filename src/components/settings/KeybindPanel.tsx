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

const CATEGORY_LABELS: Record<KeybindCategory, string> = {
  composer: "Композер",
  session: "Сессии",
  navigation: "Навигация",
  view: "Вид",
};

const ACTION_LABELS: Record<string, string> = {
  "composer.focus": "Фокус на поле ввода",
  "composer.modelPicker": "Открыть выбор модели",
  "composer.send": "Отправить сообщение",
  "composer.newline": "Перенос строки",
  "composer.cancel": "Отменить / закрыть",
  "composer.mention": "Упоминание файла",
  "composer.slash": "Слэш-команда",
  "session.new": "Новый диалог",
  "session.next": "Следующий диалог",
  "session.prev": "Предыдущий диалог",
  "session.focusSearch": "Поиск по диалогам",
  "session.togglePin": "Закрепить / открепить",
  "nav.commandPalette": "Командная палитра",
  "nav.settings": "Открыть настройки",
  "view.toggleSidebar": "Показать / скрыть сайдбар",
  "view.toggleExplorer": "Показать / скрыть файлы",
  "appearance.toggleMode": "Переключить светлую / тёмную",
  "keybinds.openPanel": "Показать сочетания клавиш",
};

const label = (id: string) => ACTION_LABELS[id] ?? id;

function CaptureRow({ actionId, combos }: { actionId: string; combos: string[] }) {
  const [capturing, setCapturing] = useState(false);
  const [conflict, setConflict] = useState<string[]>([]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // waiting for a non-modifier key
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
      <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">{label(actionId)}</span>
      <div className="flex items-center gap-2">
        {capturing ? (
          <span className="text-[12px] text-primary">Нажмите сочетание… (Esc — отмена)</span>
        ) : combos.length ? (
          combos.map((c) => <Kbd key={c}>{formatCombo(c)}</Kbd>)
        ) : (
          <span className="text-[12px] text-muted">не задано</span>
        )}
        <Button size="sm" variant="outline" onClick={() => { setConflict([]); setCapturing((v) => !v); }}>
          {capturing ? "…" : "Изменить"}
        </Button>
        {combos.length > 0 && (
          <Button size="icon-sm" variant="ghost" title="Сбросить" onClick={() => reset(actionId)}>
            <RotateCcw className="size-3.5" />
          </Button>
        )}
      </div>
      {conflict.length > 0 && (
        <span className="text-[11px] text-warning">Конфликт: {conflict.map(label).join(", ")}</span>
      )}
    </div>
  );
}

export function KeybindPanel() {
  // Re-render whenever the override diff changes.
  useAtom(keybindOverrides);
  const current = bindings();

  const byCategory = useMemo(() => {
    const map = new Map<KeybindCategory, string[]>();
    for (const a of KEYBIND_ACTIONS) {
      const list = map.get(a.category) ?? [];
      list.push(a.id);
      map.set(a.category, list);
    }
    return map;
  }, []);

  const readonlyByCategory = useMemo(() => {
    const map = new Map<KeybindCategory, (typeof KEYBIND_READONLY)[number][]>();
    for (const r of KEYBIND_READONLY) {
      const list = map.get(r.category) ?? [];
      list.push(r);
      map.set(r.category, list);
    }
    return map;
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted">Настройте сочетания. Изменённые хранятся как разница с дефолтами.</p>
        <Button size="sm" variant="outline" onClick={resetAll}>Сбросить все</Button>
      </div>

      {KEYBIND_CATEGORIES.map((cat) => {
        const actions = byCategory.get(cat) ?? [];
        const readonly = readonlyByCategory.get(cat) ?? [];
        if (actions.length === 0 && readonly.length === 0) return null;
        return (
          <section key={cat}>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{CATEGORY_LABELS[cat]}</h4>
            <div className="divide-y divide-border-soft">
              {actions.map((id) => (
                <CaptureRow key={id} actionId={id} combos={current[id] ?? []} />
              ))}
              {readonly.map((r) => (
                <div key={r.id} className={cn("flex items-center justify-between gap-3 py-1.5")}>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{label(r.id)}</span>
                  <div className="flex items-center gap-1">
                    {r.keys.map((k) => <Kbd key={k}>{formatCombo(k)}</Kbd>)}
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
