import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };

const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, {
  ...init,
  headers: {
    "Content-Type": "application/json",
    "X-Kyrei-Gateway-Token": server.token,
    ...(init.headers ?? {}),
  },
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-evolution-"));
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => import("../core/engine/.dist/index.mjs"),
  });
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("gateway evolution control plane", () => {
  it("journals redacted proposals without applying them", async () => {
    const create = await request("/api/evolution/candidates", {
      method: "POST",
      body: JSON.stringify({
        target: { kind: "skill", id: "skill:testing" },
        title: "Improve testing guidance",
        summary: "Proposal only",
        proposal: { append: "Run the repository gate." },
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { candidate: { id: string; status: string; revision: number } };
    expect(created.candidate).toMatchObject({ status: "pending", revision: 1 });

    const listed = await request("/api/evolution/candidates");
    const body = await listed.json() as { config: { promotionMode: string }; candidates: Array<{ id: string }> };
    expect(listed.status).toBe(200);
    expect(body.config.promotionMode).toBe("manual");
    expect(body.candidates.map((candidate) => candidate.id)).toContain(created.candidate.id);

    const rejected = await request(`/api/evolution/candidates/${encodeURIComponent(created.candidate.id)}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, status: "rejected", reason: "Human review" }),
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ candidate: { status: "rejected", revision: 2 } });
  });

  it("fails closed when model evaluation or deterministic apply is unavailable", async () => {
    const create = await request("/api/evolution/candidates", {
      method: "POST",
      body: JSON.stringify({
        target: { kind: "prompt-profile", id: "kyrei-main" },
        title: "Candidate profile change",
        summary: "Requires independent evaluation.",
        proposal: { append: "Collect evidence." },
      }),
    });
    const created = await create.json() as { candidate: { id: string } };

    const evaluating = await request(`/api/evolution/candidates/${created.candidate.id}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, status: "evaluating" }),
    });
    expect(evaluating.status).toBe(409);
    expect(await evaluating.json()).toMatchObject({ code: "evolution_evaluation_disabled" });

    const promoted = await request(`/api/evolution/candidates/${created.candidate.id}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, status: "promoted", evidence: { receipts: ["fake"] } }),
    });
    expect(promoted.status).toBe(409);
    expect(await promoted.json()).toMatchObject({ code: "evolution_apply_unavailable" });
  });
});
