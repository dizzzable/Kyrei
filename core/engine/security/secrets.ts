/**
 * Secret detection + redaction across all channels. Requirements §8.6, §8.10.
 * Values are replaced with [REDACTED]; key names may remain.
 */

/**
 * Kept deliberately in sync with SECRET_VALUE_PATTERNS in
 * `core/secret-redaction.js` (the gateway-side redactor). The two lists had
 * diverged: this one used `sk-[a-zA-Z0-9]{20,}`, which cannot match a
 * hyphenated prefix, so every modern key format — `sk-ant-*`, `sk-proj-*`,
 * `sk-or-v1-*` — passed through unredacted. That mattered most on the durable
 * sinks (`memory/ltm-bridge.ts`) which have no exactValues to fall back on, and
 * on `containsSecret`, which backs the write-a-secret-to-a-file guard.
 */
const PATTERNS: RegExp[] = [
  // Two shapes, deliberately not one loose `sk-[\w-]{12,}`: that also matched
  // ordinary identifiers (`sk-loading-placeholder`, SpinKit's `sk-fading-circle`,
  // a `sk-`-prefixed branch name). This matters because containsSecret() backs
  // secretScanHook, which DENIES write_file — a false positive blocks writing
  // ordinary CSS — and redact() writes [REDACTED] into durable memory.
  // Prefixed provider keys. The tail must end in a LONG UNBROKEN alphanumeric
  // run — the same property the bare `sk-` pattern relies on below. Allowing
  // `-` throughout matched ordinary hyphenated identifiers that merely start
  // with one of these words: `sk-test-fading-circle-large` (SpinKit),
  // `sk-proj-refactor-provider-build` (a branch name), `sk-admin-settings-panel`.
  // Each of those DENIED write_file with "a secret was detected".
  // `live`/`test` are gone entirely: Stripe's real keys use `_` and are covered
  // by the next pattern, so the only thing they matched here was prose.
  /\bsk-(?:ant|proj|or|svcacct|admin)-[A-Za-z0-9_-]{0,24}[A-Za-z0-9]{20,}\b/g,
  // Bare legacy OpenAI key. The load-bearing part is the UNBROKEN alphanumeric
  // run: a hyphen ends it, which is what keeps `sk-loading-placeholder` and
  // `sk-refactor-provider-build` out (their runs are 7 and 8 chars).
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g, // Stripe
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub PAT / OAuth / user / server / refresh
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google OAuth access token
  /\bgsk_[A-Za-z0-9]{40,}\b/g, // Groq
  /\bxai-[A-Za-z0-9]{40,}\b/g, // xAI
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  // Bearer tokens: an unbroken alphanumeric run, and `[ \t]` rather than `\s`
  // so the pattern cannot span a newline and swallow the next line of prose.
  // `Bearer YOUR_API_KEY_HERE_PLACEHOLDER` in a curl example is documentation,
  // not a secret, and blocking the file that documents it helps nobody.
  /\bBearer[ \t]+[A-Za-z0-9._-]{0,20}[A-Za-z0-9]{20,}/g,
  // Formats the list was missing entirely.
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub fine-grained PAT (the default since 2022)
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g, // Slack app-level
  /\bhf_[A-Za-z0-9]{30,}\b/g, // HuggingFace
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm automation token
  // NOTE: credentials embedded in a URL are deliberately NOT here. This list
  // also feeds `containsSensitiveOutbound`, so adding them would REFUSE to
  // fetch a `https://user:pass@host/` URL the user supplied on purpose. They
  // are redacted on the gateway side, where the only cost is over-redaction.
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
