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
import { sha256 } from "@noble/hashes/sha2";

/** IDs are opaque protocol values, but an empty/whitespace-only ID is never valid. */
export const MeshIdSchema = z.string().max(256).refine((value) => value.trim().length > 0, {
  message: "must not be empty",
});
export type MeshId = z.infer<typeof MeshIdSchema>;

const TYPED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function typedId(max: number, name: string): z.ZodString {
  return z.string().min(1).max(max).regex(TYPED_ID_PATTERN, `${name} has invalid characters`);
}

/** Resource identifiers are data, not credentials, and remain visible end-to-end. */
export const MeshTaskIdSchema = typedId(256, "taskId");
export const MeshNodeIdSchema = typedId(128, "nodeId");
export const MeshResourceIdSchema = typedId(256, "resourceId");
export const MeshGroupIdSchema = typedId(128, "groupId");
export const MeshRunnerIdSchema = typedId(128, "runnerId");
export const MeshThreadIdSchema = typedId(256, "threadId");
export const MeshRequestIdSchema = typedId(160, "requestId");
export const MeshOperationIdSchema = typedId(160, "operationId");
export const MeshIdempotencyKeySchema = typedId(160, "idempotencyKey");
export const MeshArtifactIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "artifactId must be sha256:<hex>");

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
  runnerId: MeshRunnerIdSchema,
  args: z.array(z.string().max(4096)).max(64).default([]),
  input: z.string().max(1_048_576).optional(),
  timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
  /** Selects an immutable structured input manifest carried by the task envelope. */
  baseArtifactId: MeshArtifactIdSchema.optional(),
}).strict();
export type MeshRunScope = z.infer<typeof MeshRunScopeSchema>;

export const MeshWorkspaceCapabilitySchema = z.enum([
  "structured-artifact-input",
  "task-scoped-workspace",
  "changed-file-manifest",
  "read-only-status",
]);
export type MeshWorkspaceCapability = z.infer<typeof MeshWorkspaceCapabilitySchema>;

export const MeshRunnerMetadataSchema = z.object({
  runnerId: MeshRunnerIdSchema,
  title: z.string().min(1).max(128),
  purpose: z.enum(["task", "status"]),
  inputSchema: MeshJsonValueSchema,
  resultSchema: MeshJsonValueSchema,
  approvalRequired: z.boolean(),
  maxRuntimeMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
  workspaceCapabilities: z.array(MeshWorkspaceCapabilitySchema).max(8),
}).strict();
export type MeshRunnerMetadata = z.infer<typeof MeshRunnerMetadataSchema>;

/** A resource is identified by an opaque ID; rootHint is display metadata, not a secret. */
export const MeshResourceSchema = z.object({
  id: MeshResourceIdSchema,
  ownerNodeId: MeshNodeIdSchema,
  kind: MeshResourceKindSchema,
  displayName: MeshIdSchema,
  rootHint: z.string(),
  capabilities: z.array(MeshOperationSchema).optional(),
  allowedOperations: z.array(MeshOperationSchema).max(16).optional(),
  allowedGroupIds: z.array(MeshGroupIdSchema).max(32).optional(),
  defaultGroupId: MeshGroupIdSchema.optional(),
  /** Stable names only; executable paths never cross the channel. */
  runnerIds: z.array(MeshRunnerIdSchema).max(64).optional(),
  runners: z.array(MeshRunnerMetadataSchema).max(64).optional(),
  /** Optional owner-configured, read-only status probe. */
  statusRunnerId: MeshRunnerIdSchema.optional(),
}).strict();
export type MeshResource = z.infer<typeof MeshResourceSchema>;

export const MeshTaskRequestSchema = z.object({
  groupId: MeshGroupIdSchema,
  taskId: MeshTaskIdSchema,
  requesterNodeId: MeshNodeIdSchema,
  targetNodeId: MeshNodeIdSchema,
  resourceId: MeshResourceIdSchema,
  operation: MeshOperationSchema,
  scope: MeshScopeSchema.optional(),
}).strict();
export type MeshTaskRequest = z.infer<typeof MeshTaskRequestSchema>;

export const MeshCapabilityGrantSchema = z
  .object({
    groupId: MeshGroupIdSchema,
    taskId: MeshTaskIdSchema,
    grantId: MeshIdSchema,
    subjectNodeId: MeshNodeIdSchema,
    targetNodeId: MeshNodeIdSchema,
    resourceId: MeshResourceIdSchema,
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
  approverNodeId: MeshNodeIdSchema,
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
  groupId: MeshGroupIdSchema,
  eventId: MeshIdSchema,
  taskId: MeshTaskIdSchema,
  actorNodeId: MeshNodeIdSchema,
  targetNodeId: MeshNodeIdSchema,
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
  requestId: MeshRequestIdSchema,
}).strict();
export type MeshResourceListRequestPayload = z.infer<typeof MeshResourceListRequestPayloadSchema>;

