import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentRunStore } from "../core/agent-run-store.js";

const roots = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "kyrei-agent-runs-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("AgentRunStore", () => {
  it("serializes concurrent checkpoints and replays the bounded ledger tail", async () => {
    const store = new AgentRunStore({ dataDir: await root(), maxEventsPerRun: 2 });
    await Promise.all([
      store.append({ agentId: "agent-1", state: "queued", attempt: 0 }),
      store.append({ agentId: "agent-1", state: "running-tool", attempt: 1 }),
      store.append({ agentId: "agent-1", state: "completed", attempt: 2 }),
    ]);

    const rows = await store.read("agent-1");
    expect(rows.map((row) => row.state)).toEqual(["running-tool", "completed"]);
    expect(await store.latest("agent-1")).toMatchObject({ state: "completed", attempt: 2 });
  });

  it("redacts secret-looking strings before persistence", async () => {
    const dataDir = await root();
    const secret = "opaque-agent-provider-secret";
    const store = new AgentRunStore({ dataDir, getSensitiveValues: () => [secret] });
    await store.append({
      agentId: "agent-secret",
      state: "running-tool",
      evidence: [`Bearer hidden-token-value`, secret],
      partialSummary: `contains ${secret}`,
    });

    const raw = await readFile(store.pathFor("agent-secret"), "utf8");
    expect(raw).not.toMatch(/hidden-token|opaque-agent-provider-secret/);
    expect(raw).toContain("[REDACTED]");
  });

  it("recovers only non-terminal read-only checkpoints and tolerates a corrupt tail", async () => {
    const dataDir = await root();
    const store = new AgentRunStore({ dataDir });
    await store.append({ agentId: "agent-recover", state: "running-tool", readOnly: true, attempt: 1 });
    await store.append({ agentId: "agent-write", state: "running-tool", readOnly: false, attempt: 1 });
    await writeFile(store.pathFor("agent-recover"), `${await readFile(store.pathFor("agent-recover"), "utf8")}{broken`, "utf8");

    const recovered = await store.recoverRecoverable();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      agentId: "agent-recover",
      state: "recovering",
      terminalReason: "gateway_restart",
    });
    expect(await store.latest("agent-write")).toMatchObject({ state: "running-tool", readOnly: false });
  });
});
