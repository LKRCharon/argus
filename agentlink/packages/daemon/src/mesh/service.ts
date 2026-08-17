/**
 * Safe Mesh task boundary for a target daemon.
 *
 * This is intentionally a small service rather than a second agent runtime:
 * it parses one typed task envelope, asks the local policy engine, and only
 * then invokes the typed executor. No remote cwd, command, or shell string is
 * ever forwarded to Codex/Qoder from here.
 */

import {
  MeshTaskRequestPayloadSchema,
  MeshTaskRequestSchema,
  MeshCapabilityGrantSchema,
  isMeshCapabilityGrantExpired,
  b64encode,
  signMeshApproval,
  signMeshCapabilityGrant,
  verifyMeshApproval,
  verifyMeshCapabilityGrant,
  type MeshApproval,
  type MeshCapabilityGrant,
  type MeshResource,
  type MeshTaskRequest,
  type MeshTaskRequestPayload,
  type MeshTaskResultPayload,
  type MeshSigningKeyPair,
} from "@agentlink/wire";
import { randomUUID } from "node:crypto";
import { MeshExecutor, type LocalMeshResource } from "./executor";
import { MeshPolicyEngine, type MeshPolicyEngineOptions } from "./policy";
import { loadOrCreateMeshSigningKey } from "./signing";
import { appendMeshAuditEvent } from "./audit";

export interface MeshServiceOptions {
  nodeId: string;
  trustedGroups: ReadonlySet<string>;
  groupMembers?: ReadonlyMap<string, ReadonlySet<string>>;
  trustedRequesters?: ReadonlySet<string>;
  resources?: LocalMeshResource[];
  allowedRoots?: string[];
  quarantineRoot?: string;
  maxEntries?: number;
  auditSink?: MeshPolicyEngineOptions["auditSink"];
  /** Test/integration injection; production defaults to the persisted owner key. */
  signingKey?: MeshSigningKeyPair;
}

export class MeshService {
  readonly nodeId: string;
  readonly executor: MeshExecutor;
  readonly policy: MeshPolicyEngine;
  private readonly signingKey: MeshSigningKeyPair;
  private readonly resources = new Map<string, LocalMeshResource>();

  constructor(options: MeshServiceOptions) {
    if (!options.nodeId.trim()) throw new Error("Mesh nodeId 不能为空");
    this.nodeId = options.nodeId;
    this.signingKey = options.signingKey ?? loadOrCreateMeshSigningKey();
    this.executor = new MeshExecutor({
      allowedRoots: options.allowedRoots,
      quarantineRoot: options.quarantineRoot,
      maxEntries: options.maxEntries,
    });
    for (const resource of options.resources ?? []) this.registerResource(resource);

    const ownerPublicKey = b64encode(this.signingKey.publicKey);
    this.policy = new MeshPolicyEngine({
      nodeId: options.nodeId,
      trustedGroups: options.trustedGroups,
      groupMembers: options.groupMembers,
      trustedRequesters: options.trustedRequesters,
      auditSink: options.auditSink ?? appendMeshAuditEvent,
      verifyGrant: (grant) => grant.issuerNodeId === this.nodeId
        && grant.issuerPublicKey === ownerPublicKey
        && verifyMeshCapabilityGrant(grant, this.signingKey.publicKey),
      verifyApproval: (approval) => approval.approverNodeId === this.nodeId
        && approval.approverPublicKey === ownerPublicKey
        && verifyMeshApproval(approval, this.signingKey.publicKey),
    });
  }

  registerResource(resource: LocalMeshResource): void {
    this.executor.registerResource(resource);
    this.resources.set(resource.id, { ...resource });
  }

  listResources(): MeshResource[] {
    return [...this.resources.values()].map((resource) => ({
      id: resource.id,
      ownerNodeId: resource.ownerNodeId,
      kind: resource.kind,
      displayName: resource.displayName,
      // Deliberately avoid sending an absolute local path over the channel.
      rootHint: resource.displayName,
    }));
  }

