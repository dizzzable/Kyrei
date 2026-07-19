import { join } from "node:path";
import type { ToolSet } from "ai";
import type {
  AgentCapability,
  EngineConfig,
  KyreiEvent,
  ProviderAttemptLifecycle,
  RuntimeSkill,
  RuntimeSkillDocumentContent,
  RuntimeSkillReadResult,
  RuntimeSkillReadUnavailable,
  RuntimeTeamRole,
  RuntimeTeamSpec,
} from "../types.js";
import type { ModelParams } from "../types.js";
import type { CodingMode } from "../coding-mode.js";
import { buildModel, buildProviderOptions, hasProviderCredentials, resolveTurnModelParams } from "../provider/build.js";
import { resolve as resolveModel } from "../provider/registry.js";
import { buildTools } from "../tools/index.js";
import { buildWebTools } from "../tools/web.js";
import { buildGBrainTools } from "../tools/gbrain.js";
import { buildPlanningTools } from "../tools/planning.js";
import { buildOpenVikingTools } from "../tools/openviking.js";
import { buildMemorySearchTools } from "../tools/memory-search.js";
import { buildMemoryAskTools } from "../tools/memory-ask.js";
import { buildSkillTools } from "../tools/skills.js";
import { codingModePrompt, normalizeCodingMode } from "../coding-mode.js";
import { isWorkspaceDir } from "../security/jail.js";
import { createAuditLog } from "../security/audit.js";
import { createCcrStore, makeRetrieveTool } from "../context/ccr.js";
import { assembleSystemContext } from "../memory/layers.js";
import type { MemoryStore, VectorStore } from "../data/ports.js";
import { selectTeamRoleTools } from "./capabilities.js";
import { createTeamMemberRunner } from "./member-runner.js";
import { createTeamResearchCacheRegistry } from "./research-cache.js";
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
  readonly readSkill?: (skillId: string) => Promise<RuntimeSkillReadResult | RuntimeSkillReadUnavailable | null>;
  readonly readSkillDocument?: (skillId: string, documentId: string) => Promise<RuntimeSkillDocumentContent | null>;
  readonly providerAttemptLifecycle?: ProviderAttemptLifecycle;
  /** Pipeline departments force the same Team runtime into a read-only mode. */
  readonly readOnly?: boolean;
  /** Shared rebuildable FTS projection from the parent turn (read-only for team). */
  readonly memoryStore?: MemoryStore;
  readonly vectorStore?: VectorStore;
  readonly indexBackend?: string;
  readonly globalMemoryDir?: string;
  /**
   * Turn-level model params (effort/reasoning). Resolved with engine defaults
   * so Team roles inherit the same thinking policy as main when supported.
   */
  readonly modelParams?: ModelParams;
  /** Parent turn's effective start mode, including a forced long-task plan gate. */
  readonly codingMode?: CodingMode;
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
  // Each Team delegate/department execution creates one combined AbortSignal.
  // Bind a small exact-result cache to that signal so all parallel roles share
  // it, while later executions always start from an empty cache.
  const researchCaches = createTeamResearchCacheRegistry({
    config: options.config,
    sensitiveValues: options.sensitiveValues,
  });
  let projectContext = options.projectContext;
  if (projectContext === undefined && workspaceReady) {
    try {
      const assembled = await assembleSystemContext({
        workspace: options.workspace!,
        ...(options.config.memory?.ltm?.enabled ? { ltmDir: join(options.workspace!, "ltm") } : {}),
        ...(options.config.planning?.enabled ? { includePlan: true } : {}),
        ...(options.globalMemoryDir ? { globalDir: options.globalMemoryDir } : {}),
      });
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
      ...(options.readSkill ? { readSkill: options.readSkill } : {}),
      ...(options.readSkillDocument ? { readDocument: options.readSkillDocument } : {}),
    });
    const canReadWorkspace = role.capabilities.includes("workspace.read");
    const canReadMemory = role.capabilities.includes("memory.read");
    const roleTools = (signal: AbortSignal): ToolSet => {
      const ltmDir =
        options.config.memory?.ltm?.enabled && workspaceReady
          ? join(options.workspace!, "ltm")
          : undefined;
      // Session id is passed for ledger correlation; decision *writes* stay
      // blocked by the capability allowlist (record/invalidate not listed).
      const scopedWorkspaceTools = canReadWorkspace && workspaceReady
        ? buildTools(options.workspace!, options.config, new Map(), {
            abortSignal: signal,
            audit,
            sessionId: options.sessionId,
            sensitiveValues: options.sensitiveValues,
            ...(ltmDir ? { ltmDir } : {}),
          })
        : undefined;
      const scopedRetrieveTools = canReadWorkspace ? retrieveTools : {};
      const scopedWebTools = role.capabilities.includes("web")
        ? researchCaches.forSignal(signal).wrapWebTools(
            buildWebTools(options.config, {
              ...(audit ? { audit } : {}),
              sessionId: options.sessionId,
              signal,
              sensitiveValues: options.sensitiveValues,
            }),
          )
        : {};
      const scopedBrainTools = canReadMemory
        ? buildGBrainTools(options.config.memory.gbrain, {
            signal,
            maxModelOutputChars: options.config.maxToolOutput,
            // Team members must use the same profile-level Kyrei Memory as
            // their parent. Without this, built-in memory refused to expose
            // tools because it correctly had no safe directory to open.
            ...(options.globalMemoryDir ? { dataDir: options.globalMemoryDir } : {}),
            sensitiveValues: options.sensitiveValues,
          })
        : {};
      const scopedPlanningTools =
        (canReadWorkspace || canReadMemory) && workspaceReady && options.config.planning?.enabled
          ? buildPlanningTools({
              workspace: options.workspace!,
              maxModelOutputChars: options.config.maxToolOutput,
            })
          : {};
      const scopedOpenVikingTools = canReadMemory
        ? buildOpenVikingTools(
            {
              enabled: Boolean(options.config.memory.openviking?.enabled),
              ...(options.config.memory.openviking?.baseURL
                ? { baseURL: options.config.memory.openviking.baseURL }
                : {}),
            },
            { maxModelOutputChars: options.config.maxToolOutput },
          )
        : {};
      // Decision tools without a session still expose query_decisions; when a
      // session id is present writes exist on the ToolSet but are allowlist-denied.
      const scopedDecisionTools =
        canReadMemory && workspaceReady && options.config.memory?.ltm?.enabled
          ? buildTools(options.workspace!, options.config, new Map(), {
              abortSignal: signal,
              sessionId: options.sessionId,
              ...(ltmDir ? { ltmDir } : {}),
            })
          : {};
      const scopedMemorySearch =
        canReadMemory && workspaceReady
          ? buildMemorySearchTools({
              workspace: options.workspace!,
              ...(ltmDir ? { ltmDir, ltmEnabled: true } : { ltmEnabled: false }),
              planningEnabled: Boolean(options.config.planning?.enabled),
              maxModelOutputChars: options.config.maxToolOutput,
              indexBackend: options.indexBackend ?? "off",
              ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
              ...(options.vectorStore ? { vectorStore: options.vectorStore } : {}),
              ...(options.config.memory?.vault ? { vault: options.config.memory.vault } : {}),
              ...(options.config.memory?.recall ? { recall: options.config.memory.recall } : {}),
              ...(options.config.memory?.citeOrRefuse
                ? {
                    citeOrRefuse: {
                      enabled: options.config.memory.citeOrRefuse.enabled,
                      minTopScore: options.config.memory.citeOrRefuse.minTopScore,
                      minHits: options.config.memory.citeOrRefuse.minHits,
                    },
                  }
                : {}),
            })
          : {};
      const scopedMemoryAsk =
        canReadMemory && workspaceReady
          ? buildMemoryAskTools({
              workspace: options.workspace!,
              ...(ltmDir ? { ltmDir, ltmEnabled: true } : { ltmEnabled: false }),
              maxModelOutputChars: options.config.maxToolOutput,
              ...(options.config.memory?.vault?.enabled ? { vault: options.config.memory.vault } : {}),
              citeOrRefuse: {
                minTopScore: options.config.memory?.citeOrRefuse?.minTopScore ?? 4,
                minHits: options.config.memory?.citeOrRefuse?.minHits ?? 1,
              },
            })
          : {};
      return selectTeamRoleTools(
        role.capabilities,
        scopedWorkspaceTools,
        scopedRetrieveTools,
        scopedWebTools,
        scopedBrainTools,
        scopedPlanningTools,
        scopedOpenVikingTools,
        scopedDecisionTools,
        scopedMemorySearch,
        scopedMemoryAsk,
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
        codingModeHint: codingModePrompt(options.codingMode ?? normalizeCodingMode(options.config.codingMode)),
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
        // Inherit turn/default effort so Anthropic/Google/OpenAI thinking works on roles.
        providerOptions: target.reasoningTransport
          ? buildProviderOptions(
            target.protocol,
            resolveTurnModelParams(options.modelParams, options.config.defaultReasoningEffort),
            target.reasoningTransport,
          )
          : buildProviderOptions(
            target.protocol,
            resolveTurnModelParams(options.modelParams, options.config.defaultReasoningEffort),
          ),
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
