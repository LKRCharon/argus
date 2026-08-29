import { describe, expect, test } from "bun:test";
import { sanitizeRunnerOutput } from "../src/mesh/output-sanitizer";

describe("Mesh runner output sanitizer", () => {
  test("redacts common environment-style secret assignments with quoted and unquoted values", () => {
    const input = [
      "OPENAI_API_KEY=sk-secret-openai",
      "AWS_SECRET_ACCESS_KEY: 'aws secret value'",
      'FOO_TOKEN="quoted-token"',
      "FOO_SECRET:unquoted-secret",
    ].join("\n");
    const sanitized = sanitizeRunnerOutput(input);
    for (const secret of ["sk-secret-openai", "aws secret value", "quoted-token", "unquoted-secret"]) {
      expect(sanitized).not.toContain(secret);
    }
    for (const name of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "FOO_TOKEN", "FOO_SECRET"]) {
      expect(sanitized).toContain(`${name}${name === "OPENAI_API_KEY" || name === "FOO_TOKEN" ? "=" : ":"}<redacted>`);
    }
  });

  test("preserves typed ids and ordinary prose", () => {
    const stable = [
      "task-redaction-preserved",
      `sha256:${"a".repeat(64)}`,
      "request-redaction-preserved",
      "operation-redaction-preserved",
      "The token budget is stable and this secret chapter is ordinary prose.",
    ].join("\n");
    expect(sanitizeRunnerOutput(stable)).toBe(stable);
  });
});
