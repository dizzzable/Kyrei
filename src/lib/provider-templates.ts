import type { ProviderTemplate } from "@/lib/types";
import { enCatalog, type TranslationKey } from "@/i18n/catalog";

/** Preserve gateway curation while enforcing the product invariant: Custom is last. */
export function sortProviderTemplates(templates: readonly ProviderTemplate[]): ProviderTemplate[] {
  return templates
    .map((template) => ({ ...template, models: template.models?.map((model) => ({ ...model })) }))
    .sort((left, right) => Number(Boolean(left.custom)) - Number(Boolean(right.custom)));
}

/** Gateway strings are data, not trusted translation keys. */
export function providerTemplateDescriptionKey(template: ProviderTemplate): TranslationKey | undefined {
  const key = template.descriptionKey;
  if (
    typeof key === "string"
    && key.startsWith("settings.providers.templates.")
    && key.endsWith(".description")
    && Object.hasOwn(enCatalog, key)
  ) {
    return key as TranslationKey;
  }
  // Catalog entries without per-vendor copy still get a safe generic blurb.
  if (template.protocol === "openai-chat" || template.protocol === "openai-responses") {
    const generic = "settings.providers.templates.openaiCompatible.description";
    if (Object.hasOwn(enCatalog, generic)) return generic as TranslationKey;
  }
  return undefined;
}

export function selectVisibleProviderTemplates(
  templates: readonly ProviderTemplate[],
  options: {
    query?: string;
    expanded?: boolean;
    limit?: number;
    description?: (template: ProviderTemplate) => string;
  } = {},
): { items: ProviderTemplate[]; hiddenCount: number } {
  const ordered = sortProviderTemplates(templates);
  const custom = ordered.filter((template) => template.custom);
  const standard = ordered.filter((template) => !template.custom);
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const matching = query
    ? standard.filter((template) => [
      template.name,
      template.id ?? "",
      template.protocol ?? "",
      template.baseURL ?? "",
      options.description?.(template) ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(query)))
    : standard;
  const limit = Math.max(1, options.limit ?? 12);
  const visible = options.expanded || query ? matching : matching.slice(0, limit);
  // Custom always first: "any missing vendor = paste base URL + key" is the product escape hatch.
  return { items: [...custom, ...visible], hiddenCount: Math.max(0, matching.length - visible.length) };
}
