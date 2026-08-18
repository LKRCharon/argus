/**
 * Mesh security protocol payloads.
 *
 * These schemas are deliberately transport-only.  They describe what an
 * agent is asking for and what was approved; the target daemon must still
 * enforce the request with its local policy engine before executing anything.
 * Keep fields JSON-native so the same wire values can be decoded by Bun,
 * macOS/Linux/Windows clients, and Android without Date/Map/BigInt adapters.
 */

import { z } from "zod";
import { b64decode, b64encode, stableStringify, utf8 } from "./crypto";
import { ed25519 } from "@noble/curves/ed25519";

/** IDs are opaque protocol values, but an empty/whitespace-only ID is never valid. */
export const MeshIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be empty",
});
export type MeshId = z.infer<typeof MeshIdSchema>;

/** ISO-8601 timestamps with an explicit timezone, represented as strings on the wire. */
export const MeshTimestampSchema = z.string().datetime({ offset: true });
export type MeshTimestamp = z.infer<typeof MeshTimestampSchema>;

export const MeshResourceKindSchema = z.enum(["repo", "directory", "artifact", "gpu"]);
export type MeshResourceKind = z.infer<typeof MeshResourceKindSchema>;

/**
 * This is the complete operation vocabulary.  Dangerous operations remain in
 * the protocol so policy can record/deny them explicitly; listing an
 * operation here never grants permission to perform it.
 */
export const MeshOperationSchema = z.enum([
  "inspect",
  "stage",
  "run",
  "apply-patch",
  "quarantine",
  "deploy",
  "delete",
  "sudo",
  "secret-read",
  "arbitrary-shell",
]);
export type MeshOperation = z.infer<typeof MeshOperationSchema>;

export type MeshJsonPrimitive = string | number | boolean | null;
export type MeshJsonValue = MeshJsonPrimitive | MeshJsonValue[] | { [key: string]: MeshJsonValue };

/** Recursive JSON value schema for capability scopes and future extensions. */
export const MeshJsonValueSchema: z.ZodType<MeshJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(MeshJsonValueSchema),
    z.record(z.string(), MeshJsonValueSchema),
  ]),
);

export const MeshScopeSchema = z.record(z.string(), MeshJsonValueSchema);
export type MeshScope = z.infer<typeof MeshScopeSchema>;

/** Scope for the typed process runner. No cwd, executable, env, or shell field is accepted. */
export const MeshRunScopeSchema = z.object({
  runnerId: MeshIdSchema,
  args: z.array(z.string().max(4096)).max(64).default([]),
  input: z.string().max(1_048_576).optional(),
  timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
}).strict();
export type MeshRunScope = z.infer<typeof MeshRunScopeSchema>;

/** A resource is identified by an opaque ID; rootHint is display metadata, not a secret. */
export const MeshResourceSchema = z.object({
  id: MeshIdSchema,
  ownerNodeId: MeshIdSchema,
  kind: MeshResourceKindSchema,
  displayName: MeshIdSchema,
  rootHint: z.string(),
  capabilities: z.array(MeshOperationSchema).optional(),
  /** Stable names only; executable paths never cross the channel. */
  runnerIds: z.array(MeshIdSchema).max(64).optional(),
  /** Optional owner-configured, read-only status probe. */
  statusRunnerId: MeshIdSchema.optional(),
});
export type MeshResource = z.infer<typeof MeshResourceSchema>;

export const MeshTaskRequestSchema = z.object({
  groupId: MeshIdSchema,
  taskId: MeshIdSchema,
  requesterNodeId: MeshIdSchema,
  targetNodeId: MeshIdSchema,
  resourceId: MeshIdSchema,
  operation: MeshOperationSchema,
  scope: MeshScopeSchema.optional(),
});
export type MeshTaskRequest = z.infer<typeof MeshTaskRequestSchema>;

export const MeshCapabilityGrantSchema = z
  .object({
    groupId: MeshIdSchema,
    taskId: MeshIdSchema,
    grantId: MeshIdSchema,
    subjectNodeId: MeshIdSchema,
    targetNodeId: MeshIdSchema,
    resourceId: MeshIdSchema,
    operation: MeshOperationSchema,
    scope: MeshScopeSchema,
    issuedAt: MeshTimestampSchema,
    expiresAt: MeshTimestampSchema,
    nonce: MeshIdSchema,
    issuerNodeId: MeshIdSchema,
    issuerPublicKey: MeshIdSchema,
    signature: MeshIdSchema,
  })
  .superRefine((grant, ctx) => {
    // A grant may be parsed after it expires so the daemon can audit it and
    // return a precise denial.  Its interval must nevertheless be coherent.
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "must be later than issuedAt",
      });
    }
  });
