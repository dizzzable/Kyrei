const OPEN_ESCAPE_LAYER_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[data-radix-popper-content-wrapper] [data-state="open"]',
].join(", ");

export interface EscapeKeyLike {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface EscapeInterruptOptions {
  event: EscapeKeyLike;
  streaming: boolean;
  stopping: boolean;
  hasOpenLayer?: boolean;
}

export function hasOpenEscapeLayer(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(OPEN_ESCAPE_LAYER_SELECTOR) != null;
}

export function shouldInterruptSessionFromEscape({
  event,
  streaming,
  stopping,
  hasOpenLayer = false,
}: EscapeInterruptOptions): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (hasOpenLayer || !streaming || stopping) return false;
  return true;
}
