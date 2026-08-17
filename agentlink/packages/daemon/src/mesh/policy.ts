/**
 * Target-side authorization for Argus Mesh.
 *
 * The model, a group-membership flag, and a remote approval message are all
 * untrusted inputs until this module validates their binding.  This engine is
 * deliberately independent of Codex/Qoder: an adapter must not be able to
 * turn a prompt into a privileged operation by itself.
 */

import {
  MeshCapabilityGrantSchema,
  isMeshCapabilityGrantExpired,
  type MeshApproval,
  type MeshAuditEvent,
  type MeshCapabilityGrant,
  type MeshOperation,
  type MeshResource,
  type MeshTaskRequest,
} from "@agentlink/wire";

export type MeshRisk = "low" | "medium" | "high" | "critical";
export type MeshDecision = "allow" | "deny" | "approval-required";

export interface MeshPolicyContext {
  /** Resolved locally; never trust a root/path supplied by the request. */
  readonly resource?: MeshResource;
  readonly grant?: MeshCapabilityGrant;
  /** Approval must be from the resource owner, not the requesting agent. */
  readonly approval?: MeshApproval;
  readonly ownerApproval?: MeshApproval;
  readonly nowMs?: number;
}

export interface MeshPolicyEngineOptions {
  /** Target node identity. If supplied, requests for another node are denied. */
  readonly nodeId?: string;
  /** Paired/trusted node identities allowed to submit Mesh requests. */
  readonly trustedRequesters?: ReadonlySet<string>;
  /** Explicit group memberships; an omitted set is fail-closed for Mesh. */
  readonly trustedGroups?: ReadonlySet<string>;
  /** When supplied, both the requester and target must be members of the task group. */
  readonly groupMembers?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly auditSink?: (event: MeshAuditEvent) => void;
  readonly clock?: () => number;
  readonly maxFutureSkewMs?: number;
  /** Verifies a grant with the target-side pinned owner public key. */
  readonly verifyGrant?: (grant: MeshCapabilityGrant, request: MeshTaskRequest) => boolean;
  /** Verifies the separate owner approval signature. */
  readonly verifyApproval?: (approval: MeshApproval, grant: MeshCapabilityGrant) => boolean;
}

export interface MeshAuthorizationResult {
  readonly decision: MeshDecision;
  readonly status: MeshDecision;
  readonly allowed: boolean;
  readonly risk: MeshRisk;
  readonly reason: string;
  readonly auditEventId: string;
}

export interface MeshOperationPolicy {
  readonly risk: MeshRisk;
  readonly grantRequired: boolean;
  readonly ownerApprovalRequired: boolean;
  readonly alwaysDeny: boolean;
}

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60_000;

export const defaultPolicy: Readonly<Record<MeshOperation, MeshOperationPolicy>> = Object.freeze({
  inspect: { risk: "low", grantRequired: false, ownerApprovalRequired: false, alwaysDeny: false },
  stage: { risk: "medium", grantRequired: true, ownerApprovalRequired: false, alwaysDeny: false },
  run: { risk: "medium", grantRequired: true, ownerApprovalRequired: false, alwaysDeny: false },
  "apply-patch": { risk: "high", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: false },
  quarantine: { risk: "high", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: false },
  deploy: { risk: "critical", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: true },
  delete: { risk: "critical", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: true },
  sudo: { risk: "critical", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: true },
  "secret-read": { risk: "critical", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: true },
  "arbitrary-shell": { risk: "critical", grantRequired: true, ownerApprovalRequired: true, alwaysDeny: true },
});

const KNOWN_OPERATIONS = new Set<MeshOperation>(Object.keys(defaultPolicy) as MeshOperation[]);

export function classifyRisk(operation: MeshOperation | string): MeshRisk {
  return isKnownOperation(operation) ? defaultPolicy[operation].risk : "critical";
}

export class MeshPolicyEngine {
  static readonly defaultPolicy = defaultPolicy;

  private readonly nodeId?: string;
  private readonly trustedRequesters?: ReadonlySet<string>;
  private readonly trustedGroups?: ReadonlySet<string>;
  private readonly groupMembers?: ReadonlyMap<string, ReadonlySet<string>>;
  private readonly auditSink?: MeshPolicyEngineOptions["auditSink"];
  private readonly clock: () => number;
  private readonly maxFutureSkewMs: number;
  private readonly verifyGrant?: MeshPolicyEngineOptions["verifyGrant"];
  private readonly verifyApproval?: MeshPolicyEngineOptions["verifyApproval"];
  private readonly usedNonces = new Set<string>();
  private readonly usedTaskIds = new Set<string>();
  private readonly revokedGrantIds = new Set<string>();
  private readonly revokedNonces = new Set<string>();
  private auditSequence = 0;

