import { describe, expect, it, vi } from "vitest";
import {
  generateText,
  InvalidToolApprovalSignatureError,
  tool,
  type ModelMessage,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

const APPROVAL_SECRET = "test-only-tool-approval-secret";

function usage() {
  return {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  };
}

function toolCallModel(calls: Array<{ id: string; command: string }>) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: calls.map(({ id, command }) => ({
        type: "tool-call" as const,
        toolCallId: id,
        toolName: "run_command",
        input: JSON.stringify({ command }),
      })),
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: usage(),
      warnings: [],
    }),
  });
}

function finalModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "finished" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: usage(),
      warnings: [],
    }),
  });
}

function signedApprovalParts(messages: ModelMessage[]) {
  const assistant = messages.findLast(message => message.role === "assistant");
  if (!assistant || typeof assistant.content === "string") throw new Error("assistant approval message missing");
  const toolCall = assistant.content.find(part => part.type === "tool-call");
  const approval = assistant.content.find(part => part.type === "tool-approval-request");
  if (!toolCall || !approval) throw new Error("signed approval parts missing");
  return { assistant, toolCall, approval };
}

async function issueSignedApprovals(calls: Array<{ id: string; command: string }>) {
  const execute = vi.fn(async ({ command }: { command: string }) => `executed:${command}`);
  const tools = {
    run_command: tool({
      description: "Run a test command",
      inputSchema: z.object({ command: z.string() }),
      execute,
    }),
  };
  const initialMessages: ModelMessage[] = [{ role: "user", content: "Run the commands" }];
  const issued = await generateText({
    model: toolCallModel(calls),
    tools,
    messages: initialMessages,
    toolApproval: () => "user-approval",
    experimental_toolApprovalSecret: APPROVAL_SECRET,
  });
  const messages = structuredClone([...initialMessages, ...issued.responseMessages]) as ModelMessage[];
  return { execute, messages, tools };
}

describe("native signed tool approvals", () => {
  it.each([
    {
      name: "tool call id",
      tamper(messages: ModelMessage[]) {
        const { toolCall, approval } = signedApprovalParts(messages);
        toolCall.toolCallId = "call-tampered";
        approval.toolCallId = "call-tampered";
      },
    },
    {
      name: "tool input",
      tamper(messages: ModelMessage[]) {
        const { toolCall } = signedApprovalParts(messages);
        toolCall.input = { command: "rm -rf protected" };
      },
    },
    {
      name: "signature",
      tamper(messages: ModelMessage[]) {
        const { approval } = signedApprovalParts(messages);
        approval.signature = `${approval.signature ?? ""}tampered`;
      },
    },
  ])("fails closed when the signed $name is tampered", async ({ tamper }) => {
    const { execute, messages, tools } = await issueSignedApprovals([
      { id: "call-original", command: "npm test" },
    ]);
    tamper(messages);
    const { approval } = signedApprovalParts(messages);
    messages.push({
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true }],
    });
    const model = finalModel();
    const approvalCallback = vi.fn(() => "user-approval" as const);

    const operation = generateText({
      model,
      tools,
      messages,
      toolApproval: approvalCallback,
      experimental_toolApprovalSecret: APPROVAL_SECRET,
    });

    await expect(operation).rejects.toSatisfy(InvalidToolApprovalSignatureError.isInstance);
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("executes only the valid approved call in a mixed approve/deny continuation", async () => {
    const { execute, messages, tools } = await issueSignedApprovals([
      { id: "call-approved", command: "npm test" },
      { id: "call-denied", command: "npm publish" },
    ]);
    const assistant = messages.findLast(message => message.role === "assistant");
    if (!assistant || typeof assistant.content === "string") throw new Error("assistant approval message missing");
    const approvals = assistant.content.filter(part => part.type === "tool-approval-request");
    expect(approvals).toHaveLength(2);
    expect(approvals.every(approval => typeof approval.signature === "string" && approval.signature.length > 0)).toBe(true);
    const approved = approvals.find(approval => approval.toolCallId === "call-approved");
    const denied = approvals.find(approval => approval.toolCallId === "call-denied");
    if (!approved || !denied) throw new Error("expected approval requests missing");
    messages.push({
      role: "tool",
      content: [
        { type: "tool-approval-response", approvalId: approved.approvalId, approved: true },
        { type: "tool-approval-response", approvalId: denied.approvalId, approved: false, reason: "user denied" },
      ],
    });

    const result = await generateText({
      model: finalModel(),
      tools,
      messages,
      toolApproval: () => "user-approval",
      experimental_toolApprovalSecret: APPROVAL_SECRET,
    });

    expect(result.text).toBe("finished");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { command: "npm test" },
      expect.objectContaining({ toolCallId: "call-approved" }),
    );
    expect(JSON.stringify(result.responseMessages)).toContain("user denied");
  });
});
