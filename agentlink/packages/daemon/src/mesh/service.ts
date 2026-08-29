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
  MeshTaskCancelRequestPayloadSchema,
  MeshTaskStatusRequestPayloadSchema,
  MeshArtifactRequestPayloadSchema,
  isMeshCapabilityGrantExpired,
  b64encode,
  signMeshApproval,
  signMeshCapabilityGrant,
  verifyMeshApproval,
  verifyMeshCapabilityGrant,
  type MeshApproval,
  type MeshArtifactPayload,
  type MeshCapabilityGrant,
  type MeshResource,
  type MeshResourceListPayload,
  type MeshResourceStatusPayload,
  type MeshJsonValue,
  type MeshTaskRequest,
  type MeshTaskCancelledPayload,
  type MeshTaskProgressPayload,
  type MeshTaskRequestPayload,
  type MeshTaskResultPayload,
  type MeshTaskStatusPayload,
  type MeshSigningKeyPair,
} from "@agentlink/wire";
import { randomUUID } from "node:crypto";
import { MeshExecutor, type LocalMeshResource } from "./executor";
import { MeshRunnerRegistry, type MeshRunnerResult, type MeshRunnerSpec } from "./runner";
import { MeshTaskStore, type MeshTaskLifecycleStatus, type MeshTaskRecord } from "./task-store";
import { MeshPolicyEngine, type MeshPolicyEngineOptions } from "./policy";
import { loadOrCreateMeshSigningKey } from "./signing";
import { appendMeshAuditEvent } from "./audit";
import { failedGpuStatus, parseGpuStatus } from "./gpu-status";
import { failedWorkspaceStatus, parseWorkspaceStatus } from "./workspace-status";
import { MeshArtifactStore, validateBaseArtifactManifest } from "./artifact-store";

export interface MeshServiceOptions {
  nodeId: string;
  trustedGroups: ReadonlySet<string>;
  groupMembers?: ReadonlyMap<string, ReadonlySet<string>>;
  trustedRequesters?: ReadonlySet<string>;
  resources?: LocalMeshResource[];
  allowedRoots?: string[];
  quarantineRoot?: string;
  artifactRoot?: string;
  maxEntries?: number;
  runners?: MeshRunnerSpec[];
  taskStore?: MeshTaskStore;
  artifactStore?: MeshArtifactStore;
  auditSink?: MeshPolicyEngineOptions["auditSink"];
  /** Test/integration injection; production defaults to the persisted owner key. */
  signingKey?: MeshSigningKeyPair;
}

export type MeshTaskProgressSink = (progress: MeshTaskProgressPayload) => void | Promise<void>;

export class MeshService {
  readonly nodeId: string;
  readonly executor: MeshExecutor;
  readonly runners: MeshRunnerRegistry;
  readonly tasks: MeshTaskStore;
  readonly artifacts: MeshArtifactStore;
  readonly policy: MeshPolicyEngine;
  private readonly signingKey: MeshSigningKeyPair;
  private readonly trustedRequesters?: ReadonlySet<string>;
  private readonly trustedGroups: ReadonlySet<string>;
  private readonly resources = new Map<string, LocalMeshResource>();
  /** In-memory marker distinguishes a live task from a journal entry left by a restart. */
  private readonly activeTasks = new Set<string>();

