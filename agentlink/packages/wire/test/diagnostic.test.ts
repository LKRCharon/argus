import { describe, expect, test } from "bun:test";
import {
  classifyDiagnostic,
  classifyMeshDiagnostic,
  MeshDiagnosticSchema,
} from "../src";

describe("Mesh diagnostic classification", () => {
  test("classifies the bounded failure vocabulary", () => {
    expect(classifyMeshDiagnostic({ code: "ECONNRESET", message: "socket closed" })).toMatchObject({
      classification: "transport-closed",
      code: "ECONNRESET",
      retryable: true,
      timedOut: false,
    });
    expect(classifyMeshDiagnostic({
      code: "DEADLINE_EXCEEDED",
      message: "relay deadline elapsed",
      timedOut: true,
      timedOutStage: "relay",
    })).toMatchObject({
      classification: "timeout-deadline",
      timedOut: true,
      timedOutStage: "relay",
      retryable: true,
    });
    expect(classifyMeshDiagnostic({ status: 403, code: "FORBIDDEN", message: "access denied" })).toMatchObject({
      classification: "auth-authz",
      retryable: false,
    });
    expect(classifyMeshDiagnostic({ code: "AUTHZ_DENIED", message: "request rejected" }).classification).toBe("auth-authz");
    expect(classifyMeshDiagnostic({ code: "sandbox-capability-denied", message: "capability denied" })).toMatchObject({
      classification: "sandbox-capability",
      retryable: false,
    });
    expect(classifyMeshDiagnostic({ code: "E_SCHEMA", message: "invalid payload" })).toMatchObject({
      classification: "code-error",
      retryable: false,
      timedOut: false,
    });
  });

  test("preserves correlation and retry metadata, including false retryability", () => {
    const diagnostic = classifyDiagnostic({
      code: "E_TASK",
      message: "task failed",
      operationId: "op-1",
      requestId: "request-1",
      controlRequestId: "codex:request-1",
      taskId: "task-1",
      idempotencyKey: "idempotency-1",
      retryable: false,
    });
    expect(diagnostic).toEqual({
      classification: "code-error",
      code: "E_TASK",
      message: "task failed",
      retryable: false,
      timedOut: false,
      operationId: "op-1",
      requestId: "request-1",
      controlRequestId: "codex:request-1",
      taskId: "task-1",
      idempotencyKey: "idempotency-1",
    });
    expect(MeshDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
  });

  test("reads nested HTTP errors and redacts sensitive message material", () => {
    const diagnostic = classifyMeshDiagnostic({
      status: 401,
      error: {
        code: "AUTH_FAILED",
        message: "Authorization: Bearer abc123 token=ghp_fake-token-value",
      },
    });
    expect(diagnostic).toMatchObject({ classification: "auth-authz", code: "AUTH_FAILED" });
    expect(diagnostic.message).not.toContain("abc123");
    expect(diagnostic.message).not.toContain("ghp_fake-token-value");
  });
});
