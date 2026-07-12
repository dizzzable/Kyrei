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

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function containsSecret(text: string): boolean {
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/** Env sanitizer for run_command: strips secret-ish vars and proxies by default. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const denyKey = /(_KEY|_TOKEN|_SECRET|PASSWORD|APIKEY|API_KEY|AWS_|GITHUB_TOKEN|OPENAI|ANTHROPIC|_PROXY|PROXY_)/i;
  for (const [k, v] of Object.entries(env)) {
    if (denyKey.test(k)) continue;
    out[k] = v;
  }
  return out;
}
