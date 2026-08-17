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

/** A resource is identified by an opaque ID; rootHint is display metadata, not a secret. */
export const MeshResourceSchema = z.object({
  id: MeshIdSchema,
  ownerNodeId: MeshIdSchema,
  kind: MeshResourceKindSchema,
  displayName: MeshIdSchema,
  rootHint: z.string(),
});
export type MeshResource = z.infer<typeof MeshResourceSchema>;

export const MeshTaskRequestSchema = z.object({
  taskId: MeshIdSchema,
  requesterNodeId: MeshIdSchema,
  targetNodeId: MeshIdSchema,
  resourceId: MeshIdSchema,
  operation: MeshOperationSchema,
});
export type MeshTaskRequest = z.infer<typeof MeshTaskRequestSchema>;

export const MeshCapabilityGrantSchema = z
  .object({
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
  decision: MeshApprovalDecisionSchema,
  summary: z.string(),
  createdAt: MeshTimestampSchema,
});
export type MeshApproval = z.infer<typeof MeshApprovalSchema>;

export const MeshAuditDecisionSchema = z.enum(["allow", "deny", "approval-required"]);
export type MeshAuditDecision = z.infer<typeof MeshAuditDecisionSchema>;

export const MeshAuditEventSchema = z.object({
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

export const MeshTaskRequestPayloadSchema = z.object({
  kind: z.literal("mesh-task-request"),
  task: MeshTaskRequestSchema,
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

export const MeshPayloadSchema = z.discriminatedUnion("kind", [
  MeshResourcePayloadSchema,
  MeshTaskRequestPayloadSchema,
  MeshCapabilityGrantPayloadSchema,
  MeshApprovalPayloadSchema,
  MeshAuditEventPayloadSchema,
]);
export type MeshPayload = z.infer<typeof MeshPayloadSchema>;
