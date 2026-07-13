export const SUPPORTED_LANGS = ["en", "ru"] as const;

export type Lang = (typeof SUPPORTED_LANGS)[number];

export type InterpolationValue = string | number | boolean | null | undefined;

export type TranslationParams = Readonly<Record<string, InterpolationValue>>;

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export type PluralMessage = Readonly<
  Partial<Record<Exclude<PluralCategory, "other">, string>> & { other: string }
>;

export type MessageValue = string | PluralMessage;

export type MessageCatalog = Readonly<Record<string, MessageValue>>;

/** Maps locale values to the exact key set of the canonical English module. */
export type LocaleFor<TCatalog extends MessageCatalog> = Readonly<{
  [TKey in keyof TCatalog]: MessageValue;
}>;

export type Translator<TKey extends string> = (
  key: TKey,
  params?: TranslationParams,
) => string;

export type NumberFormatter = (
  value: number | bigint,
  options?: Intl.NumberFormatOptions,
) => string;

export type DateFormatter = (
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
) => string;

export interface I18nApi<TKey extends string> {
  t: Translator<TKey>;
  lang: Lang;
  number: NumberFormatter;
  date: DateFormatter;
}

export interface LanguageOption {
  id: Lang;
  /** Language names are autonyms, so users can recover after choosing the wrong locale. */
  label: string;
}

export interface StorageReader {
  getItem(key: string): string | null;
}

export interface DocumentLanguageTarget {
  documentElement: { lang: string };
}
