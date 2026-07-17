/**
 * Protected organization-account routing for the official Kiro CLI.
 *
 * The broker owns credentials and never returns them to callers. Routing is
 * delegated to ProviderAccountPoolRouter; this layer adds project policy,
 * runtime credential verification, opaque leases, generation fencing and
 * metadata-only auditing.
 */

import { randomUUID } from "node:crypto";
import { ProviderAccountPoolRouter } from "./provider-account-pool.js";
import {
  normalizeKiroOrganizationConfig,
  normalizeKiroOrganizationSecrets,
  validateKiroOrganizationAccountId,
} from "./kiro-organization-config.js";

const SAFE_FAILURE_KEYS = new Set([
  "status",
  "statusCode",
  "retryable",
  "retryAfter",
  "retryAfterMs",
  "authRequired",
  "failureClass",
  "disabled",
  "quotaExhausted",
  "entitlementDenied",
]);

export class KiroOrganizationBrokerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "KiroOrganizationBrokerError";
    this.code = code;
  }
}

function brokerError(code, message) {
  return new KiroOrganizationBrokerError(code, message);
}

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
}

function validOptionalPolicyId(value, code) {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string"
    || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value)
  ) {
    throw brokerError(code, "Kiro organization routing policy id is invalid");
  }
  return value;
}

function allows(account, key, requested) {
  if (!Object.hasOwn(account, key)) return true;
  return Boolean(requested && account[key].includes(requested));
}

function safeFailureOptions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of SAFE_FAILURE_KEYS) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

function secretChanged(left, right) {
  return left?.apiKey !== right?.apiKey;
}

function containsExactSecret(value, secret, depth = 0, seen = new WeakSet()) {
  if (typeof value === "string") return value.includes(secret);
  if (!value || typeof value !== "object") return false;
  if (depth > 12 || seen.has(value)) return true;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  if (entries.length > 1_024) return true;
  for (const [key, descriptor] of entries) {
    if (key.includes(secret) || !("value" in descriptor)) return true;
    if (containsExactSecret(descriptor.value, secret, depth + 1, seen)) return true;
  }
  return false;
}

export class KiroOrganizationBroker {
  constructor({
    config = {},
    secrets,
    worker,
    now = () => Date.now(),
    idFactory = () => randomUUID(),
    audit = () => {},
    protectedStorage = false,
    routerFactory = (options) => new ProviderAccountPoolRouter(options),
  } = {}) {
    if (!worker || typeof worker.verifyAccount !== "function" || typeof worker.discoverModels !== "function") {
      throw brokerError("kiro_organization_worker_invalid", "Kiro organization worker is invalid");
    }
    if (typeof now !== "function") throw brokerError("kiro_organization_clock_invalid", "Kiro organization clock is invalid");
    if (typeof idFactory !== "function") throw brokerError("kiro_organization_id_factory_invalid", "Kiro organization id factory is invalid");
    if (typeof audit !== "function") throw brokerError("kiro_organization_audit_invalid", "Kiro organization audit callback is invalid");
    if (typeof routerFactory !== "function") throw brokerError("kiro_organization_router_factory_invalid", "Kiro organization router factory is invalid");

    this.worker = worker;
    this.now = now;
    this.idFactory = idFactory;
    this.auditCallback = audit;
    this.protectedStorage = protectedStorage === true;
    this.routerFactory = routerFactory;
    this.config = normalizeKiroOrganizationConfig(config);
    this.secrets = normalizeKiroOrganizationSecrets(secrets);
    this._assertKnownSecretAccounts(this.secrets, this.config);
    this.generations = new Map(this.config.accounts.map((account) => [account.id, 1]));
    this.verifications = new Map();
    this.entitlementBlocks = new Map();
    this.leases = new Map();
    this.operations = new Map();
    this.epoch = 1;
    this.closed = false;
    this.router = this._createRouter();
  }

  _assertOpen() {
    if (this.closed) throw brokerError("kiro_organization_broker_closed", "Kiro organization broker is closed");
  }