  constructor(options: MeshServiceOptions) {
    if (!options.nodeId.trim()) throw new Error("Mesh nodeId 不能为空");
    this.nodeId = options.nodeId;
    this.signingKey = options.signingKey ?? loadOrCreateMeshSigningKey();
    this.trustedRequesters = options.trustedRequesters;
    this.trustedGroups = options.trustedGroups;
    this.executor = new MeshExecutor({
      allowedRoots: options.allowedRoots,
      quarantineRoot: options.quarantineRoot,
      maxEntries: options.maxEntries,
    });
    for (const resource of options.resources ?? []) this.registerResource(resource);
    this.runners = new MeshRunnerRegistry(this.executor, options.runners);
    for (const resource of this.resources.values()) {
      if (!resource.statusRunnerId) continue;
      const statusRunner = this.runners.get(resource.statusRunnerId);
      if (!statusRunner || statusRunner.resourceId !== resource.id || statusRunner.purpose !== "status") {
        throw new Error(`资源 ${resource.id} 的 statusRunnerId 未绑定只读 status runner`);
      }
    }
    this.tasks = options.taskStore ?? new MeshTaskStore();
    this.artifacts = options.artifactStore ?? new MeshArtifactStore(options.artifactRoot);

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
    if (resource.allowedGroupIds?.some((groupId) => !this.trustedGroups.has(groupId))) {
      throw new Error("资源 allowedGroupIds 包含未受信任组");
    }
    this.executor.registerResource(resource);
    this.resources.set(resource.id, { ...resource });
  }

