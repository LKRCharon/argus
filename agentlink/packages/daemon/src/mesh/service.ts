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
  MeshRunScopeSchema,
  isMeshCapabilityGrantExpired,
  b64encode,
  signMeshApproval,
  signMeshCapabilityGrant,
  verifyMeshApproval,
  verifyMeshCapabilityGrant,
  type MeshApproval,
  type MeshCapabilityGrant,
  type MeshResource,
  type MeshResourceListPayload,
  type MeshResourceStatusPayload,
  type MeshTaskRequest,
  type MeshTaskRequestPayload,
  type MeshTaskResultPayload,
  type MeshSigningKeyPair,
} from "@agentlink/wire";
import { randomUUID } from "node:crypto";
import { MeshExecutor, type LocalMeshResource } from "./executor";
import { MeshRunnerRegistry, type MeshRunnerResult, type MeshRunnerSpec } from "./runner";
import { MeshTaskStore, type MeshTaskLifecycleStatus } from "./task-store";
import { MeshPolicyEngine, type MeshPolicyEngineOptions } from "./policy";
import { loadOrCreateMeshSigningKey } from "./signing";
import { appendMeshAuditEvent } from "./audit";
import { failedGpuStatus, parseGpuStatus } from "./gpu-status";

export interface MeshServiceOptions {
  nodeId: string;
  trustedGroups: ReadonlySet<string>;
  groupMembers?: ReadonlyMap<string, ReadonlySet<string>>;
  trustedRequesters?: ReadonlySet<string>;
  resources?: LocalMeshResource[];
  allowedRoots?: string[];
  quarantineRoot?: string;
  maxEntries?: number;
  runners?: MeshRunnerSpec[];
  taskStore?: MeshTaskStore;
  auditSink?: MeshPolicyEngineOptions["auditSink"];
  /** Test/integration injection; production defaults to the persisted owner key. */
  signingKey?: MeshSigningKeyPair;
}

