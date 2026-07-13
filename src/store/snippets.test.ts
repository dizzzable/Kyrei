import { describe, expect, it } from "vitest";

import { createTranslator } from "@/i18n/translate";
import { enChat } from "@/i18n/locales/en/chat";
import { ruChat } from "@/i18n/locales/ru/chat";
import { getBuiltInSnippets, resolveSnippets } from "@/store/snippets";

describe("built-in prompt snippets", () => {
  it("keeps stable ids while resolving title and prompt text per locale", () => {
    const en = getBuiltInSnippets(createTranslator(enChat, "en"));
    const ru = getBuiltInSnippets(createTranslator(ruChat, "ru"));

    expect(en.map((snippet) => snippet.id)).toEqual(ru.map((snippet) => snippet.id));
    expect(en[0]).toMatchObject({
      id: "builtin:explain",
      builtIn: true,
      title: "Explain code",
    });
    expect(ru[0]).toMatchObject({
      id: "builtin:explain",
      builtIn: true,
      title: "Объяснить код",
    });
    expect(en[0]?.text).not.toBe(ru[0]?.text);
  });

  it("keeps user-created snippets unchanged across locales", () => {
    const user = { id: "s-user", title: "My title", text: "My prompt" };
    const resolved = resolveSnippets([user], createTranslator(ruChat, "ru"));

    expect(resolved.at(-1)).toEqual(user);
    expect(resolved.at(-1)).toBe(user);
  });
});
