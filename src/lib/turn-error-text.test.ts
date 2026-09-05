import { describe, expect, it } from "vitest";
import { turnErrorNotice } from "@/lib/turn-error-text";

describe("a turn the gateway stopped explains itself", () => {
  it("names a provider runtime change and shows it next to whatever streamed", () => {
    const notice = turnErrorNotice({ turnStatus: "interrupted", errorCode: "provider_runtime_changed" });

    // appendToContent is load-bearing: these turns keep their reasoning and a
    // stopped tool call, so a reason that only renders on an EMPTY turn never
    // renders at all — which is exactly the blank the user reported.
    expect(notice).toEqual({ key: "shell.error.providerRuntimeChanged", appendToContent: true });
  });

  it("still says something for a reason it has no copy for", () => {
    const notice = turnErrorNotice({ turnStatus: "interrupted", errorCode: "some_future_reason" });

    expect(notice).toEqual({
      key: "shell.error.interruptedByGateway",
      params: { reason: "some_future_reason" },
      appendToContent: true,
    });
  });

  it("says nothing when the user cancelled the turn themselves", () => {
    expect(turnErrorNotice({ turnStatus: "interrupted" })).toBeUndefined();
  });

  it("leaves a completed turn alone", () => {
    expect(turnErrorNotice({ turnStatus: "complete" })).toBeUndefined();
  });

  it("keeps the existing mappings for configuration and heal handoff", () => {
    expect(turnErrorNotice({ turnStatus: "error", errorCode: "provider_not_configured" })).toEqual({
      key: "shell.error.providerNotConfigured",
      appendToContent: false,
    });
    expect(turnErrorNotice({ turnStatus: "heal_handoff", errorCode: "heal_handoff" })).toEqual({
      key: "shell.error.healHandoff",
      appendToContent: true,
    });
    expect(turnErrorNotice({ turnStatus: "complete" }, true)).toEqual({
      key: "shell.error.healHandoff",
      appendToContent: true,
    });
  });

  it("prefers a specific gateway message over the generic failure line", () => {
    expect(turnErrorNotice({ turnStatus: "error", errorMessage: "upstream refused" })).toEqual({
      key: "shell.error.prefix",
      params: { message: "upstream refused" },
      appendToContent: false,
    });
    expect(turnErrorNotice({ turnStatus: "error" })).toEqual({
      key: "shell.error.fallback",
      appendToContent: false,
    });
  });
});
