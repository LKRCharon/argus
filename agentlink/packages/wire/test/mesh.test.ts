import { describe, expect, test } from "bun:test";
import {
  BusinessPayloadSchema,
  MeshApprovalPayloadSchema,
  MeshAuditEventPayloadSchema,
  MeshCapabilityGrantSchema,
  MeshPayloadSchema,
  MeshResourceListPayloadSchema,
  MeshResourceListRequestPayloadSchema,
  MeshResourcePayloadSchema,
  MeshTaskResultPayloadSchema,
  MeshTaskRequestPayloadSchema,
  generateMeshSigningKeyPair,
  isMeshCapabilityGrantExpired,
  signMeshCapabilityGrant,
  verifyMeshCapabilityGrant,
} from "../src";

const issuedAt = "2026-08-17T00:00:00.000Z";
const expiresAt = "2026-08-17T01:00:00.000Z";

const resource = {
  id: "repo:argus",
  ownerNodeId: "node-mac",
  kind: "repo" as const,
  displayName: "Argus agentlink",
  rootHint: "~/proj/eclam/agentlink",
};

const task = {
  groupId: "group-alpha",
  taskId: "task-001",
  requesterNodeId: "node-mac",
  targetNodeId: "node-linux-gpu",
  resourceId: resource.id,
  operation: "run" as const,
  scope: {
    runnerId: "gpu-runner-v1",
    args: ["--self-test"],
    timeoutMs: 900_000,
  },
};

const grant = {
  groupId: task.groupId,
  taskId: task.taskId,
  grantId: "grant-001",
  subjectNodeId: "node-mac",
  targetNodeId: "node-linux-gpu",
  resourceId: resource.id,
  operation: "run" as const,
  scope: task.scope,
  issuedAt,
  expiresAt,
  nonce: "nonce-001",
  issuerNodeId: "node-linux-gpu",
  issuerPublicKey: "owner-public-key",
  signature: "sig-ed25519-placeholder",
};

const approval = {
  approvalId: "approval-001",
  grantId: grant.grantId,
  approverNodeId: "node-linux-gpu",
  approverPublicKey: "owner-public-key",
  decision: "allow" as const,
  summary: "Run the task in the isolated staging directory",
  createdAt: issuedAt,
  signature: "sig-approval-placeholder",
};

const auditEvent = {
  groupId: task.groupId,
  eventId: "event-001",
  taskId: task.taskId,
  actorNodeId: task.requesterNodeId,
  targetNodeId: task.targetNodeId,
  operation: task.operation,
  decision: "allow" as const,
  reason: "owner-approved grant",
  createdAt: issuedAt,
};

