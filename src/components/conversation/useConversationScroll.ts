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

function messageNodes(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]"));
}

function captureAnchor(element: HTMLElement): ScrollAnchor | null {
  const nodes = messageNodes(element);
  if (nodes.length === 0) return null;
  const containerTop = element.getBoundingClientRect().top;
  const visible = nodes.find((node) => node.getBoundingClientRect().bottom > containerTop + 1) ?? nodes[nodes.length - 1];
  const messageId = visible.dataset.messageId;
  if (!messageId) return null;
  return {
    messageId,
    offset: visible.getBoundingClientRect().top - containerTop,
  };
}

function restoreAnchor(element: HTMLElement, anchor: ScrollAnchor | null): boolean {
  if (!anchor) return false;
  const node = messageNodes(element).find((candidate) => candidate.dataset.messageId === anchor.messageId);
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
    snapshotsRef.current.set(sessionKey, {
      mode: override?.mode ?? followModeRef.current,
      top: override?.top ?? element?.scrollTop ?? 0,
      anchor: override?.anchor ?? (element ? captureAnchor(element) : null),
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
      writeSnapshot({ mode: "following", top: element.scrollTop, anchor: captureAnchor(element) });
      return;
    }
    if (!restoreAnchor(element, snapshot?.anchor ?? null)) {
      withProgrammaticScroll(() => {
        element.scrollTop = snapshot?.top ?? element.scrollTop;
      }, suppressScrollRef);
    }
    writeSnapshot({ mode: "paused", top: element.scrollTop, anchor: captureAnchor(element) });
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
    writeSnapshot({ mode: "following", top: element.scrollTop, anchor: captureAnchor(element) });
  }, [sessionId, setMode, writeSnapshot]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !sessionId || suppressScrollRef.current) return;
    if (isNearConversationBottom(element)) {
      setMode("following");
      writeSnapshot({ mode: "following", top: element.scrollTop, anchor: captureAnchor(element) });
      return;
    }
    setMode("paused");
    writeSnapshot({ mode: "paused", top: element.scrollTop, anchor: captureAnchor(element) });
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
      writeSnapshot({ mode: "following", top: element.scrollTop, anchor: captureAnchor(element) });
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
