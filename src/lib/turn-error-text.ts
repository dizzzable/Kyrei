import type { TranslationKey } from "@/i18n/catalog";
import type { StoredChatMessage } from "@/lib/types";

export interface TurnErrorNotice {
  key: TranslationKey;
  /** Interpolation params, when the key takes any. */
  params?: Record<string, string>;
  /**
   * Show the line even when the turn persisted real content. A turn the gateway
   * cancelled mid-run keeps its reasoning and its stopped tool call, so without
   * this nothing on screen says why the answer never arrived.
   */
  appendToContent: boolean;
}

/**
 * Why a finished turn should carry an explanatory line, and whether that line
 * has to appear alongside content the turn did produce.
 *
 * Kept pure and separate from the renderer because the case it exists for is
 * exactly the one that produced no visible output: a turn aborted by a
 * configuration save was stored `interrupted` with empty text, so the chat
 * showed a truncated row and no reason at all.
 */
export function turnErrorNotice(
  message: Pick<StoredChatMessage, "errorCode" | "errorMessage" | "turnStatus">,
  hadLegacyHealHandoff = false,
): TurnErrorNotice | undefined {
  if (message.errorCode === "provider_runtime_changed") {
    return { key: "shell.error.providerRuntimeChanged", appendToContent: true };
  }
  if (message.errorCode === "provider_not_configured") {
    return { key: "shell.error.providerNotConfigured", appendToContent: false };
  }
  if (message.errorCode === "heal_handoff" || hadLegacyHealHandoff) {
    return { key: "shell.error.healHandoff", appendToContent: true };
  }
  if (message.errorMessage) {
    return {
      key: "shell.error.prefix",
      params: { message: message.errorMessage },
      appendToContent: false,
    };
  }
  // An unmapped reason still beats a blank turn: the code names the cause well
  // enough to search for, and silence here is what made these aborts look like
  // the model simply having nothing to say.
  if (message.turnStatus === "interrupted" && message.errorCode) {
    return {
      key: "shell.error.interruptedByGateway",
      params: { reason: message.errorCode },
      appendToContent: true,
    };
  }
  if (message.turnStatus === "error") return { key: "shell.error.fallback", appendToContent: false };
  return undefined;
}