  _assertKnownSecretAccounts(secrets, config) {
    const accountIds = new Set(config.accounts.map((account) => account.id));
    for (const accountId of secrets.keys()) {
      if (!accountIds.has(accountId)) {
        throw brokerError("kiro_organization_secret_account_unknown", "Kiro organization credential account is unknown");
      }
    }
  }

  _account(accountId) {
    const id = validateKiroOrganizationAccountId(accountId);
    const account = this.config.accounts.find((candidate) => candidate.id === id);
    if (!account) throw brokerError("kiro_organization_account_not_found", "Kiro organization account was not found");
    return account;
  }

  _generation(accountId) {
    return this.generations.get(accountId) ?? 0;
  }

  _isVerified(accountId) {
    const verification = this.verifications.get(accountId);
    return Boolean(
      verification
      && verification.generation === this._generation(accountId)
      && this.secrets.has(accountId),
    );
  }

  _createRouter() {
    return this.routerFactory({
      config: {
        enabled: this.config.enabled,
        strategy: this.config.strategy,
        sessionAffinity: this.config.sessionAffinity,
        members: this.config.accounts.map((account) => ({
          id: account.id,
          name: account.name,
          enabled: account.enabled && !this.entitlementBlocks.has(account.id),
          weight: account.weight,
          priority: account.priority,
          // One official KIRO_HOME is intentionally single-process.
          maxConcurrency: 1,
          status: !account.enabled || this.entitlementBlocks.has(account.id)
            ? "disabled"
            : this._isVerified(account.id)
              ? "ready"
              : "auth-required",
          ...(Object.hasOwn(account, "modelIds") ? { modelIds: [...account.modelIds] } : {}),
        })),
      },
      now: this.now,
    });
  }

  _audit(type, fields = {}) {
    const event = {
      type,
      at: safeNow(this.now),
      epoch: this.epoch,
      configRevision: this.config.revision,
      ...(typeof fields.accountId === "string" ? { accountId: fields.accountId } : {}),
      ...(typeof fields.leaseId === "string" ? { leaseId: fields.leaseId } : {}),
      ...(Number.isSafeInteger(fields.accountRevision) ? { accountRevision: fields.accountRevision } : {}),
      ...(typeof fields.reasonCode === "string" ? { reasonCode: fields.reasonCode } : {}),
    };
    try {
      this.auditCallback(Object.freeze(event));
    } catch {
      // Auditing must not expose credentials or break routing availability.
    }
  }

