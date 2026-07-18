import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { Message } from "@/components/Message";
import { TooltipProvider } from "@/components/ui";
import { resetUiSettings, setUiSetting } from "@/store/settings";
import type { ChatMessage } from "@/lib/types";
import { I18nProvider, setLang } from "@/i18n";

const assistantMessage: ChatMessage = {
  id: "a-1",
  role: "assistant",
  parts: [
    { type: "reasoning", text: "step by step" },
    { type: "text", text: "final answer" },
  ],
};

describe("Message reasoning visibility", () => {
  beforeEach(() => {
    resetUiSettings();
    setLang("en");
  });

  it("shows reasoning blocks by default", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: assistantMessage }))),
    );

    expect(html).toContain("Thinking");
    expect(html).toContain("final answer");
  });

  it("hides internal control markers inside reasoning blocks", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, {
          message: {
            id: "assistant-reasoning-internal-lines",
            role: "assistant",
            parts: [{
              type: "reasoning",
              id: "r1",
              state: "streaming",
              text: "Effective phase: build\n\nVisible thought summary.\n[goal-verify] hidden",
            }, {
              type: "text",
              text: "Visible answer.",
            }],
          },
        }))),
    );

    expect(html).toContain("Visible thought summary.");
    expect(html).not.toContain("Effective phase:");
    expect(html).not.toContain("[goal-verify]");
  });

  it("hides reasoning blocks when the UI preference is disabled", () => {
    setUiSetting("showReasoning", false);

    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: assistantMessage }))),
    );

    expect(html).not.toContain("Thinking");
    expect(html).toContain("final answer");
  });

  it("hides internal assistant markers while preserving the visible answer", () => {
    const internalMessage: ChatMessage = {
      id: "assistant-internal-lines",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Effective phase: build — implement now.\n\nVisible answer.\n[goal-verify] goal not confirmed",
      }],
    };

    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: internalMessage }))),
    );

    expect(html).toContain("Visible answer.");
    expect(html).not.toContain("Effective phase:");
    expect(html).not.toContain("[goal-verify]");
  });

  it("renders the exact approval scope and actions from the typed EN/RU catalogs", () => {
    const approvalMessage: ChatMessage = {
      id: "approval-message",
      role: "assistant",
      parts: [{
        type: "approval",
        approvalId: "approval-1",
        toolCallId: "call-1",
        name: "run_command",
        args: { command: "npm test" },
        reason: "permission_rule_requires_confirmation",
        status: "pending",
      }],
    };
    const render = () => renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: approvalMessage }))),
    );

    const english = render();
    expect(english).toContain("Permission required");
    expect(english).toContain("Allow once");
    expect(english).toContain("npm test");

    setLang("ru");
    const russian = render();
    expect(russian).toContain("Требуется разрешение");
    expect(russian).toContain("Разрешить один раз");
  });

  it("keeps an expired request resumable as a safe denial", () => {
    const expiredMessage: ChatMessage = {
      id: "expired-approval-message",
      role: "assistant",
      parts: [{
        type: "approval",
        approvalId: "approval-expired",
        toolCallId: "call-expired",
        name: "run_command",
        reason: "permission_rule_requires_confirmation",
        status: "expired",
      }],
    };
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: expiredMessage, onApprovalDecision: () => undefined }))),
    );

    expect(html).toContain("This request has expired");
    expect(html).toContain("Deny and continue");
    expect(html).not.toContain("Allow once");
  });

  it("expires a pending request from expiresAt and presents only safe denial in EN/RU", () => {
    const expiredMessage: ChatMessage = {
      id: "approval-expired-by-time-message",
      role: "assistant",
      parts: [{
        type: "approval",
        approvalId: "approval-expired-by-time",
        toolCallId: "call-expired-by-time",
        name: "run_command",
        reason: "permission_rule_requires_confirmation",
        status: "pending",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }],
    };
    const render = () => renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, {
          message: expiredMessage,
          onApprovalDecision: () => undefined,
        }))),
    );

    const english = render();
    expect(english).toContain("This request can no longer be approved");
    expect(english).toContain("Deny and continue");
    expect(english).not.toContain("Allow once");

    setLang("ru");
    const russian = render();
    expect(russian).toContain("Этот запрос больше нельзя разрешить");
    expect(russian).toContain("Запретить и продолжить");
    expect(russian).not.toContain("Разрешить один раз");
  });
});
