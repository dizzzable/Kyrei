import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };
let runKyreiChat: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-team-"));
  runKyreiChat = vi.fn(async () => ({ text: "done", parts: [] }));
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => ({ runKyreiChat, listModels: () => [] }),
  });
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

const limits = {
  maxParallel: 3,
  maxDepth: 2,
  maxAgents: 12,
  maxTasks: 12,
  maxStepsPerAgent: 8,
  timeoutMs: 180_000,
};

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: "researcher",
    name: "Researcher",
    description: "Find grounded evidence",
    instructions: "Return evidence, confidence, and open questions.",
    skillIds: [],
    capabilities: ["workspace.read", "web", "skills.read"],
    canSpawn: false,
    maxChildren: 0,
    ...overrides,
  };
}

function orchestration(roles: Array<Record<string, unknown>>) {
  return {
    defaultMode: "team",
    activeProfileId: "repo-team",
    profiles: [{
      id: "repo-team",
      name: "Repository team",
      workflow: "supervisor",
      enabled: true,
      roles,
      limits,
    }],
  };
}

async function readyMain() {
  const config = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
  const apiKey = "main-runtime-credential";
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
  return { ...config, apiKey };
}

async function addWorker(apiKey?: string) {
  await request("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      provider: {
        id: "worker-provider",
        name: "Worker provider",
        protocol: "openai-chat",
        baseURL: "https://worker.example/v1",
        models: [{ id: "worker-model" }],
        requiresApiKey: true,
      },
      ...(apiKey ? { apiKey } : {}),
    }),
  });
}