  _nextOpaqueId(prefix) {
    const candidate = String(this.idFactory());
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(candidate)) {
      throw brokerError("kiro_organization_opaque_id_invalid", "Kiro organization opaque id is invalid");
    }
    const id = `${prefix}-${candidate}`;
    if (this.leases.has(id) || this.operations.has(id)) {
      throw brokerError("kiro_organization_opaque_id_duplicate", "Kiro organization opaque id was already used");
    }
    return id;
  }

  _stopLease(record, reasonCode, auditType = "lease-aborted") {
    if (!this.leases.has(record.leaseId)) return false;
    this.leases.delete(record.leaseId);
    record.detachSignal?.();
    this.router.release(record.routerLease);
    if (!record.controller.signal.aborted) {
      record.controller.abort(brokerError(reasonCode, "Kiro organization lease is no longer valid"));
    }
    this._audit(auditType, {
      accountId: record.accountId,
      leaseId: record.leaseId,
      accountRevision: record.accountRevision,
      reasonCode,
    });
    return true;
  }

  _abortAccountLeases(accountId, reasonCode) {
    for (const record of [...this.leases.values()]) {
      if (record.accountId === accountId) this._stopLease(record, reasonCode);
    }
  }

  _abortAllLeases(reasonCode) {
    for (const record of [...this.leases.values()]) this._stopLease(record, reasonCode);
  }

  _abortAccountOperations(accountId, reasonCode) {
    for (const record of [...this.operations.values()]) {
      if (record.accountId !== accountId) continue;
      if (!record.controller.signal.aborted) {
        record.controller.abort(brokerError(reasonCode, "Kiro organization operation is no longer valid"));
      }
    }
  }

  _abortAllOperations(reasonCode) {
    for (const record of this.operations.values()) {
      if (!record.controller.signal.aborted) {
        record.controller.abort(brokerError(reasonCode, "Kiro organization operation is no longer valid"));
      }
    }
  }

  _bumpGeneration(accountId) {
    const current = this._generation(accountId);
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw brokerError("kiro_organization_generation_exhausted", "Kiro organization generation cannot be advanced");
    }
    this.generations.set(accountId, current + 1);
    return current + 1;
  }

  reconfigure({ config = this.config, secrets } = {}) {
    this._assertOpen();
    const nextConfig = normalizeKiroOrganizationConfig(config, { previous: this.config });
    const nextSecrets = secrets === undefined ? new Map(this.secrets) : normalizeKiroOrganizationSecrets(secrets);
    this._assertKnownSecretAccounts(nextSecrets, nextConfig);

    // Every reconfiguration is a fence, even when the serialized metadata is
    // identical. A caller that started before this point cannot continue with
    // a stale routing/security decision.
    this._abortAllLeases("kiro_organization_reconfigured");
    this._abortAllOperations("kiro_organization_reconfigured");
    this.epoch += 1;

    const oldSecrets = this.secrets;
    const oldVerifications = this.verifications;
    const oldEntitlementBlocks = this.entitlementBlocks;
    const oldGenerations = this.generations;
    const nextGenerations = new Map();
    const nextVerifications = new Map();
    const nextEntitlementBlocks = new Map();
    for (const account of nextConfig.accounts) {
      const previousGeneration = oldGenerations.get(account.id) ?? 0;
      if (previousGeneration >= Number.MAX_SAFE_INTEGER) {
        throw brokerError("kiro_organization_generation_exhausted", "Kiro organization generation cannot be advanced");
      }
      const generation = previousGeneration + 1;
      nextGenerations.set(account.id, generation);
      const verification = oldVerifications.get(account.id);
      if (verification && !secretChanged(oldSecrets.get(account.id), nextSecrets.get(account.id))) {
        nextVerifications.set(account.id, { ...verification, generation });
      }
      const entitlementBlock = oldEntitlementBlocks.get(account.id);
      if (entitlementBlock && !secretChanged(oldSecrets.get(account.id), nextSecrets.get(account.id))) {
        nextEntitlementBlocks.set(account.id, entitlementBlock);
      }
    }

    this.config = nextConfig;
    this.secrets = nextSecrets;
    this.generations = nextGenerations;
    this.verifications = nextVerifications;
    this.entitlementBlocks = nextEntitlementBlocks;
    this.router = this._createRouter();
    this._audit("reconfigured");
    return this.snapshot();
  }

  async _runCredentialOperation(accountId, kind, operation) {
    this._assertOpen();
    const account = this._account(accountId);
    const secret = this.secrets.get(account.id);
    if (!secret) throw brokerError("kiro_organization_credential_required", "Kiro organization credential is required");
    const generation = this._generation(account.id);
    const operationId = this._nextOpaqueId("kiro-operation");
    const controller = new AbortController();
    const record = { operationId, accountId: account.id, generation, controller, kind };
    this.operations.set(operationId, record);
    try {
      let result;
      try {
        result = await operation({
          accountId: account.id,
          apiKey: secret.apiKey,
          signal: controller.signal,
        });
      } catch (error) {
        if (
          controller.signal.aborted
          || generation !== this._generation(account.id)
          || secretChanged(secret, this.secrets.get(account.id))
        ) {
          throw brokerError("kiro_organization_operation_stale", "Kiro organization operation crossed a configuration fence");
        }
        if (error?.code === "kiro_organization_credential_reflected") {
          throw brokerError(
            "kiro_organization_cli_output_invalid",
            "Kiro organization worker returned unsafe credential-bearing output",
          );
        }
        throw error;
      }
      if (
        controller.signal.aborted
        || generation !== this._generation(account.id)
        || secretChanged(secret, this.secrets.get(account.id))
      ) {
        throw brokerError("kiro_organization_operation_stale", "Kiro organization operation crossed a configuration fence");
      }
      if (containsExactSecret(result, secret.apiKey)) {
        throw brokerError(
          "kiro_organization_cli_output_invalid",
          "Kiro organization worker returned unsafe credential-bearing output",
        );
      }
      return result;
    } finally {
      this.operations.delete(operationId);
    }
  }

  async verifyAccount(accountId) {
    const account = this._account(accountId);
    try {
      const result = await this._runCredentialOperation(account.id, "verify", (request) => (
        this.worker.verifyAccount(request)
      ));
      if (!result || result.verified !== true) {
        throw brokerError("kiro_organization_verification_failed", "Kiro organization credential verification failed");
      }
      const verifiedAt = safeNow(this.now);
      this.verifications.set(account.id, {
        generation: this._generation(account.id),
        verifiedAt,
        cliVersion: typeof result.cliVersion === "string" ? result.cliVersion : undefined,
      });
      this.router.reportSuccess(account.id);
      this._audit("credential-verified", {
        accountId: account.id,
        accountRevision: account.revision,
      });
      return {
        verified: true,
        accountId: account.id,
        verifiedAt,
        ...(typeof result.cliVersion === "string" ? { cliVersion: result.cliVersion } : {}),
      };
    } catch (error) {
      if (error instanceof KiroOrganizationBrokerError && error.code === "kiro_organization_operation_stale") throw error;
      if (this.generations.has(account.id)) {
        this.verifications.delete(account.id);
        this._bumpGeneration(account.id);
        this._abortAccountOperations(account.id, "kiro_organization_verification_failed");
        this._abortAccountLeases(account.id, "kiro_organization_verification_failed");
        this.router.reportFailure(account.id, { authRequired: true });
      }
      this._audit("credential-verification-failed", {
        accountId: account.id,
        accountRevision: account.revision,
        reasonCode: typeof error?.code === "string" ? error.code : "kiro_organization_verification_failed",
      });
      throw brokerError("kiro_organization_verification_failed", "Kiro organization credential verification failed");
    }
  }

  async discoverModels(accountId) {
    const account = this._account(accountId);
    if (!this._isVerified(account.id)) {
      throw brokerError("kiro_organization_verification_required", "Kiro organization credential must be verified first");
    }
    const result = await this._runCredentialOperation(account.id, "models", (request) => (
      this.worker.discoverModels(request)
    ));
    this._audit("models-discovered", {
      accountId: account.id,
      accountRevision: account.revision,
    });
    return result;
  }

  acquire(options = {}) {
    this._assertOpen();
    const source = options && typeof options === "object" && !Array.isArray(options) ? options : {};
    const modelId = validOptionalPolicyId(source.modelId, "kiro_organization_model_id_invalid");
    const projectId = validOptionalPolicyId(source.projectId, "kiro_organization_project_id_invalid");
    const excluded = new Set(
      Array.isArray(source.excludeAccountIds)
        ? source.excludeAccountIds.filter((value) => typeof value === "string")
        : [],
    );
    for (const account of this.config.accounts) {
      if (
        !this.secrets.has(account.id)
        || !this._isVerified(account.id)
        || !allows(account, "modelIds", modelId)
        || !allows(account, "projectIds", projectId)
      ) {
        excluded.add(account.id);
      }
    }

    const routerLease = this.router.acquire({
      sessionId: source.sessionId,
      preferredAccountId: source.preferredAccountId,
      accountId: source.accountId,
      excludeAccountIds: [...excluded],
      modelId,
    });
    if (!routerLease) return null;

    const account = this._account(routerLease.accountId);
    const generation = this._generation(account.id);
    if (!this._isVerified(account.id)) {
      this.router.release(routerLease);
      return null;
    }
    const leaseId = this._nextOpaqueId("kiro-lease");
    const controller = new AbortController();
    const record = {
      leaseId,
      routerLease,
      accountId: account.id,
      accountRevision: account.revision,
      generation,
      controller,
      detachSignal: null,
    };
    if (source.signal?.addEventListener) {
      const abort = () => this._stopLease(record, "kiro_organization_lease_cancelled");
      if (source.signal.aborted) {
        this.router.release(routerLease);
        controller.abort(brokerError("kiro_organization_lease_cancelled", "Kiro organization lease was cancelled"));
        return null;
      }
      source.signal.addEventListener("abort", abort, { once: true });
      record.detachSignal = () => source.signal.removeEventListener("abort", abort);
    }
    this.leases.set(leaseId, record);
    this._audit("lease-acquired", {
      accountId: account.id,
      leaseId,
      accountRevision: account.revision,
    });
    return Object.freeze({ leaseId, signal: controller.signal });
  }

  _leaseRecord(lease) {
    const leaseId = typeof lease === "string" ? lease : lease?.leaseId;
    if (typeof leaseId !== "string") {
      throw brokerError("kiro_organization_lease_invalid", "Kiro organization lease is invalid");
    }
    const record = this.leases.get(leaseId);
    if (!record) throw brokerError("kiro_organization_lease_not_found", "Kiro organization lease is no longer active");
    if (
      record.controller.signal.aborted
      || record.generation !== this._generation(record.accountId)
      || !this._isVerified(record.accountId)
    ) {
      this._stopLease(record, "kiro_organization_lease_stale");
      throw brokerError("kiro_organization_lease_stale", "Kiro organization lease crossed a configuration fence");
    }
    return record;
  }

  assertLease(lease) {
    this._assertOpen();
    this._leaseRecord(lease);
    return true;
  }

  release(lease) {
    if (this.closed) return false;
    const leaseId = typeof lease === "string" ? lease : lease?.leaseId;
    const record = this.leases.get(leaseId);
    if (!record) return false;
    this.leases.delete(record.leaseId);
    record.detachSignal?.();
    const released = this.router.release(record.routerLease);
    this._audit("lease-released", {
      accountId: record.accountId,
      leaseId: record.leaseId,
      accountRevision: record.accountRevision,
    });
    return released;
  }

  reportSuccess(lease, { sessionId } = {}) {
    this._assertOpen();
    const record = this._leaseRecord(lease);
    this.router.reportSuccess(record.accountId, { sessionId });
    this._audit("request-succeeded", {
      accountId: record.accountId,
      leaseId: record.leaseId,
      accountRevision: record.accountRevision,
    });
    return this._accountSnapshot(this._account(record.accountId));
  }

  reportFailure(lease, options = {}) {
    this._assertOpen();
    const record = this._leaseRecord(lease);
    const safeOptions = safeFailureOptions(options);
    const statusCode = Number(safeOptions.statusCode ?? safeOptions.status ?? 0);
    // Soft 403 (CDN/WAF) must not wipe verification on first blip — pool multi-strike handles it.
    // Hard 401 / explicit authRequired still revoke credentials immediately.
    const authenticationFailure = safeOptions.authRequired === true
      || safeOptions.failureClass === "auth_definite"
      || statusCode === 401;
    const entitlementFailure = safeOptions.quotaExhausted === true || safeOptions.entitlementDenied === true;
    if (entitlementFailure) {
      const reasonCode = safeOptions.quotaExhausted === true ? "quota_exhausted" : "entitlement_denied";
      this.entitlementBlocks.set(record.accountId, reasonCode);
      this._bumpGeneration(record.accountId);
      this._abortAccountOperations(record.accountId, "kiro_organization_entitlement_blocked");
      this._abortAccountLeases(record.accountId, "kiro_organization_entitlement_blocked");
      safeOptions.disabled = true;
    } else if (authenticationFailure) {
      this.verifications.delete(record.accountId);
      this._bumpGeneration(record.accountId);
      this._abortAccountOperations(record.accountId, "kiro_organization_credential_rejected");
      this._abortAccountLeases(record.accountId, "kiro_organization_credential_rejected");
    }
    const state = this.router.reportFailure(record.accountId, safeOptions);
    this._audit("request-failed", {
      accountId: record.accountId,
      leaseId: record.leaseId,
      accountRevision: record.accountRevision,
      reasonCode: entitlementFailure
        ? this.entitlementBlocks.get(record.accountId)
        : authenticationFailure
          ? "auth-required"
          : state?.status ?? "failure",
    });
    return this._accountSnapshot(this._account(record.accountId));
  }

  revoke(accountId) {
    this._assertOpen();
    const account = this._account(accountId);
    this._bumpGeneration(account.id);
    this.secrets.delete(account.id);
    this.verifications.delete(account.id);
    this.entitlementBlocks.delete(account.id);
    this._abortAccountOperations(account.id, "kiro_organization_credential_revoked");
    this._abortAccountLeases(account.id, "kiro_organization_credential_revoked");
    this.router.reportFailure(account.id, { authRequired: true });
    this._audit("credential-revoke-pending", {
      accountId: account.id,
      accountRevision: account.revision,
    });
    return this._accountSnapshot(account);
  }

  markRevocationCommitted(accountId, accountRevision) {
    this._assertOpen();
    const id = validateKiroOrganizationAccountId(accountId);
    this._audit("credential-revoked", {
      accountId: id,
      ...(Number.isSafeInteger(accountRevision) ? { accountRevision } : {}),
    });
  }

  markRevocationPersistenceFailed(accountId, accountRevision) {
    this._assertOpen();
    const id = validateKiroOrganizationAccountId(accountId);
    this._audit("credential-revoke-persist-failed", {
      accountId: id,
      ...(Number.isSafeInteger(accountRevision) ? { accountRevision } : {}),
      reasonCode: "persistence-failed",
    });
  }

  _accountSnapshot(account) {
    const runtime = this.router.getMember(account.id) ?? {};
    const hasStoredCredential = this.secrets.has(account.id);
    const verification = this._isVerified(account.id) ? this.verifications.get(account.id) : null;
    const entitlementBlock = this.entitlementBlocks.get(account.id);
    const status = !account.enabled || entitlementBlock
      ? "disabled"
      : !hasStoredCredential || !verification
        ? "auth-required"
        : runtime.status ?? "auth-required";
    return {
      id: account.id,
      name: account.name,
      revision: account.revision,
      enabled: account.enabled,
      weight: account.weight,
      priority: account.priority,
      maxConcurrency: 1,
      ...(Object.hasOwn(account, "modelIds") ? { modelIds: [...account.modelIds] } : {}),
      ...(Object.hasOwn(account, "projectIds") ? { projectIds: [...account.projectIds] } : {}),
      status,
      ...(entitlementBlock
        ? { reasonCode: entitlementBlock }
        : !hasStoredCredential
        ? { reasonCode: "credential_required" }
        : !verification
          ? { reasonCode: "verification_required" }
          : {}),
      cooldownUntil: status === "cooldown" ? Number(runtime.cooldownUntil ?? 0) : 0,
      inflight: Number(runtime.inflight ?? 0),
      hasStoredCredential,
      ...(verification ? { verifiedAt: verification.verifiedAt } : {}),
      ...(Number(runtime.lastUsedAt) > 0 ? { lastUsedAt: Number(runtime.lastUsedAt) } : {}),
    };
  }

  snapshot() {
    return {
      version: 1,
      revision: this.config.revision,
      generation: this.epoch,
      enabled: this.config.enabled,
      strategy: this.config.strategy,
      sessionAffinity: this.config.sessionAffinity,
      protectedStorage: this.protectedStorage,
      transport: "official-cli-headless",
      minimumCliVersion: "1.28.0",
      accounts: this.config.accounts.map((account) => this._accountSnapshot(account)),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._abortAllOperations("kiro_organization_broker_closed");
    this._abortAllLeases("kiro_organization_broker_closed");
    if (typeof this.worker.close === "function") await this.worker.close();
  }
}
