import {
  CanvasTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  OctahedronGeometry,
  Sprite,
  SpriteMaterial,
} from "three";

/** Pixel height of the rasterised glyphs. Higher reads sharper when zoomed. */
const FONT_PX = 72;
const PAD_X = 28;

/**
 * A text label drawn into the 3D scene.
 *
 * `nodeLabel` only produces an HTML tooltip on hover, which cannot answer
 * "which part of the graph am I looking at" — the question a map has to answer
 * without being touched. So region roots get a real label in the scene.
 *
 * Deliberately only the handful of region roots, never every node: each sprite
 * carries its own canvas-backed texture and its own draw call, and a couple of
 * hundred of them is a measurable frame-rate cost.
 */
export function createAtlasLabelSprite(text: string, color: string, screenHeight: number): Sprite {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const font = `600 ${FONT_PX}px Inter, system-ui, sans-serif`;
  let width = FONT_PX * 4;
  if (context) {
    context.font = font;
    width = Math.ceil(context.measureText(text).width) + PAD_X * 2;
  }
  canvas.width = Math.max(8, width);
  canvas.height = Math.ceil(FONT_PX * 1.4);
  if (context) {
    // Resizing the canvas resets every context property, so the font has to be
    // set again here — doing it only above silently renders in the 10px default.
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    // A dark plate keeps the text readable over a bright cluster behind it.
    context.fillStyle = "rgba(8, 10, 18, 0.72)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  // Drawn on top of everything, deliberately. A region's root sits INSIDE its
  // own cluster, so a depth-tested label is swallowed by the hundreds of nodes
  // in front of it — which is exactly what happened: the names were rendered
  // and unreadable. A map key has to stay legible from any angle, and there
  // are only a handful of these.
  //
  // `sizeAttenuation: false` keeps the plate a constant fraction of the
  // VIEWPORT instead of a constant size in the world. Scaled in world units it
  // was legible in the overview and then swallowed the screen as soon as the
  // camera moved in on a directory — a 46-unit plate at 300 units away covers
  // half the view. A map label should read the same at every zoom.
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
  });
  const sprite = new Sprite(material);
  sprite.renderOrder = 10;
  sprite.scale.set(screenHeight * (canvas.width / canvas.height), screenHeight, 1);
  return sprite;
}

/** Free the texture and material a sprite owns. Neither is GC-visible to three. */
export function disposeAtlasLabelSprite(sprite: Sprite): void {
  const material = sprite.material as SpriteMaterial;
  material.map?.dispose();
  material.dispose();
}

/**
 * A directory, drawn as an octahedron instead of a sphere.
 *
 * Colour alone could not carry this: a folder is drawn in its region's hue and
 * so are all the files inside it, which left `core/` and every file under it
 * as the same teal ball — the directory structure was present in the layout
 * and invisible to the eye. A different silhouette reads at any distance and
 * at any zoom, where a size difference alone does not.
 */
export function createAtlasFolderObject(radius: number, color: string, label?: Sprite): Group {
  const group = new Group();
  const mesh = new Mesh(
    new OctahedronGeometry(radius, 0),
    new MeshLambertMaterial({ color, transparent: true, opacity: 0.95 }),
  );
  group.add(mesh);
  if (label) {
    // World units — the label's own scale is in screen units and says nothing
    // about how far above the node it has to sit to clear it.
    label.position.set(0, radius * 1.5 + 6, 0);
    group.add(label);
  }
  return group;
}

/** Release the geometry and material of a folder object built above. */
export function disposeAtlasFolderObject(group: Group): void {
  for (const child of group.children) {
    if (child instanceof Sprite) { disposeAtlasLabelSprite(child); continue; }
    if (!(child instanceof Mesh)) continue;
    child.geometry.dispose();
    const material = child.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
  }
}