describe("gateway Team orchestration", () => {
  it("strictly validates Team settings and rejects an active uncredentialed role target", async () => {
    await readyMain();
    await addWorker();

    await expect(request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: { defaultMode: "swarm", profiles: [] } }),
    })).rejects.toThrow("orchestration_mode_invalid");

    const requested = orchestration([role({
      model: { providerId: "worker-provider", modelId: "worker-model" },
    })]);
    await expect(request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: requested }),
    })).rejects.toThrow("provider_credentials_required");

    expect(await request("/api/config")).toMatchObject({
      orchestration: { defaultMode: "single", activeProfileId: "", profiles: [] },
    });

    const workerKey = "worker-runtime-credential";
    await request("/api/providers/worker-provider/secret", {
      method: "PUT",
      body: JSON.stringify({ apiKey: workerKey }),
    });
    const saved = await request<{ orchestration: { defaultMode: string; activeProfileId: string } }>("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: requested }),
    });
    expect(saved.orchestration).toMatchObject({ defaultMode: "team", activeProfileId: "repo-team" });
    expect(JSON.stringify(saved)).not.toContain(workerKey);
  });

  it("atomically validates prompt profiles and their Team role assignments", async () => {
    await readyMain();
    const initial = await request<any>("/api/config");
    const promptProfile = {
      id: "review-policy",
      name: "Review policy",
      description: "Challenge unsupported claims",
      systemPrompt: "Require evidence and report uncertainty.",
    };
    const saved = await request<any>("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        engine: {
          ...initial.engine,
          promptProfiles: [promptProfile],
          activePromptProfileId: promptProfile.id,
        },
        orchestration: orchestration([role({ promptProfileId: promptProfile.id })]),
      }),
    });
    expect(saved.engine).toMatchObject({
      activePromptProfileId: promptProfile.id,
      promptProfiles: [promptProfile],
    });
    expect(saved.orchestration.profiles[0].roles[0].promptProfileId).toBe(promptProfile.id);

    await expect(request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ engine: {
        ...saved.engine,
        promptProfiles: [],
        activePromptProfileId: "",
      } }),
    })).rejects.toThrow("team_role_prompt_profile_unavailable");
    await expect(request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ engine: {
        ...saved.engine,
        promptProfiles: [promptProfile, promptProfile],
      } }),
    })).rejects.toThrow("engine_prompt_profile_id_invalid");
    await expect(request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ engine: {
        ...saved.engine,
        promptProfiles: [{ ...promptProfile, name: "Unsafe\nname" }],
      } }),
    })).rejects.toThrow("engine_prompt_profile_name_invalid");

    expect(await request<any>("/api/config")).toMatchObject({
      engine: { activePromptProfileId: promptProfile.id, promptProfiles: [promptProfile] },
      orchestration: { profiles: [{ roles: [{ promptProfileId: promptProfile.id }] }] },
    });
  });

  it("passes a private RuntimeTeamSpec with validated skill ids and explicit/main targets", async () => {
    const main = await readyMain();
    const workerKey = "worker-private-runtime-credential";
    await addWorker(workerKey);

    const enabled = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "team-evidence",
        description: "Collect evidence",
        content: "Verify every factual claim.",
      }),
    });
    const disabled = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "disabled-team-skill",
        description: "Disabled test skill",
        content: "This must not enter the runtime.",
      }),
    });
    await request(`/api/skills/${disabled.skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    await expect(request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        orchestration: orchestration([
          role({
            id: "specialist",
            name: "Specialist",
            model: { providerId: "worker-provider", modelId: "worker-model" },
            skillIds: [enabled.skill.id, disabled.skill.id, "missing-skill"],
          }),
          role({
            id: "reviewer",
            name: "Reviewer",
            skillIds: [disabled.skill.id, enabled.skill.id],
          }),
        ]),
      }),
    })).rejects.toThrow("team_role_skill_unavailable");

    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        orchestration: orchestration([
          role({
            id: "specialist",
            name: "Specialist",
            model: { providerId: "worker-provider", modelId: "worker-model" },
            skillIds: [enabled.skill.id],
          }),
          role({
            id: "reviewer",
            name: "Reviewer",
            skillIds: [enabled.skill.id],
          }),
        ]),
      }),
    });

    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Review this project" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));

    const engineOptions = runKyreiChat.mock.calls[0]?.[0] as {
      readSkillDocument: (skillId: string, documentId: string) => Promise<unknown>;
      team: {
        profileId: string;
        roles: Array<{
          id: string;
          target: { providerId: string; model: string; apiKey: string; credentials: { apiKey?: string } };
          skillIds: string[];
        }>;
      };
    };
    expect(engineOptions.readSkillDocument).toEqual(expect.any(Function));
    await expect(engineOptions.readSkillDocument("invalid", "invalid")).resolves.toBeNull();
    expect(engineOptions.team.profileId).toBe("repo-team");
    const specialist = engineOptions.team.roles.find((candidate) => candidate.id === "specialist");
    const reviewer = engineOptions.team.roles.find((candidate) => candidate.id === "reviewer");
    expect(specialist).toMatchObject({
      target: {
        providerId: "worker-provider",
        model: "worker-model",
        apiKey: workerKey,
        credentials: { apiKey: workerKey },
      },
      skillIds: [enabled.skill.id],
    });
    expect(reviewer).toMatchObject({
      target: {
        providerId: main.activeProviderId,
        model: main.activeModelId,
        apiKey: main.apiKey,
        credentials: { apiKey: main.apiKey },
      },
      skillIds: [enabled.skill.id],
    });

    const publicConfig = await request("/api/config");
    expect(JSON.stringify(publicConfig)).not.toContain(main.apiKey);
    expect(JSON.stringify(publicConfig)).not.toContain(workerKey);
  });

  it("falls back to Single while preserving the profile when a worker credential is cleared", async () => {
    await readyMain();
    const workerKey = "worker-to-clear-credential";
    await addWorker(workerKey);
    const requested = orchestration([role({
      model: { providerId: "worker-provider", modelId: "worker-model" },
    })]);
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: requested }),
    });

    const cleared = await request<{
      orchestration: { defaultMode: string; activeProfileId: string; profiles: Array<{ id: string; enabled: boolean }> };
    }>("/api/providers/worker-provider/secret", { method: "DELETE" });
    expect(cleared.orchestration).toMatchObject({
      defaultMode: "single",
      activeProfileId: "repo-team",
      profiles: [{ id: "repo-team", enabled: true }],
    });

    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Continue safely" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    expect(runKyreiChat.mock.calls[0]?.[0]).not.toHaveProperty("team");
  });

  it("falls back to Single when the only model-eligible Team account is disabled or deleted", async () => {
    await readyMain();
    await addWorker("worker-primary-private");
    await request("/api/providers/worker-provider/accounts/primary", {
      method: "PATCH",
      body: JSON.stringify({ account: { modelIds: [] } }),
    });
    await request("/api/providers/worker-provider/accounts", {
      method: "POST",
      body: JSON.stringify({
        account: { id: "team-backup", name: "Team backup", modelIds: ["worker-model"] },
        credentials: { apiKey: "worker-backup-private" },
      }),
    });
    await request("/api/providers/worker-provider/pool", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    const requested = orchestration([role({
      model: { providerId: "worker-provider", modelId: "worker-model" },
    })]);
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: requested }),
    });

    await request("/api/providers/worker-provider/accounts/team-backup", {
      method: "PATCH",
      body: JSON.stringify({ account: { enabled: false } }),
    });
    const afterDisable = await request<{
      orchestration: { defaultMode: string; activeProfileId: string; profiles: Array<{ id: string }> };
    }>("/api/config");
    expect(afterDisable.orchestration).toMatchObject({
      defaultMode: "single",
      activeProfileId: "repo-team",
      profiles: [{ id: "repo-team" }],
    });

    await request("/api/providers/worker-provider/accounts/team-backup", {
      method: "PATCH",
      body: JSON.stringify({ account: { enabled: true } }),
    });
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: requested }),
    });
    await request("/api/providers/worker-provider/accounts/team-backup", { method: "DELETE" });
    const afterDelete = await request<{
      orchestration: { defaultMode: string; activeProfileId: string; profiles: Array<{ id: string }> };
    }>("/api/config");
    expect(afterDelete.orchestration).toMatchObject({
      defaultMode: "single",
      activeProfileId: "repo-team",
      profiles: [{ id: "repo-team" }],
    });
  });

  it("serves authenticated, redacted Team run ledgers", async () => {
    await readyMain();
    const secretMarker = "ledger-private-credential";
    runKyreiChat.mockImplementationOnce(async (options: { emit(event: unknown): void }) => {
      options.emit({
        type: "team.start",
        payload: {
          run_id: "team-run-1",
          profile_id: "repo-team",
          workflow: "supervisor",
          task_count: 1,
          credentials: { apiKey: secretMarker },
        },
      });
      options.emit({
        type: "team.complete",
        payload: {
          run_id: "team-run-1",
          profile_id: "repo-team",
          status: "completed",
          completed_tasks: 1,
          failed_tasks: 0,
        },
      });
      return { text: "done", parts: [] };
    });

    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Record the run" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/team-runs/team-run-1`);
    expect(unauthorized.status).toBe(401);
    const ledger = await request<{ runId: string; events: Array<{ type: string }> }>("/api/team-runs/team-run-1");
    expect(ledger.runId).toBe("team-run-1");
    expect(ledger.events.map((event) => event.type)).toEqual(["team.start", "team.complete"]);
    expect(JSON.stringify(ledger)).not.toContain(secretMarker);
    expect(JSON.stringify(ledger)).toContain("[REDACTED]");
  });

  it("redacts exact runtime credentials from events, ledgers, and persisted assistant output", async () => {
    const main = await readyMain();
    runKyreiChat.mockImplementationOnce(async (options: { emit(event: unknown): void }) => {
      options.emit({
        type: "team.start",
        payload: { run_id: "team-exact-redaction", profile_id: "repo-team", workflow: "supervisor" },
      });
      options.emit({
        type: "subagent.complete",
        payload: {
          run_id: "team-exact-redaction",
          subagent_id: "researcher-1",
          goal: "Verify credential boundaries",
          summary: `Provider reflected ${main.apiKey}`,
        },
      });
      options.emit({
        type: "team.complete",
        payload: { run_id: "team-exact-redaction", profile_id: "repo-team", status: "completed" },
      });
      return {
        text: `Safe answer after ${main.apiKey}`,
        parts: [{ type: "text", text: `Nested ${main.apiKey}` }],
      };
    });

    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Test exact credential redaction" }),
    });

    let transcript: { messages: Array<{ role: string; content: string; parts?: unknown[] }> } | undefined;
    await vi.waitFor(async () => {
      transcript = await request(`/api/sessions/${session.id}/messages`);
      expect(transcript.messages.at(-1)?.role).toBe("assistant");
    });

    const status = await request<{ agents: Array<{ summary?: string }> }>("/api/status");
    const ledger = await request("/api/team-runs/team-exact-redaction");
    const publicOutput = JSON.stringify({ status, ledger, transcript });
    expect(publicOutput).not.toContain(main.apiKey);
    expect(publicOutput).toContain("[REDACTED]");
  });
});
