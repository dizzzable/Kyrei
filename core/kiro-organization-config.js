/**
 * Strict configuration boundary for Kiro organization accounts.
 *
 * Public routing metadata and API-key material intentionally use separate
 * normalizers. Never add a credential-shaped field to the public account
 * schema: snapshots produced from this module are safe to serialize.
 */

export const MAX_KIRO_ORGANIZATION_ACCOUNTS = 64;

const CONFIG_VERSION = 1;
const MAX_NAME_LENGTH = 120;
const MAX_POLICY_IDS = 512;
const MAX_POLICY_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 8_192;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const STRATEGIES = new Set(["balanced", "round-robin", "fill-first"]);
const CONFIG_KEYS = new Set(["version", "revision", "enabled", "strategy", "sessionAffinity", "accounts"]);
const ACCOUNT_KEYS = new Set([
  "id",
  "name",
  "revision",
  "enabled",
  "weight",
  "priority",
  "maxConcurrency",
  "modelIds",
  "projectIds",
]);
const SECRET_KEYS = new Set(["apiKey"]);
const SECRET_ENVELOPE_KEYS = new Set(["version", "accounts"]);
const STORED_SECRET_KEYS = new Set(["kind", "apiKey"]);

export class KiroOrganizationConfigError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "KiroOrganizationConfigError";
    this.code = code;
  }
}

function configError(code, message) {
  return new KiroOrganizationConfigError(code, message);
}

