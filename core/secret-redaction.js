const SECRET_KEY = /(?:api[_-]?key|authorization|credentials?|private[_-]?key|secret|session[_-]?token|access[_-]?key|password|cookie)/i;

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[po]_[A-Za-z0-9]{36}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function exactValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.length > 0 && value !== "[REDACTED]"))]
    .sort((left, right) => right.length - left.length);
}

function redactExactValues(value, exact) {
  if (!exact.length || !value) return value;
  let clean = "";
  let cursor = 0;
  while (cursor < value.length) {
    let matchAt = -1;
    let matchLength = 0;
    for (const secret of exact) {
      const index = value.indexOf(secret, cursor);
      if (index === -1) continue;
      if (matchAt === -1 || index < matchAt || (index === matchAt && secret.length > matchLength)) {
        matchAt = index;
        matchLength = secret.length;
      }
    }
    if (matchAt === -1) return clean + value.slice(cursor);
    clean += `${value.slice(cursor, matchAt)}[REDACTED]`;
    cursor = matchAt + matchLength;
  }
  return clean;
}

function redactTextWithExact(value, exact) {
  let clean = redactExactValues(typeof value === "string" ? value : String(value ?? ""), exact);
  for (const pattern of SECRET_VALUE_PATTERNS) clean = clean.replace(pattern, "[REDACTED]");
  return clean;
}

export function redactSensitiveText(value, sensitiveValues = []) {
  return redactTextWithExact(value, exactValues(sensitiveValues));
}

/**
 * Clone a JSON-like value while removing secret-bearing keys, known token
 * shapes, and the exact runtime credentials supplied by the gateway.
 */
export function redactSensitiveValue(value, sensitiveValues = [], options = {}) {
  const exact = exactValues(sensitiveValues);
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, options.maxDepth) : 32;
  const maxStringChars = Number.isFinite(options.maxStringChars) ? Math.max(0, options.maxStringChars) : Infinity;
  const maxArrayItems = Number.isFinite(options.maxArrayItems) ? Math.max(0, options.maxArrayItems) : Infinity;
  const maxObjectKeys = Number.isFinite(options.maxObjectKeys) ? Math.max(0, options.maxObjectKeys) : Infinity;
  const seen = new WeakSet();

  const visit = (candidate, depth) => {
    if (depth > maxDepth) return "[TRUNCATED]";
    if (typeof candidate === "string") return redactTextWithExact(candidate, exact).slice(0, maxStringChars);
    if (typeof candidate === "number" || typeof candidate === "boolean" || candidate == null) return candidate;
    if (typeof candidate !== "object") return redactTextWithExact(String(candidate), exact).slice(0, maxStringChars);
    if (seen.has(candidate)) return "[CIRCULAR]";
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.slice(0, maxArrayItems).map((item) => visit(item, depth + 1));
    }
    const out = {};
    for (const [key, child] of Object.entries(candidate).slice(0, maxObjectKeys)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : visit(child, depth + 1);
    }
    return out;
  };

  return visit(value, 0);
}