  constructor(options: MeshPolicyEngineOptions = {}) {
    this.nodeId = options.nodeId;
    this.trustedRequesters = options.trustedRequesters;
    this.trustedGroups = options.trustedGroups;
    this.groupMembers = options.groupMembers;
    this.auditSink = options.auditSink;
    this.clock = options.clock ?? Date.now;
    this.maxFutureSkewMs = Number.isFinite(options.maxFutureSkewMs) && (options.maxFutureSkewMs ?? 0) >= 0
      ? options.maxFutureSkewMs!
      : DEFAULT_MAX_FUTURE_SKEW_MS;
    this.verifyGrant = options.verifyGrant;
    this.verifyApproval = options.verifyApproval;
  }

  revoke(identifier: string | { grantId?: string; nonce?: string }): void {
    if (typeof identifier === "string") {
      const value = identifier.trim();
      if (value) {
        this.revokedGrantIds.add(value);
        this.revokedNonces.add(value);
      }
      return;
    }
    if (identifier.grantId?.trim()) this.revokedGrantIds.add(identifier.grantId.trim());
    if (identifier.nonce?.trim()) this.revokedNonces.add(identifier.nonce.trim());
  }

  revokeGrant(grantId: string): void {
    this.revoke({ grantId });
  }

  revokeNonce(nonce: string): void {
    this.revoke({ nonce });
  }

  authorize(request: MeshTaskRequest, context: MeshPolicyContext = {}): MeshAuthorizationResult {
    const nowMs = context.nowMs ?? this.clock();
    const operation = typeof request?.operation === "string" && isKnownOperation(request.operation)
      ? request.operation
      : "arbitrary-shell";
    const risk = classifyRisk(operation);
    const base = {
      groupId: safeId(request?.groupId),
      taskId: safeId(request?.taskId),
      actorNodeId: safeId(request?.requesterNodeId),
      targetNodeId: safeId(request?.targetNodeId),
      resourceId: safeId(request?.resourceId),
      operation,
      risk,
    } as const;

    if (!isValidRequest(request)) return this.finish({ ...base, decision: "deny", reason: "invalid-request" }, nowMs);
    if (!this.trustedGroups || !this.trustedGroups.has(request.groupId)) {
      return this.finish({ ...base, decision: "deny", reason: "group-not-trusted" }, nowMs);
    }
    const members = this.groupMembers?.get(request.groupId);
    if (members && (!members.has(request.requesterNodeId) || (this.nodeId && !members.has(this.nodeId)))) {
      return this.finish({ ...base, decision: "deny", reason: "group-member-not-trusted" }, nowMs);
    }
    if (this.trustedRequesters && !this.trustedRequesters.has(request.requesterNodeId)) {
      return this.finish({ ...base, decision: "deny", reason: "requester-not-trusted" }, nowMs);
    }
    if (this.nodeId && request.targetNodeId !== this.nodeId) {
      return this.finish({ ...base, decision: "deny", reason: "wrong-target-node" }, nowMs);
    }
    if (!context.resource || context.resource.id !== request.resourceId
      || context.resource.ownerNodeId !== request.targetNodeId) {
      return this.finish({ ...base, decision: "deny", reason: "resource-target-mismatch" }, nowMs);
    }
    if (!isKnownOperation(request.operation)) {
      return this.finish({ ...base, decision: "deny", reason: "unknown-operation" }, nowMs);
    }
    if (request.operation === "inspect") {
      return this.finish({ ...base, decision: "allow", reason: "read-only-inspection" }, nowMs);
    }

    const policy = defaultPolicy[request.operation];
    // This includes delete: the first release has quarantine but no hard delete.
    if (policy.alwaysDeny) {
      return this.finish({ ...base, decision: "deny", reason: "operation-denied" }, nowMs);
    }
    const grant = context.grant;
    if (!grant) return this.finish({ ...base, decision: "deny", reason: "grant-required" }, nowMs);

    const grantError = this.validateGrant(grant, request, context, nowMs);
    if (grantError) {
      return this.finish({ ...base, decision: "deny", reason: grantError, grantId: safeId(grant.grantId) }, nowMs);
    }
    if (this.revokedGrantIds.has(grant.grantId) || this.revokedNonces.has(grant.nonce)) {
      return this.finish({ ...base, decision: "deny", reason: "grant-revoked", grantId: safeId(grant.grantId) }, nowMs);
    }
    if (this.usedNonces.has(grant.nonce)) {
      return this.finish({ ...base, decision: "deny", reason: "grant-replay", grantId: safeId(grant.grantId) }, nowMs);
    }
    if (this.usedTaskIds.has(request.taskId)) {
      return this.finish({ ...base, decision: "deny", reason: "task-replay", grantId: safeId(grant.grantId) }, nowMs);
    }

    if (policy.ownerApprovalRequired) {
      const approval = context.approval ?? context.ownerApproval;
      if (!approval) {
        return this.finish({
          ...base,
          decision: "approval-required",
          reason: "owner-approval-required",
          grantId: safeId(grant.grantId),
        }, nowMs);
      }
      const approvalError = this.validateApproval(approval, grant, context.resource, nowMs);
      if (approvalError) {
        return this.finish({
          ...base,
          decision: "deny",
          reason: approvalError,
          grantId: safeId(grant.grantId),
          approvalId: safeId(approval.approvalId),
        }, nowMs);
      }
    }

    // A successful authorization is one-shot. Approval-required remains
    // retryable, so reconnects cannot turn a pending approval into a replay.
    this.usedNonces.add(grant.nonce);
    this.usedTaskIds.add(request.taskId);
    return this.finish({
      ...base,
      decision: "allow",
      reason: "grant-authorized",
      grantId: safeId(grant.grantId),
      approvalId: (context.approval ?? context.ownerApproval)?.approvalId,
    }, nowMs);
  }

