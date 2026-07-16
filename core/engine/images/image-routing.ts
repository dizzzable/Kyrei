/**
 * Hermes-style image input routing for user-attached images.
 *
 * - native: multimodal image parts on the user turn (pixels to the model)
 * - text:   path / label only in text (no pixel payload) — for non-vision models
 * - auto:   native when the active model reports image input support
 */

export type ImageInputMode = "auto" | "native" | "text";
export type ResolvedImagePresentation = "native" | "text";

const VALID: ReadonlySet<string> = new Set(["auto", "native", "text"]);

export function coerceImageInputMode(value: unknown): ImageInputMode {
  if (typeof value !== "string") return "auto";
  const v = value.trim().toLowerCase();
  return VALID.has(v) ? (v as ImageInputMode) : "auto";
}

/**
 * Decide how user-attached images should be presented for this turn.
 * @param mode config `imageInputMode` (Hermes `agent.image_input_mode`)
 * @param modelSupportsVision true when active model modalities include image
 */
export function decideImagePresentation(
  mode: ImageInputMode | string | undefined,
  modelSupportsVision: boolean,
): ResolvedImagePresentation {
  const m = coerceImageInputMode(mode);
  if (m === "native") return "native";
  if (m === "text") return "text";
  return modelSupportsVision ? "native" : "text";
}

/** Detect vision capability from common Kyrei / models.dev shapes. */
export function modelSupportsImageInput(model: unknown): boolean {
  if (!model || typeof model !== "object") return false;
  const m = model as Record<string, unknown>;
  if (m.supportsVision === true || m.supports_vision === true || m.vision === true) return true;
  const caps = m.capabilities;
  if (caps && typeof caps === "object") {
    const c = caps as Record<string, unknown>;
    if (c.image_input === true || c.imageInput === true || c.vision === true) return true;
    const input = c.inputModalities ?? c.input_modalities;
    if (Array.isArray(input) && input.some((x) => String(x).toLowerCase() === "image")) return true;
  }
  const modalities = m.modalities;
  if (modalities && typeof modalities === "object") {
    const input = (modalities as Record<string, unknown>).input;
    if (Array.isArray(input) && input.some((x) => String(x).toLowerCase() === "image")) return true;
  }
  const inputMods = m.inputModalities ?? m.input_modalities;
  if (Array.isArray(inputMods) && inputMods.some((x) => String(x).toLowerCase() === "image")) return true;
  return false;
}
