const OUTPUT_FIELDS = new Set(["resultSummary", "debugOutput"]);

export function sanitizeRunnerOutput(value: string, sensitivePaths: readonly string[] = []): string {
  let sanitized = value;
  const paths = [...new Set(sensitivePaths.filter(Boolean))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  for (const path of paths) sanitized = sanitized.replaceAll(path, "<local-path>");
  return sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(headers?|authorization|proxy-authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=<redacted>")
    .replace(/\b(?:sk|ghp|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9._~+/=-]{8,}/gi, "<redacted-token>")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, "<redacted-token>")
    .replace(/(^|[\s(=:])\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+/g, "$1<local-path>")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/gi, "<local-path>");
}

export function sanitizeTaskResultOutputs<T>(value: T, sensitivePaths: readonly string[] = []): T {
  return sanitizeValue(value, undefined, sensitivePaths) as T;
}

function sanitizeValue(value: unknown, key: string | undefined, sensitivePaths: readonly string[]): unknown {
  if (typeof value === "string") {
    return key && OUTPUT_FIELDS.has(key) ? sanitizeRunnerOutput(value, sensitivePaths) : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, undefined, sensitivePaths));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    sanitizeValue(child, childKey, sensitivePaths),
  ]));
}