  listResources(): MeshResource[] {
    return [...this.resources.values()].map((resource) => {
      const allowedGroupIds = [...(resource.allowedGroupIds ?? this.trustedGroups)].sort();
      const allowedOperations = [
        "inspect" as const,
        ...(this.runners.forResource(resource.id).length > 0 ? ["run" as const] : []),
        "quarantine" as const,
      ];
      return {
      id: resource.id,
      ownerNodeId: resource.ownerNodeId,
      kind: resource.kind,
      displayName: resource.displayName,
      // Deliberately avoid sending an absolute local path over the channel.
      rootHint: resource.displayName,
      capabilities: allowedOperations,
      allowedOperations,
      allowedGroupIds,
      ...(allowedGroupIds.length === 1 ? { defaultGroupId: allowedGroupIds[0] } : {}),
      runnerIds: this.runners.forResource(resource.id),
      runners: this.runners.metadataForResource(resource.id),
      ...(resource.statusRunnerId ? { statusRunnerId: resource.statusRunnerId } : {}),
      };
    });
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
    if (!resource.statusRunnerId) {
      status = resource.kind === "gpu"
        ? failedGpuStatus("资源未配置只读 GPU 状态探针", observedAt)
        : failedWorkspaceStatus("资源未配置只读 workspace 状态探针", observedAt);
    } else {
      try {
        const runner = await this.runners.runStatus(resource.statusRunnerId, resource.id);
        status = runner.status === "completed"
          ? resource.kind === "gpu"
            ? parseGpuStatus(runner.resultSummary, observedAt)
            : parseWorkspaceStatus(runner.resultSummary, observedAt)
          : resource.kind === "gpu"
            ? failedGpuStatus("GPU 状态探针未成功完成", observedAt)
            : failedWorkspaceStatus("workspace 状态探针未成功完成", observedAt);
      } catch {
        status = resource.kind === "gpu"
          ? failedGpuStatus("GPU 状态探针不可用", observedAt)
          : failedWorkspaceStatus("workspace 状态探针不可用", observedAt);
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
    if (resource.allowedGroupIds && !resource.allowedGroupIds.includes(task.groupId)) {
      throw new Error("资源不允许该 trusted group");
    }
    if (["deploy", "delete", "sudo", "secret-read", "arbitrary-shell"].includes(task.operation)) {
      throw new Error("Mesh v0 不为部署、删除、sudo、密钥或任意 shell 签发 grant");
    }
    if (task.operation === "run") {
      const runScope = MeshRunScopeSchema.safeParse(task.scope ?? {});
      const runner = runScope.success ? this.runners.get(runScope.data.runnerId) : undefined;
      if (!runScope.success || !runner || runner.resourceId !== task.resourceId || runner.purpose !== "task"
        || (runScope.data.args.length > 0 && !runner.allowDynamicArgs)
        || (runScope.data.input !== undefined && !runner.allowInput)
        || (runner.workspaceCapabilities?.includes("task-scoped-workspace")
          && !runScope.data.baseArtifactId)
        || (runScope.data.baseArtifactId !== undefined
          && !runner.workspaceCapabilities?.includes("task-scoped-workspace"))) {
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
  async handle(payload: unknown, onProgress?: MeshTaskProgressSink): Promise<MeshTaskResultPayload | undefined> {
    const parsed = MeshTaskRequestPayloadSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    return this.handleRequest(parsed.data, onProgress);
  }

  /**
   * Validate and journal an unsigned run proposal for the target-local owner
   * UI. This never signs a capability and never invokes a runner.
   */
  proposeTask(payload: MeshTaskRequestPayload): MeshTaskProgressPayload | MeshTaskResultPayload {
    const task = payload.task;
    const artifactError = this.artifactBindingError(payload);
    if (artifactError) return this.result(task, "denied", "deny", `策略拒绝: ${artifactError}`);
    let begun;
    try {
      begun = this.tasks.begin(task);
    } catch {
      return this.result(task, "failed", "deny", "task journal unavailable");
    }
    if (begun.conflict) return this.result(task, "failed", "deny", "task id conflict");
    if (!begun.created) {
      if (begun.record.result) return begun.record.result;
      if (begun.record.status === "approval-required") {
        return this.progress(task, "approval-required", begun.record.message ?? "等待目标资源所有者批准");
      }
      if (begun.record.status === "queued" || begun.record.status === "running") {
        if (this.activeTasks.has(task.taskId)) {
          return this.progress(task, begun.record.status, begun.record.message ?? "任务正在目标设备执行");
        }
        const interrupted = this.result(task, "failed", "deny", "目标 daemon 曾在任务完成前重启，任务未自动重试");
        this.rememberResult(task.taskId, "failed", interrupted);
        return interrupted;
      }
    }

    const resource = this.resources.get(task.resourceId);
    const boundary = this.policy.authorize(task, {
      resource: resource ? {
        id: resource.id,
        ownerNodeId: resource.ownerNodeId,
        kind: resource.kind,
        displayName: resource.displayName,
        rootHint: resource.displayName,
        allowedGroupIds: resource.allowedGroupIds,
      } : undefined,
    });
    if (task.operation !== "run" || boundary.reason !== "grant-required") {
      const denied = this.result(task, "denied", "deny", `策略拒绝: ${boundary.reason}`);
      this.rememberResult(task.taskId, "denied", denied);
      return denied;
    }

    const runScope = MeshRunScopeSchema.safeParse(task.scope ?? {});
    const runner = runScope.success ? this.runners.get(runScope.data.runnerId) : undefined;
    if (!runScope.success || !runner || runner.resourceId !== task.resourceId || runner.purpose !== "task"
      || (runScope.data.args.length > 0 && !runner.allowDynamicArgs)
      || (runScope.data.input !== undefined && !runner.allowInput)
      || (runScope.data.baseArtifactId !== undefined
        && !runner.workspaceCapabilities?.includes("task-scoped-workspace"))) {
      const denied = this.result(task, "denied", "deny", "策略拒绝: invalid-runner-scope");
      this.rememberResult(task.taskId, "denied", denied);
      return denied;
    }

    const message = "等待目标资源所有者在本机批准";
    try {
      this.tasks.update(task.taskId, { status: "approval-required", message });
    } catch {
      return this.result(task, "failed", "deny", "task journal unavailable");
    }
    return this.progress(task, "approval-required", message);
  }

  denyProposal(taskId: string, message = "目标资源所有者拒绝了任务"): MeshTaskResultPayload {
    const record = this.tasks.get(taskId);
    if (!record || record.status !== "approval-required") throw new Error("审批请求已不存在或不可处理");
    const denied = this.resultFromRecord(record, "denied", "deny", message);
    this.rememberResult(taskId, "denied", denied);
    return denied;
  }

  taskStatus(request: unknown): MeshTaskStatusPayload {
    const parsed = MeshTaskStatusRequestPayloadSchema.parse(request);
    this.assertControlRequester(parsed.requesterNodeId, parsed.targetNodeId);
    const record = this.tasks.get(parsed.taskId);
    if (!record || record.requesterNodeId !== parsed.requesterNodeId) {
      return {
        kind: "mesh-task-status",
        requestId: parsed.requestId,
        targetNodeId: this.nodeId,
        taskId: parsed.taskId,
        known: false,
        status: "unknown",
        message: "目标设备没有该任务记录",
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      kind: "mesh-task-status",
      requestId: parsed.requestId,
      targetNodeId: this.nodeId,
      taskId: record.taskId,
      known: true,
      status: record.status,
      ...(record.message ? { message: record.message } : {}),
      updatedAt: record.updatedAt,
      ...(record.result ? { result: record.result } : {}),
    };
  }

  resultArtifact(request: unknown): MeshArtifactPayload {
    const parsed = MeshArtifactRequestPayloadSchema.parse(request);
    this.assertControlRequester(parsed.requesterNodeId, parsed.targetNodeId);
    const record = this.tasks.get(parsed.taskId);
    if (!record || record.requesterNodeId !== parsed.requesterNodeId || !record.result) {
      throw new Error("目标设备没有该任务的 result artifact");
    }
    const result = record.result.result;
    const resultRecord = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : undefined;
    if (resultRecord?.resultArtifactId !== parsed.artifactId) {
      throw new Error("result artifact 与任务不匹配");
    }
    return {
      kind: "mesh-artifact",
      requestId: parsed.requestId,
      targetNodeId: this.nodeId,
      taskId: parsed.taskId,
      manifest: this.artifacts.readResult(parsed.taskId, parsed.artifactId),
    };
  }

  cancelTask(request: unknown): MeshTaskCancelledPayload {
    const parsed = MeshTaskCancelRequestPayloadSchema.parse(request);
    this.assertControlRequester(parsed.requesterNodeId, parsed.targetNodeId);
    const record = this.tasks.get(parsed.taskId);
    if (!record || record.requesterNodeId !== parsed.requesterNodeId) {
      return this.cancelResult(parsed.requestId, parsed.taskId, false, "unknown", "目标设备没有该任务记录");
    }
    if (isTerminal(record.status)) {
      return this.cancelResult(parsed.requestId, record.taskId, false, record.status, "任务已经结束");
    }
    if (this.runners.cancel(record.taskId)) {
      return this.cancelResult(parsed.requestId, record.taskId, true, record.status, "取消信号已发送");
    }
    if (record.status !== "running") {
      const cancelled = this.cancelledTaskResult(record, "任务在执行前被目标资源所有者取消");
      this.rememberResult(record.taskId, "cancelled", cancelled);
      return this.cancelResult(parsed.requestId, record.taskId, true, "cancelled", cancelled.message);
    }
    return this.cancelResult(parsed.requestId, record.taskId, false, record.status, "当前执行器不支持中途取消");
  }

  async handleRequest(payload: MeshTaskRequestPayload, onProgress?: MeshTaskProgressSink): Promise<MeshTaskResultPayload> {
    const task = payload.task;
    const artifactError = this.artifactBindingError(payload);
    if (artifactError) return this.result(task, "denied", "deny", `策略拒绝: ${artifactError}`);
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
      await this.emitProgress(task, "queued", "任务已进入目标队列", onProgress);
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
          allowedGroupIds: resource.allowedGroupIds,
        } : undefined,
        grant: payload.grant,
        approval: payload.approval,
      });

      if (decision.decision === "approval-required") {
        const result = this.result(task, "approval-required", decision.decision, "等待目标资源所有者批准");
        this.rememberResult(task.taskId, "approval-required", result);
        await this.emitProgress(task, "approval-required", result.message, onProgress);
        return result;
      }
      if (!decision.allowed) {
        const result = this.result(task, "denied", decision.decision, `策略拒绝: ${decision.reason}`);
        this.rememberResult(task.taskId, "denied", result);
        await this.emitProgress(task, "denied", result.message, onProgress);
        return result;
      }

      this.tasks.update(task.taskId, { status: "running" });
      if (task.operation === "run") {
        const workspace = payload.baseArtifact
          ? this.artifacts.materialize(task.taskId, payload.baseArtifact)
          : undefined;
        // `run()` registers the child synchronously before returning its
        // promise. Publish "running" only after that point so an immediate
        // cancel request cannot race ahead of the runner registry.
        const runnerPromise = this.runners.run(task, workspace?.workspace);
        await this.emitProgress(task, "running", "任务正在目标设备执行", onProgress);
        const runner = await runnerPromise;
        const artifact = workspace && payload.baseArtifact
          ? this.artifacts.captureResult(task.taskId, payload.baseArtifact, workspace.workspace)
          : undefined;
        const result = this.result(
          task,
          runner.status === "completed" ? "completed" : runner.status,
          decision.decision,
          runner.status === "completed" ? "任务已完成" : "typed runner 未成功完成任务",
          this.runnerResult(runner, resource?.root, artifact),
        );
        this.rememberResult(task.taskId, runner.status, result);
        await this.emitProgress(task, runner.status, result.message, onProgress);
        return result;
      }
      await this.emitProgress(task, "running", "任务正在目标设备执行", onProgress);
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
      await this.emitProgress(task, "completed", completed.message, onProgress);
      return completed;
    } catch (error) {
      // Do not send OS paths, errno strings, or child-process output to a
      // peer. The local audit sink can retain a redacted diagnostic separately.
      void error;
      const failed = this.result(task, "failed", "deny", task.operation === "run" ? "typed runner failed" : "typed executor failed");
      this.rememberResult(task.taskId, "failed", failed);
      await this.emitProgress(task, "failed", failed.message, onProgress);
      return failed;
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }

  private assertControlRequester(requesterNodeId: string, targetNodeId: string): void {
    if (targetNodeId !== this.nodeId) throw new Error("任务控制请求目标不匹配");
    if (this.trustedRequesters && !this.trustedRequesters.has(requesterNodeId)) {
      throw new Error("任务控制请求者不受信任");
    }
  }

  private cancelResult(
    requestId: string,
    taskId: string,
    accepted: boolean,
    status: MeshTaskCancelledPayload["status"],
    message: string,
  ): MeshTaskCancelledPayload {
    return {
      kind: "mesh-task-cancelled",
      requestId,
      targetNodeId: this.nodeId,
      taskId,
      accepted,
      status,
      message,
      updatedAt: new Date().toISOString(),
    };
  }

  private cancelledTaskResult(record: MeshTaskRecord, message: string): MeshTaskResultPayload {
    return {
      kind: "mesh-task-result",
      groupId: record.groupId,
      taskId: record.taskId,
      targetNodeId: record.targetNodeId,
      operation: record.operation,
      status: "cancelled",
      decision: "deny",
      message,
    };
  }

  private async emitProgress(
    task: MeshTaskRequest,
    status: MeshTaskProgressPayload["status"],
    message: string,
    sink?: MeshTaskProgressSink,
  ): Promise<void> {
    if (!sink) return;
    try {
      await sink(this.progress(task, status, message));
    } catch {
      // Delivery can recover through mesh-task-status after a reconnect.
    }
  }

  private progress(
    task: MeshTaskRequest,
    status: MeshTaskProgressPayload["status"],
    message: string,
  ): MeshTaskProgressPayload {
    return {
      kind: "mesh-task-progress",
      taskId: task.taskId,
      targetNodeId: task.targetNodeId,
      status,
      message,
      updatedAt: new Date().toISOString(),
    };
  }

  private rememberResult(taskId: string, status: MeshTaskLifecycleStatus, result: MeshTaskResultPayload): void {
    try {
      this.tasks.update(taskId, { status, result, message: result.message });
    } catch {
      // The execution result is already safe to return. A journal failure is
      // deliberately not surfaced with filesystem details to the peer.
    }
  }

  private runnerResult(
    runner: MeshRunnerResult,
    resourceRoot?: string,
    artifact?: { artifactId: string; sha256: string; baseArtifactId: string; changed: unknown[]; deleted: unknown[] },
  ): Record<string, MeshJsonValue> {
    const redact = (value: string): string => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      return value
        .replaceAll(resourceRoot ?? "\u0000", "<resource>")
        .replaceAll(home || "\u0000", "<home>");
    };
    const summary = truncateUtf8(redact(runner.resultSummary), 16 * 1024);
    const debug = runner.debugOutput === undefined
      ? undefined
      : truncateUtf8(redact(runner.debugOutput), 8 * 1024);
    const meshTruncated = summary.truncated || Boolean(debug?.truncated);
    const complete = !runner.resultSummaryTruncated
      && !runner.debugOutputTruncated
      && !meshTruncated;
    return {
      runnerId: runner.runnerId,
      exitCode: runner.exitCode,
      signal: runner.signal,
      timedOut: runner.timedOut,
      durationMs: runner.durationMs,
      resultSummary: summary.value,
      ...(debug ? { debugOutput: debug.value } : {}),
      integrity: {
        complete,
        runner: {
          resultSummaryTruncated: runner.resultSummaryTruncated,
          debugOutputTruncated: runner.debugOutputTruncated,
          debugOutputSuppressed: runner.debugOutputSuppressed,
        },
        mesh: {
          resultSummaryTruncated: summary.truncated,
          debugOutputTruncated: debug?.truncated ?? false,
        },
      },
      ...(artifact ? {
        baseArtifactId: artifact.baseArtifactId,
        resultArtifactId: artifact.artifactId,
        resultArtifactSha256: artifact.sha256,
        changedFiles: artifact.changed.length,
        deletedFiles: artifact.deleted.length,
      } : {}),
    };
  }

  private artifactBindingError(payload: MeshTaskRequestPayload): string | undefined {
    if (payload.task.operation !== "run") return payload.baseArtifact ? "artifact-requires-run" : undefined;
    const scope = MeshRunScopeSchema.safeParse(payload.task.scope ?? {});
    if (!scope.success) return "invalid-runner-scope";
    const runner = this.runners.get(scope.data.runnerId);
    if (runner?.workspaceCapabilities?.includes("task-scoped-workspace") && !payload.baseArtifact) {
      return "artifact-required-for-runner";
    }
    if (Boolean(scope.data.baseArtifactId) !== Boolean(payload.baseArtifact)) {
      return "artifact-binding-required";
    }
    if (!payload.baseArtifact) return undefined;
    if (scope.data.baseArtifactId !== payload.baseArtifact.artifactId) return "artifact-id-mismatch";
    try {
      validateBaseArtifactManifest(payload.baseArtifact);
      return undefined;
    } catch {
      return "invalid-artifact-manifest";
    }
  }

  private result(
    task: MeshTaskRequest,
    status: MeshTaskResultPayload["status"],
    decision: MeshTaskResultPayload["decision"],
    message: string,
    result?: Record<string, MeshJsonValue>,
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

  private resultFromRecord(
    record: MeshTaskRecord,
    status: MeshTaskResultPayload["status"],
    decision: MeshTaskResultPayload["decision"],
    message: string,
  ): MeshTaskResultPayload {
    return {
      kind: "mesh-task-result",
      groupId: record.groupId,
      taskId: record.taskId,
      targetNodeId: record.targetNodeId,
      operation: record.operation,
      status,
      decision,
      message,
    };
  }
}

function isTerminal(status: MeshTaskLifecycleStatus): boolean {
  return ["completed", "denied", "failed", "cancelled"].includes(status);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}