  private validateGrant(
    grant: MeshCapabilityGrant,
    request: MeshTaskRequest,
    context: MeshPolicyContext,
    nowMs: number,
  ): string | undefined {
    if (!MeshCapabilityGrantSchema.safeParse(grant).success) return "invalid-grant";
    if (grant.subjectNodeId !== request.requesterNodeId) return "grant-subject-mismatch";
    if (grant.groupId !== request.groupId) return "grant-group-mismatch";
    if (grant.taskId !== request.taskId) return "grant-task-mismatch";
    if (grant.targetNodeId !== request.targetNodeId) return "grant-target-mismatch";
    if (grant.resourceId !== request.resourceId) return "grant-resource-mismatch";
    if (grant.operation !== request.operation) return "grant-operation-mismatch";
    if (!sameJson(grant.scope, request.scope)) return "grant-scope-mismatch";
    if (grant.issuerNodeId !== context.resource?.ownerNodeId) return "grant-issuer-mismatch";
    if (isMeshCapabilityGrantExpired(grant, nowMs)) return "grant-expired";
    if (Date.parse(grant.issuedAt) > nowMs + this.maxFutureSkewMs) return "grant-issued-in-future";

    // There is no caller-provided "already verified" escape hatch. A policy
    // engine without a pinned verifier cannot authorize a mutating grant.
    if (!this.verifyGrant) return "grant-authentication-required";
    try {
      if (!this.verifyGrant(grant, request)) return "grant-authentication-failed";
    } catch {
      return "grant-authentication-failed";
    }
    return undefined;
  }

  private validateApproval(
    approval: MeshApproval,
    grant: MeshCapabilityGrant,
    resource: MeshResource,
    nowMs: number,
  ): string | undefined {
    if (approval.grantId !== grant.grantId) return "approval-grant-mismatch";
    if (approval.approverNodeId !== resource.ownerNodeId) return "approval-owner-mismatch";
    if (approval.decision !== "allow") return "approval-denied";
    if (Date.parse(approval.createdAt) > nowMs + this.maxFutureSkewMs) return "approval-issued-in-future";
    if (!this.verifyApproval) return "approval-authentication-required";
    try {
      if (!this.verifyApproval(approval, grant)) return "approval-authentication-failed";
    } catch {
      return "approval-authentication-failed";
    }
    return undefined;
  }

  private finish(
    input: {
      taskId: string;
      groupId: string;
      actorNodeId: string;
      targetNodeId: string;
      resourceId: string;
      operation: MeshOperation;
      risk: MeshRisk;
      decision: MeshDecision;
      reason: string;
      grantId?: string;
      approvalId?: string;
    },
    nowMs: number,
  ): MeshAuthorizationResult {
    let decision = input.decision;
    let reason = input.reason;
    if (decision === "allow" && !this.auditSink) {
      decision = "deny";
      reason = "audit-unavailable";
    }
    const event: MeshAuditEvent = {
      eventId: `mesh-policy-${nowMs}-${this.auditSequence++}`,
      groupId: input.groupId,
      taskId: input.taskId,
      actorNodeId: input.actorNodeId,
      targetNodeId: input.targetNodeId,
      operation: input.operation,
      decision,
      reason,
      createdAt: new Date(nowMs).toISOString(),
    };
    if (this.auditSink) {
      try {
        this.auditSink(event);
      } catch {
        if (decision === "allow") {
          decision = "deny";
          reason = "audit-write-failed";
          event.decision = decision;
          event.reason = reason;
        }
      }
    }
    return {
      decision,
      status: decision,
      allowed: decision === "allow",
      risk: input.risk,
      reason,
      auditEventId: event.eventId,
    };
  }
}

function isKnownOperation(value: string): value is MeshOperation {
  return KNOWN_OPERATIONS.has(value as MeshOperation);
}

function isValidRequest(value: unknown): value is MeshTaskRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return ["groupId", "taskId", "requesterNodeId", "targetNodeId", "resourceId", "operation"]
    .every((key) => typeof request[key] === "string" && request[key].trim().length > 0);
}

function sameJson(left: unknown, right: unknown): boolean {
  // An empty scope is the canonical wire representation for a task that has
  // no additional constraints; callers may omit it in the request envelope.
  if (left === undefined && (right === undefined || isEmptyObject(right))) return true;
  if (right === undefined && isEmptyObject(left)) return true;
  return stableJson(left) === stableJson(right);
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "__undefined__";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "unknown";
  return value.trim().slice(0, 256);
}
