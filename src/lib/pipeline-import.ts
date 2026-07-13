import type { PipelinesConfig } from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutRevision<T extends { revision: number }>(definition: T): Omit<T, "revision"> {
  const { revision: _revision, ...rest } = definition;
  return rest;
}

/** Rebase local CAS metadata before restoring a portable backup. */
export function rebaseImportedPipelines(
  imported: unknown,
  current: PipelinesConfig,
): PipelinesConfig | undefined {
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) return undefined;
  const source = imported as Partial<PipelinesConfig>;
  if (!Array.isArray(source.definitions)) return undefined;
  const currentById = new Map(current.definitions.map((definition) => [definition.id, definition]));
  return {
    version: 1,
    generation: current.generation,
    definitions: source.definitions.map((definition) => {
      const existing = currentById.get(definition.id);
      const changed = existing
        ? canonical(withoutRevision(definition)) !== canonical(withoutRevision(existing))
        : true;
      return {
        ...definition,
        revision: existing ? existing.revision + (changed ? 1 : 0) : 1,
      };
    }),
  };
}