const taskResult = {
  kind: "mesh-task-result" as const,
  groupId: task.groupId,
  taskId: task.taskId,
  targetNodeId: task.targetNodeId,
  operation: task.operation,
  status: "completed" as const,
  decision: "allow" as const,
  message: "inspection completed",
  result: { entryCount: 3, truncated: false },
};

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Mesh wire schema", () => {
  test("all structured payloads survive JSON round-trip and BusinessPayload parsing", () => {
    const payloads = [
      { kind: "mesh-resource" as const, resource },
      { kind: "mesh-resource-list-request" as const, requestId: "resources-001" },
      {
        kind: "mesh-resource-list" as const,
        requestId: "resources-001",
        nodeId: "node-linux-gpu",
        resources: [{ ...resource, capabilities: ["inspect", "run"] as const, runnerIds: ["gpu-runner-v1"] }],
      },
      { kind: "mesh-task-request" as const, task },
      { kind: "mesh-capability-grant" as const, grant },
      { kind: "mesh-approval" as const, approval },
      { kind: "mesh-audit-event" as const, event: auditEvent },
      taskResult,
    ];

    for (const payload of payloads) {
      const roundTripped = jsonRoundTrip(payload);
      expect(MeshPayloadSchema.parse(roundTripped)).toEqual(payload);
      expect(BusinessPayloadSchema.parse(roundTripped)).toEqual(payload);
    }
  });

  test("individual payload schemas retain their structure", () => {
    expect(MeshResourcePayloadSchema.parse(jsonRoundTrip({ kind: "mesh-resource", resource }))).toEqual({
      kind: "mesh-resource",
      resource,
    });
    expect(MeshResourceListRequestPayloadSchema.parse(jsonRoundTrip({
      kind: "mesh-resource-list-request",
      requestId: "resources-001",
    }))).toEqual({ kind: "mesh-resource-list-request", requestId: "resources-001" });
    expect(MeshResourceListPayloadSchema.parse(jsonRoundTrip({
      kind: "mesh-resource-list",
      requestId: "resources-001",
      nodeId: "node-linux-gpu",
      resources: [{ ...resource, capabilities: ["inspect", "run"], runnerIds: ["gpu-runner-v1"] }],
    }))).toMatchObject({ kind: "mesh-resource-list", requestId: "resources-001" });
    expect(MeshTaskRequestPayloadSchema.parse(jsonRoundTrip({ kind: "mesh-task-request", task }))).toEqual({
      kind: "mesh-task-request",
      task,
    });
    expect(MeshCapabilityGrantSchema.parse(jsonRoundTrip(grant))).toEqual(grant);
    expect(MeshApprovalPayloadSchema.parse(jsonRoundTrip({ kind: "mesh-approval", approval }))).toEqual({
      kind: "mesh-approval",
      approval,
    });
    expect(MeshAuditEventPayloadSchema.parse(jsonRoundTrip({ kind: "mesh-audit-event", event: auditEvent }))).toEqual({
      kind: "mesh-audit-event",
      event: auditEvent,
    });
    expect(MeshTaskResultPayloadSchema.parse(jsonRoundTrip(taskResult))).toEqual(taskResult);
  });

  test("rejects operations outside the explicit whitelist", () => {
    const invalidTask = { ...task, operation: "rm-rf" };
    const invalidGrant = { ...grant, operation: "ssh" };

    expect(MeshTaskRequestPayloadSchema.safeParse({ kind: "mesh-task-request", task: invalidTask }).success).toBe(false);
    expect(MeshCapabilityGrantSchema.safeParse(invalidGrant).success).toBe(false);
  });

  test("rejects an empty identifier", () => {
    expect(MeshResourcePayloadSchema.safeParse({ kind: "mesh-resource", resource: { ...resource, id: "" } }).success).toBe(false);
    expect(MeshTaskRequestPayloadSchema.safeParse({ kind: "mesh-task-request", task: { ...task, taskId: "   " } }).success).toBe(false);
  });

  test("rejects an expiry that is not later than issuedAt and detects an expired grant", () => {
    const malformed = { ...grant, expiresAt: issuedAt };
    expect(MeshCapabilityGrantSchema.safeParse(malformed).success).toBe(false);

    expect(isMeshCapabilityGrantExpired(grant, Date.parse("2026-08-17T00:30:00.000Z"))).toBe(false);
    expect(isMeshCapabilityGrantExpired(grant, Date.parse("2026-08-17T01:00:00.000Z"))).toBe(true);
  });

  test("capability signatures bind the grant fields", () => {
    const key = generateMeshSigningKeyPair();
    const { signature: _signature, ...unsigned } = grant;
    const signed = signMeshCapabilityGrant(unsigned, key.secretKey);
    expect(verifyMeshCapabilityGrant(signed, key.publicKey)).toBe(true);
    expect(verifyMeshCapabilityGrant({ ...signed, operation: "delete" }, key.publicKey)).toBe(false);
    expect(verifyMeshCapabilityGrant(signed, generateMeshSigningKeyPair().publicKey)).toBe(false);
  });

  test("unknown resource kinds are rejected by the known schema and can be ignored by a safe parser", () => {
    const unknown = { kind: "mesh-resource" as const, resource: { ...resource, kind: "volume" } };
    const result = MeshResourcePayloadSchema.safeParse(unknown);
    expect(result.success).toBe(false);
  });
});
