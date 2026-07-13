/**
 * Secret detection + redaction across all channels. Requirements §8.6, §8.10.
 * Values are replaced with [REDACTED]; key names may remain.
 */

const PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI-style
  /sk_live_[a-zA-Z0-9]{16,}/g,
  /sk_test_[a-zA-Z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g, // Slack
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT
  /\bBearer\s+[a-zA-Z0-9._-]{20,}/gi,
];

export function redact(text: string, exactValues: readonly string[] = []): string {
  const exact = [...new Set(exactValues.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
  const exactPattern = exact.length
    ? new RegExp(exact.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : null;
  let out = exactPattern ? text.replace(exactPattern, "[REDACTED]") : text;
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function containsSecret(text: string): boolean {
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

const SAFE_CHILD_ENV = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SHELL",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/**
 * Child processes receive a minimal functional environment. A denylist cannot
 * cover arbitrary names such as DATABASE_URL or CUSTOM_CREDENTIAL, and `env`
 * would otherwise disclose them directly to an agent.
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SAFE_CHILD_ENV.has(k.toUpperCase()) || v == null || containsSecret(v)) continue;
    out[k] = v;
  }
  return out;
}