export type MeshCapabilityGrant = z.infer<typeof MeshCapabilityGrantSchema>;

/** Returns policy-relevant expiry state without changing the wire schema. */
export function isMeshCapabilityGrantExpired(grant: MeshCapabilityGrant, nowMs = Date.now()): boolean {
  return Date.parse(grant.expiresAt) <= nowMs;
}

export const MeshApprovalDecisionSchema = z.enum(["allow", "deny"]);
export type MeshApprovalDecision = z.infer<typeof MeshApprovalDecisionSchema>;

export const MeshApprovalSchema = z.object({
  approvalId: MeshIdSchema,
  grantId: MeshIdSchema,
  approverNodeId: MeshIdSchema,
  approverPublicKey: MeshIdSchema,
  decision: MeshApprovalDecisionSchema,
  summary: z.string(),
  createdAt: MeshTimestampSchema,
  signature: MeshIdSchema,
});
export type MeshApproval = z.infer<typeof MeshApprovalSchema>;

export const MeshAuditDecisionSchema = z.enum(["allow", "deny", "approval-required"]);
export type MeshAuditDecision = z.infer<typeof MeshAuditDecisionSchema>;

export const MeshAuditEventSchema = z.object({
  groupId: MeshIdSchema,
  eventId: MeshIdSchema,
  taskId: MeshIdSchema,
  actorNodeId: MeshIdSchema,
  targetNodeId: MeshIdSchema,
  operation: MeshOperationSchema,
  decision: MeshAuditDecisionSchema,
  reason: z.string(),
  createdAt: MeshTimestampSchema,
});
export type MeshAuditEvent = z.infer<typeof MeshAuditEventSchema>;

// The outer kind is the BusinessPayload discriminator.  Resource.kind stays
// nested so its resource vocabulary cannot collide with the payload kind.
export const MeshResourcePayloadSchema = z.object({
  kind: z.literal("mesh-resource"),
  resource: MeshResourceSchema,
});
export type MeshResourcePayload = z.infer<typeof MeshResourcePayloadSchema>;

export const MeshResourceListRequestPayloadSchema = z.object({
  kind: z.literal("mesh-resource-list-request"),
  requestId: MeshIdSchema,
});
export type MeshResourceListRequestPayload = z.infer<typeof MeshResourceListRequestPayloadSchema>;

export const MeshResourceListPayloadSchema = z.object({
  kind: z.literal("mesh-resource-list"),
  requestId: MeshIdSchema,
  nodeId: MeshIdSchema,
  resources: z.array(MeshResourceSchema).max(256),
});
export type MeshResourceListPayload = z.infer<typeof MeshResourceListPayloadSchema>;

export const MeshGpuDeviceStatusSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().min(1).max(128),
  temperatureC: z.number().finite().min(-100).max(200).nullable(),
  memoryUsedMiB: z.number().finite().nonnegative().nullable(),
  memoryTotalMiB: z.number().finite().nonnegative().nullable(),
  utilizationGpuPercent: z.number().finite().min(0).max(100).nullable(),
  driverVersion: z.string().max(128).nullable(),
}).strict();
export type MeshGpuDeviceStatus = z.infer<typeof MeshGpuDeviceStatusSchema>;

export const MeshResourceStatusSchema = z.object({
  state: z.enum(["ready", "degraded", "error", "unknown"]),
  summary: z.string().max(512),
  observedAt: MeshTimestampSchema,
  error: z.string().max(512).optional(),
  gpu: z.object({
    devices: z.array(MeshGpuDeviceStatusSchema).max(64),
  }).strict().optional(),
}).strict();
export type MeshResourceStatus = z.infer<typeof MeshResourceStatusSchema>;

export const MeshResourceStatusRequestPayloadSchema = z.object({
  kind: z.literal("mesh-resource-status-request"),
  requestId: MeshIdSchema,
  resourceId: MeshIdSchema,
});
export type MeshResourceStatusRequestPayload = z.infer<typeof MeshResourceStatusRequestPayloadSchema>;

export const MeshResourceStatusPayloadSchema = z.object({
  kind: z.literal("mesh-resource-status"),
  requestId: MeshIdSchema,
  nodeId: MeshIdSchema,
  resourceId: MeshIdSchema,
  status: MeshResourceStatusSchema,
});
export type MeshResourceStatusPayload = z.infer<typeof MeshResourceStatusPayloadSchema>;

export const MeshTaskRequestPayloadSchema = z.object({
  kind: z.literal("mesh-task-request"),
  task: MeshTaskRequestSchema,
  grant: MeshCapabilityGrantSchema.optional(),
  approval: MeshApprovalSchema.optional(),
});
export type MeshTaskRequestPayload = z.infer<typeof MeshTaskRequestPayloadSchema>;

