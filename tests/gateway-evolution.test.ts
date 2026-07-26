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

    // Default promotionMode is "manual" → the executor runs and refuses to
    // overwrite the reserved built-in profile kyrei-main (never mutates blindly).
    const promoted = await request(`/api/evolution/candidates/${created.candidate.id}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, status: "promoted", evidence: { receipts: ["fake"] } }),
    });
    expect(promoted.status).toBe(409);
    expect(await promoted.json()).toMatchObject({ code: "executor_reserved_profile" });
  });

  it("keeps promotion unavailable when promotionMode is off", async () => {
    // Merge into the full engine — a bare {engine:{evolution}} PUT would wipe
    // promptProfiles and break team-role assignments (boundary replaces engine).
    const cfg = await (await request("/api/config")).json() as { engine?: Record<string, unknown> };
    const engine = { ...(cfg.engine ?? {}), evolution: { promotionMode: "off" } };
    const put = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ engine }),
    });
    expect(put.status).toBe(200);

    const create = await request("/api/evolution/candidates", {
      method: "POST",
      body: JSON.stringify({
        target: { kind: "skill", id: "skill:testing" },
        title: "Any candidate",
        summary: "Proposal only",
        proposal: {},
      }),
    });
    const created = await create.json() as { candidate: { id: string } };
    const promoted = await request(`/api/evolution/candidates/${created.candidate.id}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, status: "promoted", evidence: { receipts: ["fake"] } }),
    });
    expect(promoted.status).toBe(409);
    expect(await promoted.json()).toMatchObject({ code: "evolution_apply_unavailable" });
  });

  describe("canary is gated by its own mode and by risk", () => {
    // `low-risk-canary` is documented as "additionally allow canary for
    // low-risk candidates". Neither half was enforced: canary was accepted
    // under plain `manual` too, and at any risk level — so the mode was
    // indistinguishable from `manual` and its name was not a guarantee.
    const setPromotionMode = async (promotionMode: string) => {
      // Merge into the full engine: a bare PUT replaces the whole block.
      const cfg = await (await request("/api/config")).json() as { engine?: Record<string, unknown> };
      const put = await request("/api/config", {
        method: "PUT",
        body: JSON.stringify({ engine: { ...(cfg.engine ?? {}), evolution: { promotionMode } } }),
      });
      expect(put.status).toBe(200);
    };

    const createCandidate = async (risk: string) => {
      const create = await request("/api/evolution/candidates", {
        method: "POST",
        body: JSON.stringify({
          target: { kind: "skill", id: "skill:testing" },
          title: `Candidate (${risk})`,
          summary: "Proposal only",
          risk,
          proposal: {},
        }),
      });
      expect(create.status).toBe(201);
      return (await create.json() as { candidate: { id: string; risk: string } }).candidate;
    };

    const canary = (id: string) => request(`/api/evolution/candidates/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1, status: "canary", evidence: { receipts: ["manual-canary"] } }),
    });

    it("refuses canary under manual, which does not offer it", async () => {
      const candidate = await createCandidate("low");
      const response = await canary(candidate.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "evolution_canary_unavailable" });
    });

    it("refuses canary for a candidate that is not low risk", async () => {
      await setPromotionMode("low-risk-canary");
      for (const risk of ["medium", "high"]) {
        const candidate = await createCandidate(risk);
        expect(candidate.risk).toBe(risk);
        const response = await canary(candidate.id);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "evolution_canary_risk_too_high" });
      }
    });

    it("gets past both gates for a low-risk candidate in the canary mode", async () => {
      await setPromotionMode("low-risk-canary");
      const candidate = await createCandidate("low");
      const response = await canary(candidate.id);
      // The executor still has the last word (a proposal with nothing to apply
      // is refused on its own merits) — what matters here is that neither
      // canary gate is what rejected it.
      const body = await response.json() as { code?: string };
      expect(body.code).not.toBe("evolution_canary_unavailable");
      expect(body.code).not.toBe("evolution_canary_risk_too_high");
    });
  });

  it("refuses the evaluation sweep when evaluation is disabled", async () => {
    const evaluate = await request("/api/evolution/evaluate", { method: "POST" });
    expect(evaluate.status).toBe(409);
    expect(await evaluate.json()).toMatchObject({ code: "evolution_evaluation_disabled" });
  });
});
