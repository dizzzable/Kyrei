import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { SkillsStore } from "../core/skills-store.js";

let dataDir = "";
let workspace = "";
let selectedFolder = "";
let openedPath = "";
let engineLoader = vi.fn();
/** Shared chat mock — gateway caches engine after OOB bootstrap at start. */
let runKyreiChat = vi.fn();
let server: { port: number; token: string; close(): Promise<void> };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-capabilities-"));
  workspace = join(dataDir, "workspace");
  await mkdir(workspace);
  selectedFolder = workspace;
  openedPath = "";
  runKyreiChat = vi.fn(async () => ({
    text: "done",
    parts: [],
    status: "complete",
    attempts: [],
  }));
  // Real engine exports (bootstrap / stores) + stable runKyreiChat mock for the process lifetime.
  engineLoader = vi.fn(async () => {
    const engine = await import("../core/engine/.dist/index.mjs");
    return { ...engine, runKyreiChat };
  });
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    chooseFolder: async () => selectedFolder,
    openPath: async (path: string) => { openedPath = path; },
    engineLoader,
  });
});

afterEach(async () => {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
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

describe("gateway operational capabilities", () => {
  it("connects workspace Skills to CRUD, enablement, roots, and live status", async () => {
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspace }),
    });

    const created = await request<{ skill: { id: string; name: string; provenance: string; content: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "repo-guide",
        description: "Repository conventions",
        content: "Read the architecture notes before changing code.",
        rootId: "workspace",
      }),
    });
    expect(created.skill).toMatchObject({ name: "repo-guide", provenance: "workspace" });
    expect(created.skill.content).toContain("architecture notes");

    const listed = await request<{ skills: Array<{ id: string; enabled: boolean }>; roots: Array<{ id: string; provenance: string }> }>("/api/skills");
    expect(listed.skills).toContainEqual(expect.objectContaining({ id: created.skill.id, enabled: true }));
    expect(listed.roots.some(root => root.provenance === "workspace")).toBe(true);

    await request(`/api/skills/${created.skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    const status = await request<{ skills: { enabled: number; total: number }; cron: { total: number }; agents: unknown[] }>("/api/status");
    expect(status.skills).toEqual({ enabled: 0, total: 1 });
    expect(status.cron.total).toBe(0);
    expect(status.agents).toEqual([]);

    await request(`/api/skills/${created.skill.id}`, { method: "DELETE" });
    expect((await request<{ skills: unknown[] }>("/api/skills")).skills).toEqual([]);
  });

  it("mounts external Skills folders read-only and opens only configured roots", async () => {
    const external = join(dataDir, "external-skills");
    await mkdir(join(external, "reviewer"), { recursive: true });
    await writeFile(join(external, "reviewer", "SKILL.md"), "---\nname: reviewer\ndescription: Review changes\n---\n\nReview the diff.\n", "utf8");
    const canonicalExternal = await realpath(external);
    selectedFolder = external;

    const roots = await request<{ roots: Array<{ id: string; path: string; provenance: string; owned: boolean }> }>("/api/skills/roots", { method: "POST" });
    const custom = roots.roots.find(root => root.provenance === "custom");
    expect(custom).toMatchObject({ path: canonicalExternal, owned: false });

    const listed = await request<{ skills: Array<{ name: string; owned: boolean }> }>("/api/skills");
    expect(listed.skills).toContainEqual(expect.objectContaining({ name: "reviewer", owned: false }));
    await request(`/api/skills/roots/${encodeURIComponent(custom!.id)}/open`, { method: "POST" });
    expect(openedPath).toBe(canonicalExternal);

    await request(`/api/skills/roots/${encodeURIComponent(custom!.id)}`, { method: "DELETE" });
    expect((await request<{ skills: unknown[] }>("/api/skills")).skills).toEqual([]);
  });

  it("forwards only explicitly selected standalone Skills for a normal chat turn", async () => {
    // runKyreiChat is the same mock cached at gateway start (bootstrap loads engine once).
    const config = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "selected-skill-credential" }),
    });
    const selected = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "selected", content: "Use the selected workflow." }),
    });
    await request("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "other", content: "Do not inject this skill." }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Apply the chosen skill", skillIds: [selected.skill.id] }),
    });

    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    const options = runKyreiChat.mock.calls[0]?.[0] as {
      skills: Array<{ id: string }>;
      requiredSkillIds?: string[];
    };
    expect(options.skills.map((skill) => skill.id)).toEqual([selected.skill.id]);
    expect(options.requiredSkillIds).toEqual([selected.skill.id]);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
      },
      body: JSON.stringify({ session: session.id, text: "Invalid skill", skillIds: ["not-a-skill"] }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "prompt_skills_invalid" });
  });

  it("does not advertise disabled or unavailable ambient Skills to a normal chat turn", async () => {
    const config = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "ambient-skill-credential" }),
    });
    const enabled = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "available-ambient", content: "Available ambient workflow." }),
    });
    const disabled = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "disabled-ambient", content: "Disabled ambient workflow." }),
    });
    await request(`/api/skills/${disabled.skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Discover an available workflow" }),
    });

    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    const options = runKyreiChat.mock.calls[0]?.[0] as {
      skills: Array<{ id: string }>;
      requiredSkillIds?: string[];
    };
    expect(options.skills.map((skill) => skill.id)).toEqual([enabled.skill.id]);
    expect(options.requiredSkillIds).toBeUndefined();
  });

  it("fails open for ambient skill runtime load errors", async () => {
    const runtimeSkills = vi.spyOn(SkillsStore.prototype, "catalogSkills")
      .mockRejectedValueOnce(new Error("skill runtime unavailable"));
    try {
      const config = await request<{ activeProviderId: string }>("/api/config");
      await request(`/api/providers/${config.activeProviderId}/secret`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: "ambient-skill-credential" }),
      });
      await request("/api/skills", {
        method: "POST",
        body: JSON.stringify({ name: "ambient", content: "Ambient workflow." }),
      });
      const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

      await request("/api/prompt", {
        method: "POST",
        body: JSON.stringify({ session: session.id, text: "Run without explicit skill selection" }),
      });

      await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
      const options = runKyreiChat.mock.calls[0]?.[0] as {
        skills: Array<{ id: string }>;
        requiredSkillIds?: string[];
      };
      expect(options.skills).toEqual([]);
      expect(options.requiredSkillIds).toBeUndefined();
    } finally {
      runtimeSkills.mockRestore();
    }
  });

  it("blocks model execution when an explicit selected Skill cannot be materialized at runtime", async () => {
    const runtimeSkills = vi.spyOn(SkillsStore.prototype, "catalogSkills")
      .mockRejectedValueOnce(Object.assign(new Error("requested skill unavailable"), { code: "skill_catalog_incomplete" }));
    try {
      const config = await request<{ activeProviderId: string }>("/api/config");
      await request(`/api/providers/${config.activeProviderId}/secret`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: "strict-skill-credential" }),
      });
      const selected = await request<{ skill: { id: string } }>("/api/skills", {
        method: "POST",
        body: JSON.stringify({ name: "selected", content: "Strict workflow." }),
      });
      const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

      await request("/api/prompt", {
        method: "POST",
        body: JSON.stringify({ session: session.id, text: "Must use selected skill", skillIds: [selected.skill.id] }),
      });

      await vi.waitFor(() => expect(runtimeSkills).toHaveBeenCalledTimes(1));
      expect(runKyreiChat).not.toHaveBeenCalled();
    } finally {
      runtimeSkills.mockRestore();
    }
  });

  it("forwards both exact selected ids when same-name Skills collide", async () => {
    const config = await request<{ activeProviderId: string }>("/api/config");
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspace }),
    });
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "duplicate-skill-credential" }),
    });
    const first = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "duplicate", content: "First workflow.", rootId: "workspace" }),
    });
    const second = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "duplicate", content: "Second workflow." }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({
        session: session.id,
        text: "Use both exact skills",
        skillIds: [first.skill.id, second.skill.id],
      }),
    });

    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    const options = runKyreiChat.mock.calls[0]?.[0] as {
      skills: Array<{ id: string }>;
      requiredSkillIds?: string[];
    };
    expect(options.skills.map((skill) => skill.id)).toEqual([first.skill.id, second.skill.id]);
    expect(options.requiredSkillIds).toEqual([first.skill.id, second.skill.id]);
  });

  it("exposes durable Cron CRUD, pause/resume, and run history", async () => {
    const created = await request<{ job: { id: string; name: string; schedule: string; enabled: boolean; nextRunAt: string } }>("/api/cron/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "Daily review", prompt: "Review the repository", schedule: "15 9 * * 1-5" }),
    });
    expect(created.job).toMatchObject({ name: "Daily review", schedule: "15 9 * * 1-5", enabled: true });
    expect(created.job.nextRunAt).toBeTruthy();

    const paused = await request<{ job: { enabled: boolean; nextRunAt?: string } }>(`/api/cron/jobs/${created.job.id}/pause`, { method: "POST" });
    expect(paused.job.enabled).toBe(false);
    expect(paused.job.nextRunAt).toBeUndefined();

    const resumed = await request<{ job: { enabled: boolean; nextRunAt: string } }>(`/api/cron/jobs/${created.job.id}/resume`, { method: "POST" });
    expect(resumed.job.enabled).toBe(true);
    expect(resumed.job.nextRunAt).toBeTruthy();
    expect(await request(`/api/cron/jobs/${created.job.id}/runs`)).toEqual({ runs: [] });

    await request(`/api/cron/jobs/${created.job.id}`, { method: "DELETE" });
    expect(await request("/api/cron/jobs")).toEqual({ jobs: [] });
  });

  it("cancels a prompt waiting in Skills setup before loading the engine", async () => {
    let enteredSetup!: () => void;
    let releaseSetup!: (value: {
      skills: never[];
      total: number;
      included: number;
      truncated: boolean;
      unavailable: never[];
    }) => void;
    const setupEntered = new Promise<void>((resolve) => { enteredSetup = resolve; });
    const setupGate = new Promise<{
      skills: never[];
      total: number;
      included: number;
      truncated: boolean;
      unavailable: never[];
    }>((resolve) => { releaseSetup = resolve; });
    const runtimeSkills = vi.spyOn(SkillsStore.prototype, "catalogSkills")
      .mockImplementation(async () => {
        enteredSetup();
        return setupGate;
      });

    try {
      const config = await request<{ activeProviderId: string }>("/api/config");
      await request(`/api/providers/${config.activeProviderId}/secret`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: "shutdown-capability-test-credential" }),
      });
      const created = await request<{ id: string }>("/api/sessions", { method: "POST" });
      // Session create may already load the engine for session-mirror dual-write.
      // This test asserts cancel/shutdown during Skills setup does not start a chat turn.
      engineLoader.mockClear();
      await request("/api/prompt", {
        method: "POST",
        body: JSON.stringify({ session: created.id, text: "Run during shutdown" }),
      });
      await setupEntered;

      const closing = server.close();
      releaseSetup({ skills: [], total: 0, included: 0, truncated: false, unavailable: [] });
      await closing;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(engineLoader).not.toHaveBeenCalled();
    } finally {
      runtimeSkills.mockRestore();
    }
  });
});
