import { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { gateway } from "@/lib/gateway";
import type { AppConfig } from "@/lib/types";

interface SettingsProps {
  config: AppConfig;
  onClose: () => void;
  onSaved: (config: AppConfig) => void;
}

export function Settings({ config, onClose, onSaved }: SettingsProps) {
  const [provider, setProvider] = useState(config.provider);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState(config.workspace);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickFolder = async () => {
    const r = await gateway.chooseFolder();
    if (r.folder) setWorkspace(r.folder);
  };

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, string> = { provider, model, workspace };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      const next = await gateway.setConfig(patch);
      onSaved(next);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60";
  const label = "mb-1.5 block text-[12px] font-medium text-secondary";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Настройки</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground"><X size={18} /></button>
        </div>

        <div className="space-y-3.5">
          <div>
            <label className={label}>Провайдер (Base URL)</label>
            <input className={field} value={provider} onChange={e => setProvider(e.target.value)} placeholder="https://api.openai.com/v1" />
          </div>
          <div>
            <label className={label}>API-ключ {config.hasKey && <span className="text-muted">(сохранён — оставьте пустым, чтобы не менять)</span>}</label>
            <input className={field} type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={config.hasKey ? "••••••••" : "sk-…"} />
          </div>
          <div>
            <label className={label}>Модель</label>
            <input className={field} value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini" />
          </div>
          <div>
            <label className={label}>Рабочая папка (включает инструменты работы с файлами)</label>
            <div className="flex gap-2">
              <input className={field} value={workspace} onChange={e => setWorkspace(e.target.value)} placeholder="не выбрана" />
              <button onClick={pickFolder} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] text-secondary hover:bg-white/[0.04]">
                <FolderOpen size={15} /> Выбрать
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-[13px] text-secondary hover:bg-white/[0.04]">Отмена</button>
          <button onClick={save} disabled={saving} className="rounded-lg bg-primary-strong px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