function record(value, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(code, `${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(source, allowed, code, label) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw configError(code, `${label} contains an unsupported field`);
  }
}

function strictBoolean(value, fallback, code) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw configError(code, "Kiro organization boolean field is invalid");
  return value;
}

function strictInteger(value, fallback, min, max, code) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configError(code, "Kiro organization numeric field is invalid");
  }
  return value;
}

function revision(value, fallback = 1) {
  return strictInteger(value, fallback, 1, Number.MAX_SAFE_INTEGER, "kiro_organization_revision_invalid");
}

function nextRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw configError("kiro_organization_revision_exhausted", "Kiro organization revision cannot be advanced");
  }
  return value + 1;
}

function validateRevisionWindow(sourceRevision, previousRevision) {
  if (sourceRevision === undefined) return;
  const candidate = revision(sourceRevision);
  if (candidate < previousRevision || candidate > nextRevision(previousRevision)) {
    throw configError("kiro_organization_revision_conflict", "Kiro organization revision conflicts with current state");
  }
}

export function validateKiroOrganizationAccountId(value) {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw configError("kiro_organization_account_id_invalid", "Kiro organization account id is invalid");
  }
  return value;
}

function normalizedName(value) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > MAX_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw configError("kiro_organization_account_name_invalid", "Kiro organization account name is invalid");
  }
  return value;
}

function normalizedPolicyIds(source, key) {
  if (!Object.hasOwn(source, key) || source[key] === null) return undefined;
  const values = source[key];
  if (!Array.isArray(values) || values.length > MAX_POLICY_IDS) {
    throw configError("kiro_organization_policy_invalid", "Kiro organization policy list is invalid");
  }
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (
      typeof value !== "string"
      || value.length > MAX_POLICY_ID_LENGTH
      || !POLICY_ID_PATTERN.test(value)
      || seen.has(value)
    ) {
      throw configError("kiro_organization_policy_id_invalid", "Kiro organization policy id is invalid");
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function withoutRevision(account) {
  const { revision: _revision, ...metadata } = account;
  return metadata;
}

function sameAccount(left, right) {
  return JSON.stringify(withoutRevision(left)) === JSON.stringify(withoutRevision(right));
}

function previousOption(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  return Object.hasOwn(options, "previous") ? options.previous : null;
}

/**
 * Normalize one public account descriptor.
 *
 * Missing modelIds/projectIds means unrestricted. An explicit empty array is
 * preserved and means that no model/project is eligible. Kiro CLI profile
 * concurrency is deliberately fixed at one until upstream documents a safe
 * multi-process contract for one KIRO_HOME.
 */
export function normalizeKiroOrganizationAccount(value, options = {}) {
  const source = record(
    value,
    "kiro_organization_account_invalid",
    "Kiro organization account",
  );
  rejectUnknownKeys(
    source,
    ACCOUNT_KEYS,
    "kiro_organization_account_field_invalid",
    "Kiro organization account",
  );

  const index = strictInteger(options?.index, 0, 0, MAX_KIRO_ORGANIZATION_ACCOUNTS - 1, "kiro_organization_account_index_invalid");
  const previous = previousOption(options);
  const normalized = {
    id: validateKiroOrganizationAccountId(source.id),
    name: normalizedName(source.name),
    revision: revision(source.revision),
    enabled: strictBoolean(source.enabled, true, "kiro_organization_account_enabled_invalid"),
    weight: strictInteger(source.weight, 1, 1, 100, "kiro_organization_account_weight_invalid"),
    priority: strictInteger(source.priority, index, 0, 10_000, "kiro_organization_account_priority_invalid"),
    maxConcurrency: strictInteger(source.maxConcurrency, 1, 1, 1, "kiro_organization_account_concurrency_invalid"),
  };
  const modelIds = normalizedPolicyIds(source, "modelIds");
  const projectIds = normalizedPolicyIds(source, "projectIds");
  if (modelIds !== undefined) normalized.modelIds = modelIds;
  if (projectIds !== undefined) normalized.projectIds = projectIds;

  if (previous) {
    const normalizedPrevious = normalizeKiroOrganizationAccount(previous, { index });
    validateRevisionWindow(source.revision, normalizedPrevious.revision);
    const next = nextRevision(normalizedPrevious.revision);
    normalized.revision = sameAccount(normalized, normalizedPrevious)
      ? source.revision === next ? next : normalizedPrevious.revision
      : next;
  }
  return normalized;
}

function withoutConfigRevision(config) {
  const { revision: _revision, ...metadata } = config;
  return metadata;
}

function sameConfig(left, right) {
  return JSON.stringify(withoutConfigRevision(left)) === JSON.stringify(withoutConfigRevision(right));
}

/** Normalize complete public metadata and advance global/per-account revisions. */
export function normalizeKiroOrganizationConfig(value, options = {}) {
  const source = record(
    value,
    "kiro_organization_config_invalid",
    "Kiro organization configuration",
  );
  rejectUnknownKeys(
    source,
    CONFIG_KEYS,
    "kiro_organization_config_field_invalid",
    "Kiro organization configuration",
  );
  if (source.version !== undefined && source.version !== CONFIG_VERSION) {
    throw configError("kiro_organization_config_version_invalid", "Kiro organization configuration version is unsupported");
  }
  if (source.accounts !== undefined && !Array.isArray(source.accounts)) {
    throw configError("kiro_organization_accounts_invalid", "Kiro organization accounts must be an array");
  }
  const rows = source.accounts ?? [];
  if (rows.length > MAX_KIRO_ORGANIZATION_ACCOUNTS) {
    throw configError("kiro_organization_accounts_limit", "Kiro organization account limit exceeded");
  }

  const previous = previousOption(options);
  const normalizedPrevious = previous ? normalizeKiroOrganizationConfig(previous) : null;
  const previousById = new Map(normalizedPrevious?.accounts.map((account) => [account.id, account]) ?? []);
  const seen = new Set();
  const accounts = rows.map((row, index) => {
    const sourceAccount = record(row, "kiro_organization_account_invalid", "Kiro organization account");
    const accountId = validateKiroOrganizationAccountId(sourceAccount.id);
    if (seen.has(accountId)) {
      throw configError("kiro_organization_account_duplicate", "Kiro organization account id is duplicated");
    }
    seen.add(accountId);
    return normalizeKiroOrganizationAccount(sourceAccount, {
      index,
      previous: previousById.get(accountId),
    });
  });

  const strategy = source.strategy ?? "balanced";
  if (!STRATEGIES.has(strategy)) {
    throw configError("kiro_organization_strategy_invalid", "Kiro organization routing strategy is invalid");
  }
  const normalized = {
    version: CONFIG_VERSION,
    revision: revision(source.revision),
    enabled: strictBoolean(source.enabled, false, "kiro_organization_enabled_invalid"),
    strategy,
    sessionAffinity: strictBoolean(source.sessionAffinity, true, "kiro_organization_affinity_invalid"),
    accounts,
  };

  if (normalizedPrevious) {
    validateRevisionWindow(source.revision, normalizedPrevious.revision);
    const next = nextRevision(normalizedPrevious.revision);
    normalized.revision = sameConfig(normalized, normalizedPrevious)
      ? source.revision === next ? next : normalizedPrevious.revision
      : next;
  }
  return normalized;
}

/** Normalize one write-only KIRO_API_KEY payload. */
export function normalizeKiroOrganizationAccountSecret(value) {
  const source = record(
    value,
    "kiro_organization_secret_invalid",
    "Kiro organization credential",
  );
  rejectUnknownKeys(
    source,
    SECRET_KEYS,
    "kiro_organization_secret_field_invalid",
    "Kiro organization credential",
  );
  const apiKey = source.apiKey;
  if (
    typeof apiKey !== "string"
    || apiKey.length < 1
    || apiKey.length > MAX_API_KEY_LENGTH
    || apiKey !== apiKey.trim()
    || /[\u0000-\u0020\u007f]/.test(apiKey)
  ) {
    throw configError("kiro_organization_api_key_invalid", "Kiro organization API key is invalid");
  }
  return { apiKey };
}

/**
 * Normalize a private accountId -> credential map.
 *
 * The returned Map is intentionally not JSON-shaped. Callers must keep it in
 * the gateway secret boundary and must never merge it into public metadata.
 */
export function normalizeKiroOrganizationSecrets(value) {
  if (value === undefined || value === null) return new Map();
  let entries;
  if (value instanceof Map) {
    entries = [...value.entries()];
  } else {
    const source = record(value, "kiro_organization_secrets_invalid", "Kiro organization credentials");
    if (Object.hasOwn(source, "version") || Object.hasOwn(source, "accounts")) {
      rejectUnknownKeys(
        source,
        SECRET_ENVELOPE_KEYS,
        "kiro_organization_secrets_field_invalid",
        "Kiro organization credentials",
      );
      if (source.version !== CONFIG_VERSION) {
        throw configError("kiro_organization_secrets_version_invalid", "Kiro organization credential version is unsupported");
      }
      const accounts = record(
        source.accounts,
        "kiro_organization_secrets_invalid",
        "Kiro organization credential accounts",
      );
      entries = Object.entries(accounts).map(([accountId, stored]) => {
        const storedSecret = record(stored, "kiro_organization_secret_invalid", "Kiro organization credential");
        rejectUnknownKeys(
          storedSecret,
          STORED_SECRET_KEYS,
          "kiro_organization_secret_field_invalid",
          "Kiro organization credential",
        );
        if (storedSecret.kind !== "api-key") {
          throw configError("kiro_organization_secret_kind_invalid", "Kiro organization credential kind is unsupported");
        }
        return [accountId, { apiKey: storedSecret.apiKey }];
      });
    } else {
      entries = Object.entries(source);
    }
  }
  if (entries.length > MAX_KIRO_ORGANIZATION_ACCOUNTS) {
    throw configError("kiro_organization_secrets_limit", "Kiro organization credential limit exceeded");
  }
  const result = new Map();
  for (const [accountId, secret] of entries) {
    const id = validateKiroOrganizationAccountId(accountId);
    if (result.has(id)) {
      throw configError("kiro_organization_secret_duplicate", "Kiro organization credential is duplicated");
    }
    result.set(id, normalizeKiroOrganizationAccountSecret(secret));
  }
  return result;
}

/** Serialize private credentials for an encrypted/protected persistence layer. */
export function serializeKiroOrganizationSecrets(value) {
  const secrets = normalizeKiroOrganizationSecrets(value);
  const accounts = {};
  for (const [accountId, secret] of [...secrets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    accounts[accountId] = { kind: "api-key", apiKey: secret.apiKey };
  }
  return { version: CONFIG_VERSION, accounts };
}
