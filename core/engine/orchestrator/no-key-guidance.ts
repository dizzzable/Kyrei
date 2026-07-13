import type { KyreiEvent, RunKyreiChatResult } from "../types.js";

export function emitNoKeyGuidance(emit: (e: KyreiEvent) => void): RunKyreiChatResult {
  const guidance =
    "⚠️ **Не задан API-ключ провайдера.**\n\n" +
    "Откройте **Настройки** и укажите провайдера (Base URL), API-ключ и модель. " +
    "Например: `https://api.openai.com/v1`, `https://api.deepseek.com/v1` или `https://openrouter.ai/api/v1`. " +
    "Для локального режима — `http://localhost:11434/v1` (Ollama) или `http://localhost:1234/v1` (LM Studio).";
  emit({ type: "message.delta", payload: { text: guidance } });
  emit({ type: "message.complete", payload: { text: guidance, status: "complete" } });
  return { text: guidance, parts: [{ type: "text", text: guidance }], status: "complete", attempts: [] };
}