export const MeshResourceListPayloadSchema = z.object({
  kind: z.literal("mesh-resource-list"),
  requestId: MeshRequestIdSchema,
  nodeId: MeshNodeIdSchema,
  resources: z.array(MeshResourceSchema).max(256),
}).strict();
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

export const MeshDeadlineStageSchema = z.enum([
  "controller",
  "relay",
  "peer",
  "watcher",
  "app-server",
]);
export type MeshDeadlineStage = z.infer<typeof MeshDeadlineStageSchema>;

export const MeshWorkspaceStatusSchema = z.object({
  connectionStatus: z.enum(["online", "offline", "degraded"]),
  watcherAvailable: z.boolean(),
  codexAppServerAvailable: z.boolean(),
  /** Missing on older status runners; absence is fail-closed. */
  remoteCodexControl: z.boolean().default(false),
  activeJobs: z.number().int().nonnegative().max(10_000),
  workspaceRevision: z.string().max(256).nullable(),
  lastSuccess: MeshTimestampSchema.nullable(),
  lastErrorStage: MeshDeadlineStageSchema.nullable(),
  checkedAt: MeshTimestampSchema,
}).strict();
export type MeshWorkspaceStatus = z.infer<typeof MeshWorkspaceStatusSchema>;

export const MeshResourceStatusSchema = z.object({
  state: z.enum(["ready", "degraded", "error", "unknown"]),
  summary: z.string().max(512),
  observedAt: MeshTimestampSchema,
  error: z.string().max(512).optional(),
  gpu: z.object({
    devices: z.array(MeshGpuDeviceStatusSchema).max(64),
  }).strict().optional(),
  workspace: MeshWorkspaceStatusSchema.optional(),
}).strict();
export type MeshResourceStatus = z.infer<typeof MeshResourceStatusSchema>;

export const MeshResourceStatusRequestPayloadSchema = z.object({
  kind: z.literal("mesh-resource-status-request"),
  requestId: MeshRequestIdSchema,
  resourceId: MeshResourceIdSchema,
}).strict();
export type MeshResourceStatusRequestPayload = z.infer<typeof MeshResourceStatusRequestPayloadSchema>;

export const MeshResourceStatusPayloadSchema = z.object({
  kind: z.literal("mesh-resource-status"),
  requestId: MeshRequestIdSchema,
  nodeId: MeshNodeIdSchema,
  resourceId: MeshResourceIdSchema,
  status: MeshResourceStatusSchema,
}).strict();
export type MeshResourceStatusPayload = z.infer<typeof MeshResourceStatusPayloadSchema>;

const MAX_ARTIFACT_FILES = 256;
const MAX_ARTIFACT_FILE_BASE64_CHARS = 1_398_104;

function isRelativePosixArtifactPath(value: string): boolean {
  if (!value || value.length > 512 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const MeshArtifactPathSchema = z.string().refine(
  isRelativePosixArtifactPath,
  "artifact path must be a relative canonical POSIX path",
);

export const MeshArtifactFileSchema = z.object({
  type: z.literal("file"),
  path: MeshArtifactPathSchema,
  mode: z.number().int().min(0).max(0o777),
  size: z.number().int().nonnegative().max(1_048_576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().max(MAX_ARTIFACT_FILE_BASE64_CHARS),
}).strict();
export type MeshArtifactFile = z.infer<typeof MeshArtifactFileSchema>;

export const MeshBaseArtifactManifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("base"),
  artifactId: MeshArtifactIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(MeshArtifactFileSchema).max(MAX_ARTIFACT_FILES),
}).strict();
export type MeshBaseArtifactManifest = z.infer<typeof MeshBaseArtifactManifestSchema>;

export const MeshResultArtifactManifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("result"),
  artifactId: MeshArtifactIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseArtifactId: MeshArtifactIdSchema,
  taskId: MeshTaskIdSchema,
  changed: z.array(MeshArtifactFileSchema).max(MAX_ARTIFACT_FILES),
  deleted: z.array(MeshArtifactPathSchema).max(MAX_ARTIFACT_FILES),
}).strict();
export type MeshResultArtifactManifest = z.infer<typeof MeshResultArtifactManifestSchema>;