export class MeshService {
  readonly nodeId: string;
  readonly executor: MeshExecutor;
  readonly runners: MeshRunnerRegistry;
  readonly tasks: MeshTaskStore;
  readonly policy: MeshPolicyEngine;
  private readonly signingKey: MeshSigningKeyPair;
  private readonly resources = new Map<string, LocalMeshResource>();
  /** In-memory marker distinguishes a live task from a journal entry left by a restart. */
  private readonly activeTasks = new Set<string>();

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
    this.runners = new MeshRunnerRegistry(this.executor, options.runners);
    this.tasks = options.taskStore ?? new MeshTaskStore();

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
    if (resource.ownerNodeId !== this.nodeId) {
      throw new Error("Mesh 本地资源的 ownerNodeId 必须是当前目标节点");
    }
    if (this.resources.has(resource.id)) throw new Error(`Mesh resource id 重复: ${resource.id}`);
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
      capabilities: [
        "inspect",
        ...(this.runners.forResource(resource.id).length > 0 ? ["run" as const] : []),
        "quarantine",
      ],
      runnerIds: this.runners.forResource(resource.id),
      ...(resource.statusRunnerId ? { statusRunnerId: resource.statusRunnerId } : {}),
    }));
  }

  /** Return discovery metadata without exposing local paths or environment. */
  resourceList(requestId: string): MeshResourceListPayload {
    if (!requestId.trim()) throw new Error("Mesh resource discovery 缺少 requestId");
    return {
      kind: "mesh-resource-list",
      requestId,
      nodeId: this.nodeId,
      resources: this.listResources(),
    };
  }

  async resourceStatus(requestId: string, resourceId: string): Promise<MeshResourceStatusPayload> {
    if (!requestId.trim()) throw new Error("GPU 状态请求缺少 requestId");
    if (!resourceId.trim()) throw new Error("GPU 状态请求缺少 resourceId");
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("未知资源");

    const observedAt = new Date().toISOString();
    let status;
    if (resource.kind !== "gpu" || !resource.statusRunnerId) {
      status = failedGpuStatus("资源未配置只读 GPU 状态探针", observedAt);
    } else {
      try {
        const runner = await this.runners.runStatus(resource.statusRunnerId, resource.id);
        status = runner.status === "completed"
          ? parseGpuStatus(runner.stdout, observedAt)
          : failedGpuStatus("GPU 状态探针未成功完成", observedAt);
      } catch {
        status = failedGpuStatus("GPU 状态探针不可用", observedAt);
      }
    }
    return {
      kind: "mesh-resource-status",
      requestId,
      nodeId: this.nodeId,
      resourceId,
      status,
    };
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
    if (task.operation === "run") {
      const runScope = MeshRunScopeSchema.safeParse(task.scope ?? {});
      const runner = runScope.success ? this.runners.get(runScope.data.runnerId) : undefined;
      if (!runScope.success || !runner || runner.resourceId !== task.resourceId) {
        throw new Error("run grant 必须绑定一个有效的本地 runnerId 和受限 scope");
      }
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
    const ownerPublicKey = b64encode(this.signingKey.publicKey);
    if (grant.issuerNodeId !== this.nodeId
      || grant.issuerPublicKey !== ownerPublicKey
      || !verifyMeshCapabilityGrant(grant, this.signingKey.publicKey)) {
      throw new Error("不能批准未经本机资源所有者签发的 Mesh grant");
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
  async handle(payload: unknown): Promise<MeshTaskResultPayload | undefined> {
    const parsed = MeshTaskRequestPayloadSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    return this.handleRequest(parsed.data);
  }

  async handleRequest(payload: MeshTaskRequestPayload): Promise<MeshTaskResultPayload> {
    const task = payload.task;
    let begun;
    try {
      begun = this.tasks.begin(task);
    } catch {
      return this.result(task, "failed", "deny", "task journal unavailable");
    }
    if (begun.conflict) return this.result(task, "failed", "deny", "task id conflict");
    if (!begun.created && begun.record.result) {
      const canContinueApproval = begun.record.status === "approval-required" && Boolean(payload.approval);
      if (!canContinueApproval) return begun.record.result;
    }
    if (!begun.created && (begun.record.status === "queued" || begun.record.status === "running")) {
      if (this.activeTasks.has(task.taskId)) return this.result(task, "running", "allow", "任务仍在执行");
      const interrupted = this.result(task, "failed", "deny", "目标 daemon 曾在任务完成前重启，任务未自动重试");
      this.rememberResult(task.taskId, "failed", interrupted);
      return interrupted;
    }
    try {
      this.tasks.update(task.taskId, { status: "queued" });
    } catch {
      return this.result(task, "failed", "deny", "task journal unavailable");
    }
    this.activeTasks.add(task.taskId);
    try {
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
        const result = this.result(task, "approval-required", decision.decision, "等待目标资源所有者批准");
        this.rememberResult(task.taskId, "approval-required", result);
        return result;
      }
      if (!decision.allowed) {
        const result = this.result(task, "denied", decision.decision, `策略拒绝: ${decision.reason}`);
        this.rememberResult(task.taskId, "denied", result);
        return result;
      }

      this.tasks.update(task.taskId, { status: "running" });
      if (task.operation === "run") {
        const runner = await this.runners.run(task);
        const result = this.result(
          task,
          runner.status === "completed" ? "completed" : runner.status,
          decision.decision,
          runner.status === "completed" ? "任务已完成" : "typed runner 未成功完成任务",
          this.runnerResult(runner, resource?.root),
        );
        this.rememberResult(task.taskId, runner.status, result);
        return result;
      }
      const execution = this.executor.execute(task, {
        allowed: true,
        resourceId: task.resourceId,
        operation: task.operation,
        taskId: task.taskId,
        grantId: payload.grant?.grantId,
      });
      if (task.operation === "quarantine") {
        // A quarantined resource is no longer an executable/listable target
        // until the owner restores it locally from its manifest.
        this.runners.unregisterForResource(task.resourceId);
        this.executor.unregisterResource(task.resourceId);
        this.resources.delete(task.resourceId);
      }
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
      const completed = this.result(task, "completed", decision.decision, "任务已完成", result);
      this.rememberResult(task.taskId, "completed", completed);
      return completed;
    } catch (error) {
      // Do not send OS paths, errno strings, or child-process output to a
      // peer. The local audit sink can retain a redacted diagnostic separately.
      void error;
      const failed = this.result(task, "failed", "deny", task.operation === "run" ? "typed runner failed" : "typed executor failed");
      this.rememberResult(task.taskId, "failed", failed);
      return failed;
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }

  private rememberResult(taskId: string, status: MeshTaskLifecycleStatus, result: MeshTaskResultPayload): void {
    try {
      this.tasks.update(taskId, { status, result, message: result.message });
    } catch {
      // The execution result is already safe to return. A journal failure is
      // deliberately not surfaced with filesystem details to the peer.
    }
  }

  private runnerResult(runner: MeshRunnerResult, resourceRoot?: string): Record<string, string | number | boolean | null> {
    const redact = (value: string): string => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      return value
        .replaceAll(resourceRoot ?? "\u0000", "<resource>")
        .replaceAll(home || "\u0000", "<home>");
    };
    return {
      runnerId: runner.runnerId,
      exitCode: runner.exitCode,
      signal: runner.signal,
      timedOut: runner.timedOut,
      durationMs: runner.durationMs,
      stdout: runner.outputExposed ? redact(runner.stdout) : "",
      stderr: runner.outputExposed ? redact(runner.stderr) : "",
      stdoutTruncated: runner.stdoutTruncated,
      stderrTruncated: runner.stderrTruncated,
      outputExposed: runner.outputExposed,
      outputSuppressed: !runner.outputExposed,
    };
  }

  private result(
    task: MeshTaskRequest,
    status: MeshTaskResultPayload["status"],
    decision: MeshTaskResultPayload["decision"],
    message: string,
    result?: Record<string, string | number | boolean | null>,
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