export const MeshCapabilityGrantPayloadSchema = z.object({
  kind: z.literal("mesh-capability-grant"),
  grant: MeshCapabilityGrantSchema,
});
export type MeshCapabilityGrantPayload = z.infer<typeof MeshCapabilityGrantPayloadSchema>;

export const MeshApprovalPayloadSchema = z.object({
  kind: z.literal("mesh-approval"),
  approval: MeshApprovalSchema,
});
export type MeshApprovalPayload = z.infer<typeof MeshApprovalPayloadSchema>;

export const MeshAuditEventPayloadSchema = z.object({
  kind: z.literal("mesh-audit-event"),
  event: MeshAuditEventSchema,
});
export type MeshAuditEventPayload = z.infer<typeof MeshAuditEventPayloadSchema>;

export const MeshTaskResultStatusSchema = z.enum([
  "queued", "running", "completed", "denied", "approval-required", "failed", "cancelled",
]);
export type MeshTaskResultStatus = z.infer<typeof MeshTaskResultStatusSchema>;

export const MeshTaskResultPayloadSchema = z.object({
  kind: z.literal("mesh-task-result"),
  groupId: MeshIdSchema,
  taskId: MeshIdSchema,
  targetNodeId: MeshIdSchema,
  operation: MeshOperationSchema,
  status: MeshTaskResultStatusSchema,
  decision: MeshAuditDecisionSchema,
  message: z.string(),
  result: MeshJsonValueSchema.optional(),
});
export type MeshTaskResultPayload = z.infer<typeof MeshTaskResultPayloadSchema>;

export const MeshPayloadSchema = z.discriminatedUnion("kind", [
  MeshResourcePayloadSchema,
  MeshResourceListRequestPayloadSchema,
  MeshResourceListPayloadSchema,
  MeshResourceStatusRequestPayloadSchema,
  MeshResourceStatusPayloadSchema,
  MeshTaskRequestPayloadSchema,
  MeshCapabilityGrantPayloadSchema,
  MeshApprovalPayloadSchema,
  MeshAuditEventPayloadSchema,
  MeshTaskResultPayloadSchema,
]);
export type MeshPayload = z.infer<typeof MeshPayloadSchema>;

/**
 * Capability signatures use a separate Ed25519 owner key.  The signature is
 * transport-independent, so a relay can forward/replay bytes but cannot alter
 * the target, resource, operation, expiry or nonce without detection. The
 * target daemon must pin the owner's public key locally; the public key carried
 * in a grant is metadata, not a trust decision.
 */
function unsignedGrant(grant: MeshCapabilityGrant): Omit<MeshCapabilityGrant, "signature"> {
  const { signature: _signature, ...unsigned } = grant;
  return unsigned;
}

function unsignedApproval(approval: MeshApproval): Omit<MeshApproval, "signature"> {
  const { signature: _signature, ...unsigned } = approval;
  return unsigned;
}

export function meshCapabilitySigningInput(grant: MeshCapabilityGrant): Uint8Array {
  return utf8(`agentlink/mesh-capability/v1:${stableStringify(unsignedGrant(grant))}`);
}

export interface MeshSigningKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateMeshSigningKeyPair(): MeshSigningKeyPair {
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function signMeshCapabilityGrant(
  grant: Omit<MeshCapabilityGrant, "signature">,
  secretKey: Uint8Array,
): MeshCapabilityGrant {
  const unsigned = { ...grant, signature: "pending" } as MeshCapabilityGrant;
  return {
    ...grant,
    signature: b64encode(ed25519.sign(meshCapabilitySigningInput(unsigned), secretKey)),
  };
}

export function verifyMeshCapabilityGrant(grant: MeshCapabilityGrant, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(b64decode(grant.signature), meshCapabilitySigningInput(grant), publicKey);
  } catch {
    return false;
  }
}

export function meshApprovalSigningInput(approval: MeshApproval): Uint8Array {
  return utf8(`agentlink/mesh-approval/v1:${stableStringify(unsignedApproval(approval))}`);
}

export function signMeshApproval(
  approval: Omit<MeshApproval, "signature">,
  secretKey: Uint8Array,
): MeshApproval {
  const unsigned = { ...approval, signature: "pending" } as MeshApproval;
  return {
    ...approval,
    signature: b64encode(ed25519.sign(meshApprovalSigningInput(unsigned), secretKey)),
  };
}

export function verifyMeshApproval(approval: MeshApproval, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(b64decode(approval.signature), meshApprovalSigningInput(approval), publicKey);
  } catch {
    return false;
  }
}