  /** Issue an owner-signed grant. Call this only from a local owner approval UI. */
  issueGrant(task: MeshTaskRequest, ttlMs = 15 * 60_000): MeshCapabilityGrant {
    if (!MeshTaskRequestSchema.safeParse(task).success) {
      throw new Error("Mesh grant 任务格式无效");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60_000) {
      throw new Error("Mesh grant 有效期必须在 1ms 到 24h 之间");
    }
    const resource = this.resources.get(task.resourceId);
    if (!resource || resource.ownerNodeId !== this.nodeId || task.targetNodeId !== this.nodeId) {
      throw new Error("只有目标资源所有者可以签发 Mesh grant");
    }
    if (["deploy", "delete", "sudo", "secret-read", "arbitrary-shell"].includes(task.operation)) {
      throw new Error("Mesh v0 不为部署、删除、sudo、密钥或任意 shell 签发 grant");
    }
    const issuedAt = Date.now();
    const unsigned = {
      groupId: task.groupId,
      taskId: task.taskId,
      grantId: `grant_${randomUUID()}`,
      subjectNodeId: task.requesterNodeId,
      targetNodeId: task.targetNodeId,
      resourceId: task.resourceId,
      operation: task.operation,
      scope: task.scope ?? {},
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + Math.max(1, ttlMs)).toISOString(),
      nonce: `nonce_${randomUUID()}`,
      issuerNodeId: this.nodeId,
      issuerPublicKey: b64encode(this.signingKey.publicKey),
    };
    return signMeshCapabilityGrant(unsigned, this.signingKey.secretKey);
  }

  /** Issue the second, separately signed owner approval for a grant. */
  issueApproval(grant: MeshCapabilityGrant, summary: string): MeshApproval {
    if (!MeshCapabilityGrantSchema.safeParse(grant).success) {
      throw new Error("Mesh approval 的 grant 格式无效");
    }
    const resource = this.resources.get(grant.resourceId);
    if (!resource || resource.ownerNodeId !== this.nodeId
      || grant.targetNodeId !== this.nodeId || grant.issuerNodeId !== this.nodeId) {
      throw new Error("只有目标资源所有者可以签发 Mesh approval");
    }
    if (isMeshCapabilityGrantExpired(grant)) throw new Error("不能批准已过期的 Mesh grant");
    if (["deploy", "delete", "sudo", "secret-read", "arbitrary-shell"].includes(grant.operation)) {
      throw new Error("Mesh v0 不为高风险操作签发 approval");
    }
    return signMeshApproval({
      approvalId: `approval_${randomUUID()}`,
      grantId: grant.grantId,
      approverNodeId: this.nodeId,
      approverPublicKey: b64encode(this.signingKey.publicKey),
      decision: "allow",
      summary: summary.slice(0, 500),
      createdAt: new Date().toISOString(),
    }, this.signingKey.secretKey);
  }

  /** Parse and process one authenticated-channel payload. */
  handle(payload: unknown): MeshTaskResultPayload | undefined {
    const parsed = MeshTaskRequestPayloadSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    return this.handleRequest(parsed.data);
  }

  handleRequest(payload: MeshTaskRequestPayload): MeshTaskResultPayload {
    const task = payload.task;
    const resource = this.resources.get(task.resourceId);
    const decision = this.policy.authorize(task, {
      resource: resource ? {
        id: resource.id,
        ownerNodeId: resource.ownerNodeId,
        kind: resource.kind,
        displayName: resource.displayName,
        rootHint: resource.displayName,
      } : undefined,
      grant: payload.grant,
      approval: payload.approval,
    });

    if (decision.decision === "approval-required") {
      return this.result(task, "approval-required", decision.decision, "等待目标资源所有者批准");
    }
    if (!decision.allowed) {
      return this.result(task, "denied", decision.decision, `策略拒绝: ${decision.reason}`);
    }

    try {
      const execution = this.executor.execute(task, {
        allowed: true,
        resourceId: task.resourceId,
        operation: task.operation,
        taskId: task.taskId,
        grantId: payload.grant?.grantId,
      });
      // Absolute quarantine paths are local control-plane data; do not expose
      // them to a peer. The local audit/manifest remains the recovery source.
      const result = {
        resourceId: execution.resourceId,
        kind: execution.kind,
        displayName: execution.displayName,
        entryCount: execution.entryCount,
        truncated: execution.truncated,
        bytes: execution.bytes,
      };
      return this.result(task, "completed", decision.decision, "任务已完成", result);
    } catch (error) {
      // Do not send OS paths, errno strings, or child-process output to a
      // peer. The local audit sink can retain a redacted diagnostic separately.
      void error;
      return this.result(task, "failed", "deny", "typed executor failed");
    }
  }

  private result(
    task: MeshTaskRequest,
    status: MeshTaskResultPayload["status"],
    decision: MeshTaskResultPayload["decision"],
    message: string,
    result?: Record<string, string | number | boolean>,
  ): MeshTaskResultPayload {
    return {
      kind: "mesh-task-result",
      groupId: task.groupId,
      taskId: task.taskId,
      targetNodeId: task.targetNodeId,
      operation: task.operation,
      status,
      decision,
      message,
      ...(result ? { result } : {}),
    };
  }
}
