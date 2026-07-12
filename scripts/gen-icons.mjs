/**
 * Generate app icons from assets/icon.svg (and a PNG of the logo lockup).
 *
 * Output (committed, used by electron-builder + the renderer):
 *   assets/icon.ico  — multi-size Windows icon (16..256)
 *   assets/icon.png  — 1024px master (Linux/mac fallback)
 *   assets/logo.png  — 512px logo lockup for README/branding
 *
 * Uses @resvg/resvg-js (SVG raster) + png-to-ico. No native build step.
 */
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const assets = join(root, "assets");

function renderPng(svg, width) {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true },
  });
  return r.render().asPng();
}

const iconSvg = await readFile(join(assets, "icon.svg"), "utf8");

// ICO needs several sizes bundled together for crisp rendering everywhere.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((s) => renderPng(iconSvg, s));
const ico = await pngToIco(icoPngs);
await writeFile(join(assets, "icon.ico"), ico);

// 1024px master PNG (Linux .desktop / macOS conversion / general use).
await writeFile(join(assets, "icon.png"), renderPng(iconSvg, 1024));

// Logo lockup PNG for README/branding.
const logoSvg = await readFile(join(assets, "logo.svg"), "utf8");
await writeFile(join(assets, "logo.png"), renderPng(logoSvg, 512));

console.log("[gen-icons] wrote assets/icon.ico, assets/icon.png, assets/logo.png");