export function meshArtifactSha256(
  manifest: Pick<MeshBaseArtifactManifest, "version" | "kind" | "files">
    | Pick<MeshResultArtifactManifest, "version" | "kind" | "baseArtifactId" | "taskId" | "changed" | "deleted">,
): string {
  const identity = manifest.kind === "base"
    ? { version: manifest.version, kind: manifest.kind, files: manifest.files }
    : {
        version: manifest.version,
        kind: manifest.kind,
        baseArtifactId: manifest.baseArtifactId,
        taskId: manifest.taskId,
        changed: manifest.changed,
        deleted: manifest.deleted,
      };
  const bytes = sha256(utf8(stableStringify(identity)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function meshArtifactId(manifest: Parameters<typeof meshArtifactSha256>[0]): string {
  return `sha256:${meshArtifactSha256(manifest)}`;
}

export const MeshTaskRequestPayloadSchema = z.object({
  kind: z.literal("mesh-task-request"),
  task: MeshTaskRequestSchema,
  baseArtifact: MeshBaseArtifactManifestSchema.optional(),
  grant: MeshCapabilityGrantSchema.optional(),
  approval: MeshApprovalSchema.optional(),
}).strict();
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
  groupId: MeshGroupIdSchema,
  taskId: MeshTaskIdSchema,
  targetNodeId: MeshNodeIdSchema,
  operation: MeshOperationSchema,
  status: MeshTaskResultStatusSchema,
  decision: MeshAuditDecisionSchema,
  message: z.string(),
  result: MeshJsonValueSchema.optional(),
});
export type MeshTaskResultPayload = z.infer<typeof MeshTaskResultPayloadSchema>;

export const MeshTaskExecutionStatusSchema = z.enum([
  "unknown",
  "received",
  "approval-required",
  "queued",
  "running",
  "completed",
  "denied",
  "failed",
  "cancelled",
]);
export type MeshTaskExecutionStatus = z.infer<typeof MeshTaskExecutionStatusSchema>;

export const MeshTaskProgressPayloadSchema = z.object({
  kind: z.literal("mesh-task-progress"),
  taskId: MeshTaskIdSchema,
  targetNodeId: MeshNodeIdSchema,
  status: MeshTaskExecutionStatusSchema,
  message: z.string(),
  updatedAt: MeshTimestampSchema,
}).strict();
export type MeshTaskProgressPayload = z.infer<typeof MeshTaskProgressPayloadSchema>;

export const MeshTaskStatusRequestPayloadSchema = z.object({
  kind: z.literal("mesh-task-status-request"),
  requestId: MeshRequestIdSchema,
  requesterNodeId: MeshNodeIdSchema,
  targetNodeId: MeshNodeIdSchema,
  taskId: MeshTaskIdSchema,
}).strict();
export type MeshTaskStatusRequestPayload = z.infer<typeof MeshTaskStatusRequestPayloadSchema>;

export const MeshTaskStatusPayloadSchema = z.object({
  kind: z.literal("mesh-task-status"),
  requestId: MeshRequestIdSchema,
  targetNodeId: MeshNodeIdSchema,
  taskId: MeshTaskIdSchema,
  known: z.boolean(),
  status: MeshTaskExecutionStatusSchema,
  message: z.string().optional(),
  updatedAt: MeshTimestampSchema,
  result: MeshTaskResultPayloadSchema.optional(),
}).strict();
export type MeshTaskStatusPayload = z.infer<typeof MeshTaskStatusPayloadSchema>;

export const MeshTaskCancelRequestPayloadSchema = z.object({
  kind: z.literal("mesh-task-cancel-request"),
  requestId: MeshRequestIdSchema,
  requesterNodeId: MeshNodeIdSchema,
  targetNodeId: MeshNodeIdSchema,
  taskId: MeshTaskIdSchema,
}).strict();
export type MeshTaskCancelRequestPayload = z.infer<typeof MeshTaskCancelRequestPayloadSchema>;

export const MeshTaskCancelledPayloadSchema = z.object({
  kind: z.literal("mesh-task-cancelled"),
  requestId: MeshRequestIdSchema,
  targetNodeId: MeshNodeIdSchema,
  taskId: MeshTaskIdSchema,
  accepted: z.boolean(),
  status: MeshTaskExecutionStatusSchema,
  message: z.string(),
  updatedAt: MeshTimestampSchema,
}).strict();
export type MeshTaskCancelledPayload = z.infer<typeof MeshTaskCancelledPayloadSchema>;

export const MeshArtifactRequestPayloadSchema = z.object({
  kind: z.literal("mesh-artifact-request"),
  requestId: MeshRequestIdSchema,
  requesterNodeId: MeshNodeIdSchema,
  targetNodeId: MeshNodeIdSchema,
  taskId: MeshTaskIdSchema,
  artifactId: MeshArtifactIdSchema,
}).strict();
export type MeshArtifactRequestPayload = z.infer<typeof MeshArtifactRequestPayloadSchema>;

export const MeshArtifactPayloadSchema = z.object({
  kind: z.literal("mesh-artifact"),
  requestId: MeshRequestIdSchema,
  targetNodeId: MeshNodeIdSchema,
  taskId: MeshTaskIdSchema,
  manifest: MeshResultArtifactManifestSchema,
}).strict();
export type MeshArtifactPayload = z.infer<typeof MeshArtifactPayloadSchema>;

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
  MeshTaskProgressPayloadSchema,
  MeshTaskStatusRequestPayloadSchema,
  MeshTaskStatusPayloadSchema,
  MeshTaskCancelRequestPayloadSchema,
  MeshTaskCancelledPayloadSchema,
  MeshArtifactRequestPayloadSchema,
  MeshArtifactPayloadSchema,
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
