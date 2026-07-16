/**
 * Window-level drag-and-drop guard.
 *
 * In an Electron renderer, dropping a file (or an image dragged from another
 * app) anywhere outside an element that explicitly handles the event makes
 * Chromium navigate the window to that file/blob URL. That silently unloads
 * the whole single-page app — which looks like the app "crashing" when a user
 * drags an image into the chat.
 *
 * The renderer is a closed desktop workspace that never wants a default
 * file-drop navigation. This guard cancels the browser default for drag/drop
 * at the window boundary. Components that intentionally accept a drop (the
 * composer) still work: they call `stopPropagation()` before this listener
 * runs on the bubbling window, and they read the data in their own handler.
 */

const NOOP = () => undefined;

export function installWindowDropGuard(target: Window = window): () => void {
  if (typeof target?.addEventListener !== "function") return NOOP;

  const cancel = (event: DragEvent) => {
    // Allow a component that opted in (composer) to keep the drop: it marks the
    // event handled by calling preventDefault() itself. If nothing handled it,
    // block the browser's default file navigation.
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.type === "drop" && event.dataTransfer) {
      // Clearing the effect avoids a lingering "copy" cursor after the block.
      try { event.dataTransfer.dropEffect = "none"; } catch { /* read-only in some engines */ }
    }
  };

  target.addEventListener("dragover", cancel);
  target.addEventListener("drop", cancel);
  return () => {
    target.removeEventListener("dragover", cancel);
    target.removeEventListener("drop", cancel);
  };
}
