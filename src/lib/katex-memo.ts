/**
 * Memoizing wrapper around rehype-katex (ported from Hermes' katex-memo,
 * adapted to a plain unified rehype plugin for react-markdown).
 *
 * During streaming, each token re-runs the markdown pipeline; the stock
 * rehype-katex re-renders EVERY equation on every token. This LRU-cached
 * transform re-runs KaTeX only for equations whose source actually changed, so
 * steady-state work is proportional to "new equations", not "equations × tps".
 *
 * Pair with `remark-math` in remarkPlugins. Requires `katex/dist/katex.min.css`
 * (imported once by the renderer, bundled — offline, no CDN).
 */

import type { Element, ElementContent, Parent, Root } from "hast";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import { toText } from "hast-util-to-text";
import katex from "katex";
import { SKIP, visitParents } from "unist-util-visit-parents";
import type { VFile } from "vfile";

type CachedRender = ElementContent[];

const CACHE_LIMIT = 512;

class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  get(key: K): undefined | V {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= CACHE_LIMIT) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const cache = new LruCache<string, CachedRender>();

function cacheKey(displayMode: boolean, value: string): string {
  return `${displayMode ? "d" : "i"}\u0001${value}`;
}

const ERROR_COLOR = "var(--color-danger)";

function renderMath(value: string, displayMode: boolean, file: VFile, element: Element): ElementContent[] {
  let html: string;
  try {
    html = katex.renderToString(value, { displayMode, throwOnError: true });
  } catch (error) {
    file.message("Could not render math with KaTeX", { place: element.position });
    try {
      html = katex.renderToString(value, { displayMode, errorColor: ERROR_COLOR, strict: "ignore", throwOnError: false });
    } catch {
      return [
        {
          type: "element",
          tagName: "span",
          properties: { className: ["katex-error"], style: `color:${ERROR_COLOR}`, title: String(error) },
          children: [{ type: "text", value }],
        },
      ];
    }
  }
  return fromHtmlIsomorphic(html, { fragment: true }).children as ElementContent[];
}

/** Unified rehype plugin — pass to react-markdown `rehypePlugins`. */
export function memoizedRehypeKatex() {
  return function transform(tree: Root, file: VFile): undefined {
    visitParents(tree, "element", (element, parents) => {
      const classes = Array.isArray(element.properties?.className) ? (element.properties!.className as string[]) : [];
      const languageMath = classes.includes("language-math");
      const mathDisplay = classes.includes("math-display");
      const mathInline = classes.includes("math-inline");
      if (!(languageMath || mathDisplay || mathInline)) return;

      let displayMode = mathDisplay;
      let scope: Element = element;
      let parent: Parent | undefined = parents[parents.length - 1];

      if (languageMath && parent && parent.type === "element" && (parent as Element).tagName === "pre") {
        scope = parent as Element;
        parent = parents[parents.length - 2];
        displayMode = true;
      }
      if (!parent) return;

      const value = toText(scope, { whitespace: "pre" });
      const key = cacheKey(displayMode, value);
      let cached = cache.get(key);
      if (!cached) {
        cached = renderMath(value, displayMode, file, scope);
        cache.set(key, cached);
      }
      const cloned = cached.map((child) => structuredClone(child));
      const index = parent.children.indexOf(scope as ElementContent);
      if (index === -1) return;
      parent.children.splice(index, 1, ...cloned);
      return SKIP;
    });
  };
}
