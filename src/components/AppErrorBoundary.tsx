import { Component, type ReactNode } from "react";

/**
 * Root boundary.
 *
 * Until this existed `main.tsx` rendered `&lt;App /&gt;` bare, and the only boundary
 * in the tree guarded the 3D memory canvas. Any throw on the transcript render
 * path — a malformed SSE payload reaching a reducer, a KaTeX or
 * `react-markdown` edge case, a truncated lazy chunk after an interrupted
 * update — unmounted the whole application and left a blank window with no way
 * back short of killing the process.
 *
 * Deliberately dependency-free: no i18n, no design-system imports, no store
 * reads. Whatever broke the app may be exactly those, and a boundary that
 * throws while rendering its own fallback is worse than none.
 */
const FALLBACK_TITLE = "Something broke while rendering.";
const FALLBACK_BODY =
  "Your sessions are stored on disk and were not affected. Reloading rebuilds the window from that state.";
const MESSAGE_FALLBACK =
  "This message could not be displayed. The rest of the conversation is unaffected.";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error("[kyrei] unhandled render error", error, info);
  }

  private reload = () => {
    this.setState({ error: null });
    globalThis.location?.reload();
  };

  private dismiss = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          alignItems: "flex-start",
          padding: "2rem",
          height: "100%",
          overflow: "auto",
          font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
          color: "#e6e6e6",
          background: "#0b0d10",
        }}
      >
        <strong style={{ fontSize: "15px" }}>{FALLBACK_TITLE}</strong>
        <p style={{ margin: 0, maxWidth: "44rem", color: "#a8a8a8" }}>{FALLBACK_BODY}</p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {/* Untranslated on purpose: I18nProvider sits *inside* this boundary,
              so a failure in i18n itself is one of the cases this must render
              through. Calling t() here could throw while handling a throw. */}
          <button type="button" onClick={this.reload} style={buttonStyle(true)}>Reload</button>{/* i18n-data-ok */}
          <button type="button" onClick={this.dismiss} style={buttonStyle(false)}>Try to continue</button>{/* i18n-data-ok */}
        </div>
        <pre
          style={{
            margin: 0,
            maxWidth: "100%",
            maxHeight: "16rem",
            overflow: "auto",
            padding: "0.75rem",
            borderRadius: "6px",
            background: "#15181d",
            color: "#c8c8c8",
            fontSize: "11.5px",
            whiteSpace: "pre-wrap",
          }}
        >
          {error.stack || `${error.name}: ${error.message}`}
        </pre>
      </div>
    );
  }
}

/**
 * Per-message boundary for the transcript. Keeps a single malformed part — a
 * reasoning payload the reducers did not expect, a code fence that trips the
 * highlighter — from unmounting the whole conversation.
 */
export class MessageErrorBoundary extends Component<
  { messageId: string; contentKey?: string | number; children: ReactNode },
  { failed: boolean; seenKey: string | number | undefined }
> {
  state = { failed: false, seenKey: undefined as string | number | undefined };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  /**
   * Retry when the message's content changes.
   *
   * Without this the boundary latched forever: `App` keys the wrapper by the
   * stable `message.id`, so React reuses the instance, and one throw on a
   * MID-STREAM partial payload replaced that message with the fallback for the
   * rest of the session — even after it completed and would have rendered fine.
   */
  static getDerivedStateFromProps(
    props: { contentKey?: string | number },
    state: { failed: boolean; seenKey: string | number | undefined },
  ) {
    if (state.seenKey === props.contentKey) return null;
    return { failed: false, seenKey: props.contentKey };
  }

  componentDidCatch(error: unknown) {
    console.error(`[kyrei] message ${this.props.messageId} failed to render`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="rounded-md border border-danger/35 bg-danger/8 px-3 py-2 text-[11px] text-danger">
        {MESSAGE_FALLBACK}
      </div>
    );
  }
}

function buttonStyle(primary: boolean): Record<string, string> {
  return {
    padding: "0.375rem 0.875rem",
    borderRadius: "6px",
    border: primary ? "1px solid #3f6fd8" : "1px solid #2a2f37",
    background: primary ? "#3f6fd8" : "transparent",
    color: primary ? "#ffffff" : "#d0d0d0",
    cursor: "pointer",
    font: "inherit",
  };
}
