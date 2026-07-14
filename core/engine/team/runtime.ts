import { join } from "node:path";
import type { ToolSet } from "ai";
import type {
  AgentCapability,
  EngineConfig,
  KyreiEvent,
  ProviderAttemptLifecycle,
  RuntimeSkill,
  RuntimeSkillDocumentContent,
  RuntimeTeamRole,
  RuntimeTeamSpec,
} from "../types.js";
import { buildModel, buildProviderOptions, hasProviderCredentials } from "../provider/build.js";
import { resolve as resolveModel } from "../provider/registry.js";
import { buildTools } from "../tools/index.js";
import { buildWebTools } from "../tools/web.js";
import { buildGBrainTools } from "../tools/gbrain.js";
import { buildSkillTools } from "../tools/skills.js";
import { isWorkspaceDir } from "../security/jail.js";
import { createAuditLog } from "../security/audit.js";
import { createCcrStore, makeRetrieveTool } from "../context/ccr.js";
import { assembleSystemContext } from "../memory/layers.js";
import { selectTeamRoleTools } from "./capabilities.js";
import { createTeamMemberRunner } from "./member-runner.js";
import type { TeamRoleExecutor } from "./tool.js";

const READ_ONLY_TEAM_CAPABILITIES = new Set<AgentCapability>([
  "workspace.read",
  "web",
  "memory.read",
  "skills.read",
  "delegate",
]);

function runtimeModelLimit(value: unknown, fallback: number | undefined, min: number, max: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? value as number
    : fallback;
}

export interface CreateTeamRoleExecutorsOptions {
  readonly spec: RuntimeTeamSpec;
  readonly config: EngineConfig;
  readonly workspace?: string;
  readonly auditLogPath?: string;
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
  readonly skills?: readonly RuntimeSkill[];
  readonly projectContext?: string;
  readonly sensitiveValues?: readonly string[];
  readonly emit: (event: KyreiEvent) => void;
  readonly onSkillUsed?: (id: string) => void | Promise<void>;
  readonly readSkillDocument?: (skillId: string, documentId: string) => Promise<RuntimeSkillDocumentContent | null>;
  readonly providerAttemptLifecycle?: ProviderAttemptLifecycle;
  /** Pipeline departments force the same Team runtime into a read-only mode. */
  readonly readOnly?: boolean;
}

/** Pure capability clamp used by pipeline departments before any tool is built. */
export function clampTeamRoleToReadOnly(role: RuntimeTeamRole, readOnly = true): RuntimeTeamRole {
  if (!readOnly) return role;
  const capabilities = role.capabilities.filter((capability) => READ_ONLY_TEAM_CAPABILITIES.has(capability));
  return {
    ...role,
    capabilities,
    // A nested helper is read-only too, but a role cannot create one unless
    // the profile explicitly granted the bounded delegate capability.
    canSpawn: role.canSpawn && capabilities.includes("delegate"),
  };
}

/**
 * Build private provider-bound Team executors from a gateway-resolved spec.
 * The public profile never reaches this boundary: every target is already
 * resolved by the gateway and is kept inside the engine process.
 */
