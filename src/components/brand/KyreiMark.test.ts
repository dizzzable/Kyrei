import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KyreiMark } from "@/components/brand/KyreiMark";

describe("KyreiMark", () => {
  it("renders the official glyph on its original coordinate system", () => {
    const html = renderToStaticMarkup(createElement(KyreiMark, { size: "lg" }));

    expect(html).toContain('viewBox="0 0 150 150"');
    expect(html).toContain("74.9 3.5 47.3 30.8");
    expect(html).toContain("70.8 150.2 55.5 150.2");
    expect(html).toContain("kyrei-mark-lg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain(">K<");
  });
});
