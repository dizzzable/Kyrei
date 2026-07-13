import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TeamRunStore } from "../core/team-run-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "kyrei-team-runs-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("TeamRunStore", () => {
  it("serializes concurrent appends in order and replays a bounded public ledger", async () => {
    const store = new TeamRunStore({ dataDir: await root(), maxEventsPerRun: 3 });
    await Promise.all([
      store.append("run:one", { type: "team.start", payload: { sequence: 1 } }),
      store.append("run:one", { type: "task.start", payload: { sequence: 2 } }),
      store.append("run:one", { type: "task.complete", payload: { sequence: 3 } }),
      store.append("run:one", { type: "team.complete", payload: { sequence: 4 } }),
    ]);

    const events = await store.read("run:one");
    expect(events.map((event) => event.payload.sequence)).toEqual([2, 3, 4]);
    expect(events.every((event) => event.runId === "run:one")).toBe(true);
  });

  it("redacts credential fields and secret-looking strings before persistence", async () => {
    const dataDir = await root();
    const exactRuntimeSecret = "opaque-provider-credential-value";
    const store = new TeamRunStore({ dataDir, getSensitiveValues: () => [exactRuntimeSecret] });
    await store.append("run-secret", {
      type: "task.complete",
      payload: {
        apiKey: "must-not-persist",
        credentials: { sessionToken: "must-not-persist" },
        summary: `provider returned sk-example0123456789abcdef, Bearer hidden-token-value, and ${exactRuntimeSecret}`,
        nested: { safe: "evidence" },
      },
    });

    const raw = await readFile(store.pathFor("run-secret"), "utf8");
    expect(raw).not.toMatch(/must-not-persist|sk-example|hidden-token|opaque-provider-credential/);
    expect(raw).toContain("[REDACTED]");
    expect((await store.read("run-secret"))[0]?.payload.nested.safe).toBe("evidence");
  });

  it("ignores a corrupt trailing line and marks unfinished runs interrupted on recovery", async () => {
    const dataDir = await root();
    const store = new TeamRunStore({ dataDir });
    await store.append("unfinished", { type: "team.start", payload: { profileId: "team" } });
    await writeFile(store.pathFor("unfinished"), `${await readFile(store.pathFor("unfinished"), "utf8")}{broken`, "utf8");

    const recovered = await store.recoverInterrupted();
    expect(recovered).toEqual(["unfinished"]);
    expect((await store.read("unfinished")).at(-1)).toMatchObject({
      type: "team.interrupted",
      payload: { reason: "gateway_restart" },
    });

    expect(await store.recoverInterrupted()).toEqual([]);
  });
});
