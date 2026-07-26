import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type TouchEvent, type WheelEvent } from "react";

export type FollowOutputMode = "following" | "paused";
export type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

const BOTTOM_FOLLOW_THRESHOLD = 24;
const TOUCH_PAUSE_THRESHOLD = 8;

interface ScrollAnchor {
  messageId: string;
  offset: number;
}

interface ScrollSnapshot {
  mode: FollowOutputMode;
  top: number;
  anchor: ScrollAnchor | null;
}

export function isNearConversationBottom(metrics: ScrollMetrics, threshold = BOTTOM_FOLLOW_THRESHOLD): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function shouldPauseFollowingForWheel(deltaY: number): boolean {
  return deltaY < -2;
}

export function shouldPauseFollowingForKey(key: string): boolean {
  return key === "ArrowUp" || key === "PageUp" || key === "Home";
}

export function shouldPauseFollowingForTouch(startY: number | null, currentY: number): boolean {
  return startY !== null && currentY - startY >= TOUCH_PAUSE_THRESHOLD;
}

function scrollToBottom(element: HTMLElement): void {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

/**
 * A snapshot taken while following is restored by scrolling to the bottom, and
 * every transition into `paused` writes a fresh anchor of its own — so an
 * anchor recorded while following is written and never read. Skipping it is
 * what keeps the per-token path free of DOM measurement.
 */
export function snapshotNeedsAnchor(mode: FollowOutputMode): boolean {
  return mode === "paused";
}

/**
 * Index of the first node whose bottom edge lies below `containerTop`.
 *
 * PRECONDITION: `bottomAt` is non-decreasing in `index`. Message wrappers are
 * document-order block siblings, so this holds; equal values (a zero-height
 * message) are fine. Returns `count - 1` when every node is above the fold,
 * matching the previous `?? nodes.at(-1)` fallback, and `-1` for an empty list.
 *
 * Replaces a linear scan from the TOP: while pinned at the bottom — the normal
 * streaming case — that measured every message that had scrolled past, once per
 * streamed token.
 */
export function firstVisibleNodeIndex(
  count: number,
  bottomAt: (index: number) => number,
  containerTop: number,
): number {
  if (count <= 0) return -1;
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (bottomAt(mid) > containerTop + 1) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found === -1 ? count - 1 : found;
}

function messageNodes(element: HTMLElement): NodeListOf<HTMLElement> {
  return element.querySelectorAll<HTMLElement>("[data-message-id]");
}

function captureAnchor(element: HTMLElement): ScrollAnchor | null {
  const nodes = messageNodes(element);
  if (nodes.length === 0) return null;
  const containerTop = element.getBoundingClientRect().top;
  const index = firstVisibleNodeIndex(
    nodes.length,
    (i) => nodes[i]!.getBoundingClientRect().bottom,
    containerTop,
  );
  const visible = nodes[index];
  if (!visible) return null;
  const messageId = visible.dataset.messageId;
  if (!messageId) return null;
  return {
    messageId,
    offset: visible.getBoundingClientRect().top - containerTop,
  };
}

function restoreAnchor(element: HTMLElement, anchor: ScrollAnchor | null): boolean {
  if (!anchor) return false;
  // Let the DOM do the lookup instead of materializing and scanning every node.
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(anchor.messageId)
    : null;
  const node = escaped
    ? element.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`)
    : [...messageNodes(element)].find((candidate) => candidate.dataset.messageId === anchor.messageId);
  if (!node) return false;
  const containerTop = element.getBoundingClientRect().top;
  const delta = node.getBoundingClientRect().top - containerTop - anchor.offset;
  if (Math.abs(delta) < 1) return true;
  element.scrollTop += delta;
  return true;
}

function withProgrammaticScroll(operation: () => void, suppressRef: MutableRefObject<boolean>): void {
  suppressRef.current = true;
  operation();
  window.requestAnimationFrame(() => {
    suppressRef.current = false;
  });
}

export function useConversationScroll(sessionId: string | null, dependencyKey: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<string | null>(sessionId);
  const snapshotsRef = useRef(new Map<string, ScrollSnapshot>());
  const suppressScrollRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  const followModeRef = useRef<FollowOutputMode>("following");
  const [followMode, setFollowMode] = useState<FollowOutputMode>("following");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const setMode = useCallback((mode: FollowOutputMode) => {
    followModeRef.current = mode;
    setFollowMode(mode);
    setShowJumpToLatest(mode === "paused");
  }, []);

  const storeSnapshot = useCallback((sessionKey: string | null, override?: Partial<ScrollSnapshot>) => {
    if (!sessionKey) return;
    const element = scrollRef.current;
    const mode = override?.mode ?? followModeRef.current;
    snapshotsRef.current.set(sessionKey, {
      mode,
      top: override?.top ?? element?.scrollTop ?? 0,
      // Callers no longer pass an anchor: whether one is worth measuring is a
      // property of the mode, and this is the only place that knows both.
      anchor: override?.anchor ?? (element && snapshotNeedsAnchor(mode) ? captureAnchor(element) : null),
    });
  }, []);

  const writeSnapshot = useCallback((override?: Partial<ScrollSnapshot>) => {
    storeSnapshot(sessionId, override);
  }, [sessionId, storeSnapshot]);

  const syncViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !sessionId) return;
    const snapshot = snapshotsRef.current.get(sessionId);
    if (followModeRef.current === "following") {
      withProgrammaticScroll(() => scrollToBottom(element), suppressScrollRef);
      writeSnapshot({ mode: "following", top: element.scrollTop });
      return;
    }
    if (!restoreAnchor(element, snapshot?.anchor ?? null)) {
      withProgrammaticScroll(() => {
        element.scrollTop = snapshot?.top ?? element.scrollTop;
      }, suppressScrollRef);
    }
    writeSnapshot({ mode: "paused", top: element.scrollTop });
  }, [sessionId, writeSnapshot]);

  const pauseFollowing = useCallback(() => {
    if (!scrollRef.current || !sessionId) return;
    setMode("paused");
    writeSnapshot({ mode: "paused" });
  }, [sessionId, setMode, writeSnapshot]);

  const resumeFollowing = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !sessionId) return;
    setMode("following");
    withProgrammaticScroll(() => scrollToBottom(element), suppressScrollRef);
    writeSnapshot({ mode: "following", top: element.scrollTop });
  }, [sessionId, setMode, writeSnapshot]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !sessionId || suppressScrollRef.current) return;
    if (isNearConversationBottom(element)) {
      setMode("following");
      writeSnapshot({ mode: "following", top: element.scrollTop });
      return;
    }
    setMode("paused");
    writeSnapshot({ mode: "paused", top: element.scrollTop });
  }, [sessionId, setMode, writeSnapshot]);

  const handleWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (shouldPauseFollowingForWheel(event.deltaY)) pauseFollowing();
  }, [pauseFollowing]);

  const handleTouchStartCapture = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const currentY = event.touches[0]?.clientY;
    if (currentY == null) return;
    if (shouldPauseFollowingForTouch(touchStartYRef.current, currentY)) pauseFollowing();
  }, [pauseFollowing]);

  const handleTouchEndCapture = useCallback(() => {
    touchStartYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey && !event.ctrlKey && !event.metaKey && shouldPauseFollowingForKey(event.key)) {
      pauseFollowing();
    }
  }, [pauseFollowing]);

  useEffect(() => {
    const previousId = sessionRef.current;
    if (previousId && previousId !== sessionId) storeSnapshot(previousId);
    sessionRef.current = sessionId;
    const snapshot = sessionId ? snapshotsRef.current.get(sessionId) : null;
    setMode(snapshot?.mode ?? "following");
    window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element || sessionRef.current !== sessionId) return;
      if (snapshot?.mode === "paused") {
        withProgrammaticScroll(() => {
          element.scrollTop = snapshot.top;
        }, suppressScrollRef);
        return;
      }
      withProgrammaticScroll(() => scrollToBottom(element), suppressScrollRef);
      writeSnapshot({ mode: "following", top: element.scrollTop });
    });
  }, [sessionId, setMode, storeSnapshot, writeSnapshot]);

  useLayoutEffect(() => {
    syncViewport();
  }, [dependencyKey, syncViewport]);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!suppressScrollRef.current) syncViewport();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId, syncViewport]);

  return {
    contentRef,
    followMode,
    handleKeyDownCapture,
    handleScroll,
    handleTouchEndCapture,
    handleTouchMoveCapture,
    handleTouchStartCapture,
    handleWheelCapture,
    resumeFollowing,
    scrollRef,
    showJumpToLatest,
  };
}
