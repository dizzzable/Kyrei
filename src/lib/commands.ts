export interface SlashCommand {
  name: string;
  desc: string;
  arg?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", desc: "Новый диалог" },
  { name: "model", desc: "Сменить модель", arg: "<название>" },
  { name: "theme", desc: "Сменить тему", arg: "dark | light | midnight" },
  { name: "settings", desc: "Открыть настройки" },
  { name: "help", desc: "Список команд" },
];

export function parseSlash(input: string): { name: string; arg: string } {
  const m = input.replace(/^\/+/, "").match(/^(\S+)\s*([\s\S]*)$/);
  return m ? { name: m[1], arg: m[2].trim() } : { name: "", arg: "" };
}