export async function createTeamRoleExecutors(
  options: CreateTeamRoleExecutorsOptions,
): Promise<readonly TeamRoleExecutor[]> {
  const workspaceReady = Boolean(options.workspace) && await isWorkspaceDir(options.workspace!);
  const audit = options.auditLogPath ? createAuditLog(options.auditLogPath) : undefined;
  const ccr = workspaceReady ? createCcrStore(join(options.workspace!, ".kyrei", "ccr")) : null;
  const retrieveTools: ToolSet = ccr ? { retrieve: makeRetrieveTool(ccr) } : {};
  let projectContext = options.projectContext;
  if (projectContext === undefined && workspaceReady) {
    try {
      const assembled = await assembleSystemContext({ workspace: options.workspace! });
      projectContext = assembled.trim() ? assembled : undefined;
    } catch (error) {
      console.warn("[kyrei v2] Team project context disabled:", error);
    }
  }

  return options.spec.roles.map((configuredRole) => {
    const role = clampTeamRoleToReadOnly(configuredRole, options.readOnly === true);
    const target = role.target;
    const credentials = {
      ...(target.credentials ?? {}),
      ...(!target.credentials?.apiKey && target.apiKey ? { apiKey: target.apiKey } : {}),
    };
    if (target.requiresApiKey !== false && !hasProviderCredentials(target.protocol, credentials)) {
      throw new Error(`team_provider_credentials_missing:${role.id}`);
    }
    const entry = resolveModel(target.model, {
      baseURL: target.baseURL,
      id: target.model,
      provider: target.providerId,
      protocol: target.protocol,
    });
    const model = buildModel({
      protocol: target.protocol,
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      credentials,
      model: entry.id,
      headers: target.headers,
    });
    const assignedSkills = (options.skills ?? []).filter((skill) => role.skillIds.includes(skill.id));
    const assignedSkillTools = buildSkillTools(assignedSkills, {
      maxOutputChars: options.config.maxToolOutput,
      onUsed: options.onSkillUsed,
      ...(options.readSkillDocument ? { readDocument: options.readSkillDocument } : {}),
    });
    const canReadWorkspace = role.capabilities.includes("workspace.read");
    const roleTools = (signal: AbortSignal): ToolSet => {
      const scopedWorkspaceTools = canReadWorkspace && workspaceReady
        ? buildTools(options.workspace!, options.config, new Map(), {
            abortSignal: signal,
            audit,
            sessionId: options.sessionId,
            sensitiveValues: options.sensitiveValues,
          })
        : undefined;
      const scopedRetrieveTools = canReadWorkspace ? retrieveTools : {};
      const scopedWebTools = role.capabilities.includes("web")
        ? buildWebTools(options.config, {
            ...(audit ? { audit } : {}),
            sessionId: options.sessionId,
            signal,
            sensitiveValues: options.sensitiveValues,
          })
        : {};
      const scopedBrainTools = role.capabilities.includes("memory.read")
        ? buildGBrainTools(options.config.memory.gbrain, {
            signal,
            maxModelOutputChars: options.config.maxToolOutput,
          })
        : {};
      return selectTeamRoleTools(
        role.capabilities,
        scopedWorkspaceTools,
        scopedRetrieveTools,
        scopedWebTools,
        scopedBrainTools,
        assignedSkillTools,
      );
    };
    const resolvedRole: RuntimeTeamRole = {
      ...role,
      ...(role.promptProfileId
        ? {
            systemPrompt: options.config.promptProfiles.find(
              (profile) => profile.id === role.promptProfileId,
            )?.systemPrompt,
          }
        : {}),
      target: { ...target, model: entry.id },
    };
    return {
      role: resolvedRole,
      run: createTeamMemberRunner({
        role: resolvedRole,
        model,
        tools: roleTools,
        nestedChildTools: roleTools,
        skills: assignedSkills,
        workspace: canReadWorkspace && workspaceReady ? options.workspace : undefined,
        projectContext: canReadWorkspace ? projectContext : undefined,
        maxDepth: options.spec.limits.maxDepth,
        maxSteps: options.spec.limits.maxStepsPerAgent,
        maxRetries: options.config.apiMaxRetries,
        contextWindow: runtimeModelLimit(
          target.limits?.contextWindow,
          entry.limits.contextWindow,
          256,
          100_000_000,
        ),
        maxOutputTokens: runtimeModelLimit(
          target.limits?.maxOutput,
          entry.limits.maxOutput,
          1,
          10_000_000,
        ),
        cost: entry.cost,
        providerOptions: buildProviderOptions(target.protocol, undefined),
        emit: options.emit,
        ...(options.providerAttemptLifecycle
          ? {
              providerAttempt: {
                lifecycle: options.providerAttemptLifecycle,
                target: {
                  providerId: target.providerId,
                  ...(target.accountId ? { accountId: target.accountId } : {}),
                  modelId: entry.id,
                },
              },
            }
          : {}),
        ...(options.readOnly ? { artifactPolicy: "structured-only" } : {}),
      }),
    };
  });
}
