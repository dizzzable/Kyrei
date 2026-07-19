import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider, setLang } from "@/i18n";

const mocks = vi.hoisted(() => ({
  sidebar: vi.fn<(props: { onDelete?: (id: string) => void }) => null>(() => null),
}));

vi.mock("@/components/Sidebar", () => ({ Sidebar: mocks.sidebar }));

import { ActivityRail } from "./ActivityRail";

describe("ActivityRail session actions", () => {
  it("forwards permanent deletion to the session sidebar", () => {
    setLang("en");
    renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ActivityRail, {
        sessions: [],
        currentId: null,
        onSelect: () => undefined,
        onNew: () => undefined,
        onArchive: () => undefined,
        onDelete: () => undefined,
        onRename: () => undefined,
        onOpenActivity: () => undefined,
        onHome: () => undefined,
        onOpenSettings: () => undefined,
        onOpenPalette: () => undefined,
      }),
    ));

    expect(mocks.sidebar.mock.calls[0]?.[0]).toMatchObject({
      onDelete: expect.any(Function),
    });
  });
});
