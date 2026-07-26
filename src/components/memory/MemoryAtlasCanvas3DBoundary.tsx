import { Component, type ReactNode } from "react";

/**
 * Guards the lazily-loaded 3D canvas.
 *
 * `React.lazy` rethrows a failed chunk import past `Suspense`, and this app has
 * no root boundary — so a WebGL init failure or a truncated bundle (corrupt
 * asar, interrupted update) would unmount the entire application rather than
 * just the graph pane. Catching here keeps the blast radius at one panel, and
 * `onError` lets the panel fall back to the 2D view.
 */
export class MemoryAtlasCanvas3DBoundary extends Component<
  { fallback: ReactNode; onError?: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[memory-atlas] 3D view failed, falling back to 2D", error);
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
