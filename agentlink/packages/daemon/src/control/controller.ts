import { createHash, randomUUID } from "node:crypto";
import {
  b64decode,
  fingerprint,
  MeshArtifactPayloadSchema,
  MeshResourceListPayloadSchema,
  MeshResourceStatusPayloadSchema,
  MeshTaskCancelledPayloadSchema,
  MeshTaskProgressPayloadSchema,
  MeshTaskResultPayloadSchema,
  MeshTaskRequestPayloadSchema,
  MeshTaskStatusPayloadSchema,
  MeshThreadIdSchema,
  stableStringify,
  type MeshApproval,
  type MeshBaseArtifactManifest,
  type MeshResultArtifactManifest,
  type MeshCapabilityGrant,
  type MeshResource,
  type MeshResourceStatus,
  type MeshTaskCancelledPayload,
  type MeshTaskRequest,
  type MeshTaskStatusPayload,
} from "@agentlink/wire";
import { joinChan, WsConn } from "../client";
import { listPeers, loadOrCreateIdentity, type StoredPeer } from "../store";
import { ControlTaskJournal, type ControlTaskRecord } from "./journal";
import {
  ControlTaskOutbox,
  digestControlTaskPayload,
  type ControlOutboxRecord,
} from "./outbox";
import {
  CodexGatewayError,
  CodexPeerGateway,
  type RemoteCodexApproval,
  type RemoteCodexEventsPage,
} from "./codex";
import {
  CodexOperationStore,
  codexOperationTimeoutPatch,
  type CodexOperationListQuery,
  type CodexOperationRecord,
} from "./codex-operations";
import { validateResultArtifactManifest } from "../mesh/artifact-store";

export type PeerConnectionState = "offline" | "connecting" | "online" | "error";

export interface ControllerPeerSnapshot {
  fingerprint: string;
  deviceName: string;
  platform: string;
  pairedAt: number;
  status: PeerConnectionState;
  lastSeen: number | null;
  error: string | null;
  resources: MeshResource[];
  resourceStatuses: Record<string, MeshResourceStatus>;
}

export interface ControllerOverview {
  controllerNodeId: string;
  relayUrl: string;
  generatedAt: number;
  peers: ControllerPeerSnapshot[];
  resources: Array<MeshResource & { nodeId: string; deviceName: string; status?: MeshResourceStatus }>;
  tasks: ControlTaskRecord[];
}

export interface ControllerReadiness {
  state: "starting" | "ready" | "degraded";
  reconciliationInProgress: boolean;
  lastReconciliationStartedAt: number | null;
  lastReconciliationCompletedAt: number | null;
  lastReconciliationError: string | null;
}

interface PendingResourceRequest {
  resolve: (resources: MeshResource[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingResourceStatusRequest {
  resolve: (status: MeshResourceStatus) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTaskStatusRequest {
  taskId: string;
  resolve: (status: MeshTaskStatusPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTaskCancelRequest {
  taskId: string;
  resolve: (status: MeshTaskCancelledPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingArtifactRequest {
  taskId: string;
  artifactId: string;
  resolve: (manifest: MeshResultArtifactManifest) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PeerSession {
  peer: StoredPeer;
  conn: WsConn;
  chan: Awaited<ReturnType<typeof joinChan>>;
  closed: boolean;
  pendingResources: Map<string, PendingResourceRequest>;
  pendingStatuses: Map<string, PendingResourceStatusRequest>;
  pendingTaskStatuses: Map<string, PendingTaskStatusRequest>;
  pendingTaskCancels: Map<string, PendingTaskCancelRequest>;
  pendingArtifacts: Map<string, PendingArtifactRequest>;
  sendChain: Promise<void>;
  receiveLoop: Promise<void>;
}

const RESOURCE_REFRESH_INTERVAL_MS = 60_000;

export interface MeshControllerOptions {
  relayUrl?: string;
  nodeId?: string;
  loadPeers?: () => Record<string, StoredPeer>;
  journal?: ControlTaskJournal;
  outbox?: ControlTaskOutbox;
  reconnectDelayMs?: number;
  codexOperationStore?: CodexOperationStore;
  codexRequestTimeoutMs?: number;
}

export interface ControlTaskSubmission {
  idempotencyKey: string;
  idempotencyDigest: string;
  baseArtifact?: MeshBaseArtifactManifest;
}

/**
 * Seoul-side controller for several independent encrypted device channels.
 * The relay remains zero-knowledge; this class only holds the controller's
 * paired long-term keys and routes typed Mesh payloads to the right peer.
 */
export class MeshController {
  readonly nodeId: string;
  readonly relayUrl: string;
  readonly journal: ControlTaskJournal;
  readonly outbox: ControlTaskOutbox;
  readonly codex: CodexPeerGateway;
  readonly codexOperations: CodexOperationStore;

  private readonly loadPeers: () => Record<string, StoredPeer>;
  private readonly reconnectDelayMs: number;
  private readonly snapshots = new Map<string, ControllerPeerSnapshot>();
  private readonly sessions = new Map<string, PeerSession>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private reconciliation?: Promise<void>;
  private readinessState: ControllerReadiness = {
    state: "starting",
    reconciliationInProgress: false,
    lastReconciliationStartedAt: null,
    lastReconciliationCompletedAt: null,
    lastReconciliationError: null,
  };

  constructor(options: MeshControllerOptions = {}) {
    this.relayUrl = options.relayUrl ?? process.env.AGENTLINK_RELAY ?? "ws://127.0.0.1:8787/ws";
    this.nodeId = options.nodeId ?? fingerprint(loadOrCreateIdentity().publicKey);
    this.loadPeers = options.loadPeers ?? listPeers;
    this.journal = options.journal ?? new ControlTaskJournal();
    this.outbox = options.outbox ?? new ControlTaskOutbox();
    this.codexOperations = options.codexOperationStore ?? new CodexOperationStore();
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.codex = new CodexPeerGateway(async (peerId, payload) => {
      await this.send(this.requireSession(peerId), payload);
    }, {
      requestTimeoutMs: options.codexRequestTimeoutMs,
      onUnmatchedResponse: (peerId, controlRequestId, payload) => {
        this.handleLateCodexOperation(peerId, controlRequestId, payload);
      },
    });
    this.syncPeers();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.refreshTimer = setInterval(() => {
      void this.refreshResources();
    }, RESOURCE_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
    void this.runReconciliation(async () => {
      await this.connectAll();
      return this.refreshResourcesOnce();
    });
  }

  readiness(): ControllerReadiness {
    return { ...this.readinessState };
  }

  stop(): void {
    this.started = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.conn.close();
      const error = new Error("Mesh controller stopped");
      this.rejectPending(session, error);
      this.codex.handleDisconnect(session.peer.fingerprint, error);
    }
    this.sessions.clear();
  }

  async connectAll(): Promise<void> {
    this.syncPeers();
    await Promise.allSettled([...this.snapshots.keys()].map((peerId) => this.connectPeer(peerId)));
  }

  async connectPeer(peerId: string): Promise<void> {
    const peer = this.loadPeers()[peerId];
    if (!peer) throw new Error(`未找到已配对设备: ${peerId}`);
    const current = this.sessions.get(peerId);
    if (current && !current.closed) return;

    const previousTimer = this.reconnectTimers.get(peerId);
    if (previousTimer) clearTimeout(previousTimer);
    this.reconnectTimers.delete(peerId);
    this.setSnapshot(peer, { status: "connecting", error: null });

    try {
      const conn = await WsConn.connect(this.relayUrl);
      const chan = await joinChan(conn, b64decode(peer.longTermKey), "controller");
      const session: PeerSession = {
        peer,
        conn,
        chan,
        closed: false,
        pendingResources: new Map(),
        pendingStatuses: new Map(),
        pendingTaskStatuses: new Map(),
        pendingTaskCancels: new Map(),
        pendingArtifacts: new Map(),
        sendChain: Promise.resolve(),
        receiveLoop: Promise.resolve(),
      };
      this.sessions.set(peerId, session);
      conn.onClose = () => this.handleSessionLost(session, new Error("relay 连接已断开"));
      this.setSnapshot(peer, { status: "online", lastSeen: Date.now(), error: null });
      session.receiveLoop = this.receive(session);
      void session.receiveLoop.catch((error) => this.handleSessionLost(session, toError(error)));
    } catch (error) {
      this.setSnapshot(peer, { status: "error", error: toError(error).message });
      this.scheduleReconnect(peerId);
      throw error;
    }
  }

  async refreshResources(): Promise<void> {
    return this.runReconciliation(() => this.refreshResourcesOnce());
  }

  private async refreshResourcesOnce(): Promise<number> {
    this.syncPeers();
    const failedPeers = new Set<string>();
    await Promise.all([...this.snapshots.keys()].map(async (peerId) => {
      let session = this.sessions.get(peerId);
      if (!session || session.closed) {
        try {
          await this.connectPeer(peerId);
        } catch {
          failedPeers.add(peerId);
          return;
        }
        session = this.sessions.get(peerId);
        if (!session || session.closed) {
          failedPeers.add(peerId);
          return;
        }
      }
      const results = await Promise.allSettled([
        this.requestResources(peerId),
        this.reconcilePeer(peerId),
      ]);
      if (results.some((result) => result.status === "rejected")) failedPeers.add(peerId);
    }));
    for (const [peerId, snapshot] of this.snapshots) {
      if (snapshot.status !== "online") failedPeers.add(peerId);
    }
    return failedPeers.size;
  }

  async requestResources(peerId: string): Promise<MeshResource[]> {
    const session = this.requireSession(peerId);
    const requestId = `resources-${randomUUID()}`;
    const resources = new Promise<MeshResource[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingResources.delete(requestId);
        reject(new Error("等待资源发现响应超时"));
      }, 15_000);
      session.pendingResources.set(requestId, { resolve, reject, timer });
    });
    try {
      await this.send(session, { kind: "mesh-resource-list-request", requestId });
      const discovered = await resources;
      await Promise.allSettled(
        discovered
          .filter((resource) => Boolean(resource.statusRunnerId || resource.githubStatusRunnerId))
          .map((resource) => this.requestResourceStatus(peerId, resource.id)),
      );
      return discovered;
    } catch (error) {
      session.pendingResources.delete(requestId);
      throw error;
    }
  }

  async requestResourceStatus(peerId: string, resourceId: string): Promise<MeshResourceStatus> {
    const session = this.requireSession(peerId);
    const requestId = `status-${randomUUID()}`;
    const status = new Promise<MeshResourceStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingStatuses.delete(requestId);
        reject(new Error("等待资源状态响应超时"));
      }, 15_000);
      session.pendingStatuses.set(requestId, { resolve, reject, timer });
    });
    try {
      await this.send(session, { kind: "mesh-resource-status-request", requestId, resourceId });
      return await status;
    } catch (error) {
      session.pendingStatuses.delete(requestId);
      throw error;
    }
  }

  async submitTask(
    task: MeshTaskRequest,
    grant?: MeshCapabilityGrant,
    approval?: MeshApproval,
    submission?: ControlTaskSubmission,
  ): Promise<ControlTaskRecord> {
    if (submission) {
      const byKey = this.journal.findByIdempotencyKey(task.requesterNodeId, submission.idempotencyKey);
      if (byKey) {
        if (byKey.idempotencyDigest !== submission.idempotencyDigest) {
          throw new Error("idempotencyKey 已绑定不同任务");
        }
        return byKey;
      }
    }
    const payload = MeshTaskRequestPayloadSchema.parse({
      kind: "mesh-task-request",
      task,
      ...(submission?.baseArtifact ? { baseArtifact: submission.baseArtifact } : {}),
      ...(grant ? { grant } : {}),
      ...(approval ? { approval } : {}),
    });
    const requestDigest = digestControlTaskPayload(payload);
    const existing = this.journal.get(task.taskId);
    if (existing && existing.requestDigest !== requestDigest) {
      throw new Error("taskId 已被另一个任务使用");
    }
    if (existing && isTerminal(existing.status)) return existing;

    const now = Date.now();
    const record = existing ?? this.journal.create({
      taskId: task.taskId,
      requesterNodeId: task.requesterNodeId,
      groupId: task.groupId,
      targetNodeId: task.targetNodeId,
      resourceId: task.resourceId,
      operation: task.operation,
      requestDigest,
      ...(submission ? {
        idempotencyKey: submission.idempotencyKey,
        idempotencyDigest: submission.idempotencyDigest,
      } : {}),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    try {
      this.outbox.put(payload);
    } catch {
      return this.journal.update(task.taskId, {
        status: "failed",
        decision: "deny",
        message: "任务无法写入可靠投递队列",
      }) ?? record;
    }
    const session = this.sessions.get(task.targetNodeId);
    if (!session || session.closed) {
      return this.journal.update(task.taskId, { message: "目标离线，任务已安全排队" }) ?? record;
    }
    try {
      await this.dispatchOutboxRecord(session, this.outbox.get(task.taskId)!);
      return this.journal.update(task.taskId, { message: "任务已发送，等待目标确认" }) ?? record;
    } catch {
      return this.journal.update(task.taskId, { message: "发送暂时失败，将在重连后对账" }) ?? record;
    }
  }

  async requestTaskStatus(peerId: string, taskId: string): Promise<MeshTaskStatusPayload> {
    const session = this.requireSession(peerId);
    const requestId = `task-status-${randomUUID()}`;
    const response = new Promise<MeshTaskStatusPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingTaskStatuses.delete(requestId);
        reject(new Error("等待任务状态响应超时"));
      }, 15_000);
      session.pendingTaskStatuses.set(requestId, { taskId, resolve, reject, timer });
    });
    try {
      await this.send(session, {
        kind: "mesh-task-status-request",
        requestId,
        requesterNodeId: this.nodeId,
        targetNodeId: peerId,
        taskId,
      });
      return await response;
    } catch (error) {
      const pending = session.pendingTaskStatuses.get(requestId);
      if (pending) clearTimeout(pending.timer);
      session.pendingTaskStatuses.delete(requestId);
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<ControlTaskRecord> {
    const record = this.journal.get(taskId);
    if (!record) throw new Error("未找到任务");
    if (isTerminal(record.status)) return record;
    const session = this.requireSession(record.targetNodeId);
    const requestId = `task-cancel-${randomUUID()}`;
    const response = new Promise<MeshTaskCancelledPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingTaskCancels.delete(requestId);
        reject(new Error("等待任务取消响应超时"));
      }, 15_000);
      session.pendingTaskCancels.set(requestId, { taskId, resolve, reject, timer });
    });
    try {
      await this.send(session, {
        kind: "mesh-task-cancel-request",
        requestId,
        requesterNodeId: this.nodeId,
        targetNodeId: record.targetNodeId,
        taskId,
      });
      const cancelled = await response;
      const updated = this.journal.update(taskId, {
        status: toControlStatus(cancelled.status),
        message: cancelled.message,
      }) ?? record;
      if (isTerminal(updated.status)) this.outbox.remove(taskId);
      return updated;
    } catch (error) {
      const pending = session.pendingTaskCancels.get(requestId);
      if (pending) clearTimeout(pending.timer);
      session.pendingTaskCancels.delete(requestId);
      throw error;
    }
  }

  async requestResultArtifact(taskId: string): Promise<MeshResultArtifactManifest> {
    const record = this.journal.get(taskId);
    if (!record) throw new Error("未找到任务");
    const artifactId = taskResultArtifactId(record);
    if (!artifactId) throw new Error("任务尚未产生 result artifact");
    const session = this.requireSession(record.targetNodeId);
    const requestId = `artifact-${randomUUID()}`;
    const response = new Promise<MeshResultArtifactManifest>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingArtifacts.delete(requestId);
        reject(new Error("等待 result artifact 响应超时"));
      }, 30_000);
      session.pendingArtifacts.set(requestId, { taskId, artifactId, resolve, reject, timer });
    });
    try {
      await this.send(session, {
        kind: "mesh-artifact-request",
        requestId,
        requesterNodeId: this.nodeId,
        targetNodeId: record.targetNodeId,
        taskId,
        artifactId,
      });
      return await response;
    } catch (error) {
      const pending = session.pendingArtifacts.get(requestId);
      if (pending) clearTimeout(pending.timer);
      session.pendingArtifacts.delete(requestId);
      throw error;
    }
  }

  async listCodexThreads(targetNodeId: string, deadlineMs = 30_000): Promise<Record<string, unknown>> {
    return this.codex.listThreads(targetNodeId, deadlineAt(deadlineMs));
  }

  async readCodexThread(targetNodeId: string, sessionId: string, deadlineMs = 30_000): Promise<Record<string, unknown>> {
    return this.codex.readThread(targetNodeId, sessionId, deadlineAt(deadlineMs));
  }

  startCodexThreadOperation(
    targetNodeId: string,
    text: string,
    idempotencyKey: string,
    cwd?: string,
    deadlineMs = 120_000,
    forkFromSessionId?: string,
  ): CodexOperationRecord {
    const forkSource = forkFromSessionId === undefined
      ? undefined
      : MeshThreadIdSchema.parse(forkFromSessionId);
    const requestDigest = createHash("sha256").update(stableStringify({
      targetNodeId,
      text,
      cwd: cwd ?? null,
      forkFromSessionId: forkSource ?? null,
    }), "utf8").digest("hex");
    const started = this.codexOperations.begin({
      requesterNodeId: this.nodeId,
      targetNodeId,
      idempotencyKey,
      requestDigest,
      deadlineAt: deadlineAt(deadlineMs),
    });
    if (started.conflict) throw new Error("idempotencyKey 已绑定不同 Codex operation");
    if (started.created) {
      queueMicrotask(() => {
        void this.executeCodexStart(started.record, text, cwd, forkSource);
      });
    }
    return started.record;
  }

  getCodexOperation(operationId: string): CodexOperationRecord | undefined {
    return this.codexOperations.get(operationId, this.nodeId);
  }

  listCodexOperations(query: CodexOperationListQuery): ReturnType<CodexOperationStore["list"]> {
    return this.codexOperations.list(this.nodeId, query);
  }

  async sendCodexInput(
    targetNodeId: string,
    sessionId: string,
    text: string,
    deadlineMs = 30_000,
  ): Promise<Record<string, unknown>> {
    return this.codex.sendInput(targetNodeId, sessionId, text, deadlineAt(deadlineMs));
  }

  async interruptCodexThread(
    targetNodeId: string,
    sessionId: string,
    deadlineMs = 30_000,
  ): Promise<Record<string, unknown>> {
    return this.codex.interrupt(targetNodeId, sessionId, deadlineAt(deadlineMs));
  }

  listCodexEvents(
    targetNodeId: string,
    afterSeq = 0,
    limit = 100,
    sessionId?: string,
  ): RemoteCodexEventsPage {
    return this.codex.listEvents(targetNodeId, afterSeq, limit, sessionId);
  }

  listCodexApprovals(targetNodeId?: string): RemoteCodexApproval[] {
    return this.codex.listApprovals(targetNodeId);
  }

  async respondCodexApproval(
    targetNodeId: string,
    requestId: string,
    optionId: "allow" | "deny",
  ): Promise<Record<string, unknown>> {
    return this.codex.respondApproval(targetNodeId, requestId, optionId);
  }

  private async executeCodexStart(
    record: CodexOperationRecord,
    text: string,
    cwd?: string,
    forkFromSessionId?: string,
  ): Promise<void> {
    const controlRequestId = `codex-op:${record.operationId}`;
    try {
      this.codexOperations.update(record.operationId, "sent", {
        sentAt: Date.now(),
        retryable: false,
        message: "request dispatch started for paired peer",
      });
      const response = await this.codex.startThread(record.targetNodeId, text, cwd, {
        controlRequestId,
        deadlineAt: record.deadlineAt,
        ...(forkFromSessionId ? { forkFromSessionId } : {}),
      });
      this.completeCodexStart(record.operationId, response);
    } catch (error) {
      const gateway = error instanceof CodexGatewayError
        ? error
        : new CodexGatewayError(error instanceof Error ? error.message : String(error), "controller", true, false);
      if (gateway.timedOut) {
        this.codexOperations.update(
          record.operationId,
          "timed_out",
          {
            ...codexOperationTimeoutPatch(gateway.stage, gateway.message),
            ...(gateway.sessionId ? { sessionId: gateway.sessionId } : {}),
          },
        );
      } else {
        this.codexOperations.update(record.operationId, "failed", {
          ...(gateway.sessionId ? { sessionId: gateway.sessionId } : {}),
          retryable: gateway.retryable,
          message: gateway.message.slice(0, 512),
          completedAt: Date.now(),
        });
      }
    }
  }

  private completeCodexStart(operationId: string, response: Record<string, unknown>): void {
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : undefined;
    const current = this.codexOperations.get(operationId, this.nodeId);
    if (!current || ["completed", "failed"].includes(current.status)) return;
    if (!sessionId) {
      if (current.status === "timed_out") return;
      this.codexOperations.update(operationId, "failed", {
        retryable: false,
        message: "watcher acknowledgement did not include sessionId",
        completedAt: Date.now(),
      });
      return;
    }
    const now = Date.now();
    const failed = response.lateAfterTimeout === true || response.status === "failed";
    if (current.status === "timed_out") {
      this.codexOperations.reconcileTimedOut(operationId, failed ? "failed" : "completed", {
        sessionId,
        acknowledgedAt: now,
        retryable: failed,
        message: failed
          ? "thread exists but the initial turn did not complete dispatch"
          : "late watcher acknowledgement reconciled after timeout",
        completedAt: now,
      });
      return;
    }
    this.codexOperations.update(operationId, "acknowledged", {
      sessionId,
      acknowledgedAt: now,
      retryable: false,
      message: "watcher acknowledged thread creation",
    });
    if (failed) {
      this.codexOperations.update(operationId, "failed", {
        sessionId,
        retryable: true,
        message: "thread exists but the initial turn did not complete dispatch",
        completedAt: Date.now(),
      });
      return;
    }
    this.codexOperations.update(operationId, "running", {
      sessionId,
      retryable: false,
      message: "initial Codex turn is running",
    });
    this.codexOperations.update(operationId, "completed", {
      sessionId,
      retryable: false,
      message: "thread and initial turn accepted",
      completedAt: Date.now(),
    });
  }

  private handleLateCodexOperation(
    targetNodeId: string,
    controlRequestId: string,
    payload: Record<string, unknown>,
  ): void {
    const operationId = controlRequestId.slice("codex-op:".length);
    const record = this.codexOperations.get(operationId, this.nodeId);
    if (!record || record.targetNodeId !== targetNodeId) return;
    if (record.status !== "timed_out") return;
    try {
      if (payload.kind === "input-ack") {
        this.completeCodexStart(operationId, payload);
        return;
      }
      if (payload.kind === "codex-error") {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
        if (payload.timedOut === true) {
          return;
        } else {
          this.codexOperations.reconcileTimedOut(operationId, "failed", {
            ...(sessionId ? { sessionId } : {}),
            retryable: payload.retryable === true,
            message: String(payload.note ?? "remote Codex operation failed").slice(0, 512),
            completedAt: Date.now(),
          });
        }
      }
    } catch {
      // A malformed or stale late response cannot erase the durable operation.
    }
  }

  overview(): ControllerOverview {
    this.syncPeers();
    const peers = [...this.snapshots.values()].sort((a, b) => a.deviceName.localeCompare(b.deviceName));
    const resources = peers.flatMap((peer) => peer.resources.map((resource) => ({
      ...resource,
      nodeId: peer.fingerprint,
      deviceName: peer.deviceName,
      ...(peer.resourceStatuses[resource.id] ? { status: peer.resourceStatuses[resource.id] } : {}),
    })));
    return {
      controllerNodeId: this.nodeId,
      relayUrl: this.relayUrl,
      generatedAt: Date.now(),
      peers,
      resources,
      tasks: this.journal.list(100),
    };
  }

  private async receive(session: PeerSession): Promise<void> {
    while (this.started && !session.closed) {
      const message = await session.conn.wait(
        (item) => item.op === "chan-data" || item.op === "chan-peer-left",
        24 * 3600_000,
      );
      if (message.op === "chan-peer-left") throw new Error("对端已离开设备通道");
      try {
        const payload = await session.chan.open<unknown>(message.data?.enc);
        this.handlePayload(session, payload);
        this.setSnapshot(session.peer, { lastSeen: Date.now(), error: null });
      } catch {
        // A malformed or unrelated encrypted frame must not kill the channel.
      }
    }
  }

  private handlePayload(session: PeerSession, payload: unknown): void {
    if (this.codex.handlePayload(session.peer.fingerprint, payload)) return;

    const resources = MeshResourceListPayloadSchema.safeParse(payload);
    if (resources.success) {
      const pending = session.pendingResources.get(resources.data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        session.pendingResources.delete(resources.data.requestId);
        this.setSnapshot(session.peer, { resources: resources.data.resources, lastSeen: Date.now() });
        pending.resolve(resources.data.resources);
      } else {
        console.log("[control] 忽略已超时或未知的资源清单响应");
      }
      return;
    }

    const status = MeshResourceStatusPayloadSchema.safeParse(payload);
    if (status.success) {
      if (status.data.nodeId !== session.peer.fingerprint) {
        console.log("[control] 忽略来源不匹配的资源状态响应");
        return;
      }
      const pending = session.pendingStatuses.get(status.data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        session.pendingStatuses.delete(status.data.requestId);
        const current = this.snapshots.get(session.peer.fingerprint);
        this.setSnapshot(session.peer, {
          resourceStatuses: {
            ...(current?.resourceStatuses ?? {}),
            [status.data.resourceId]: status.data.status,
          },
          lastSeen: Date.now(),
        });
        pending.resolve(status.data.status);
      } else {
        console.log("[control] 忽略已超时或未知的资源状态响应");
      }
      return;
    }
    if (payload && typeof payload === "object"
      && (payload as { kind?: unknown }).kind === "mesh-resource-status") {
      console.log("[control] 忽略格式无效的资源状态响应");
      return;
    }

    const progress = MeshTaskProgressPayloadSchema.safeParse(payload);
    if (progress.success) {
      if (progress.data.targetNodeId !== session.peer.fingerprint) return;
      const record = this.journal.get(progress.data.taskId);
      if (!record || record.targetNodeId !== session.peer.fingerprint) return;
      this.journal.update(progress.data.taskId, {
        status: toControlStatus(progress.data.status),
        message: progress.data.message,
      });
      return;
    }

    const taskStatus = MeshTaskStatusPayloadSchema.safeParse(payload);
    if (taskStatus.success) {
      if (taskStatus.data.targetNodeId !== session.peer.fingerprint) return;
      const pending = session.pendingTaskStatuses.get(taskStatus.data.requestId);
      if (pending && pending.taskId === taskStatus.data.taskId) {
        if (taskStatus.data.known) this.applyTaskStatus(session.peer.fingerprint, taskStatus.data);
        clearTimeout(pending.timer);
        session.pendingTaskStatuses.delete(taskStatus.data.requestId);
        pending.resolve(taskStatus.data);
      }
      return;
    }

    const cancelled = MeshTaskCancelledPayloadSchema.safeParse(payload);
    if (cancelled.success) {
      if (cancelled.data.targetNodeId !== session.peer.fingerprint) return;
      const pending = session.pendingTaskCancels.get(cancelled.data.requestId);
      if (pending && pending.taskId === cancelled.data.taskId) {
        clearTimeout(pending.timer);
        session.pendingTaskCancels.delete(cancelled.data.requestId);
        pending.resolve(cancelled.data);
      }
      return;
    }

    const artifact = MeshArtifactPayloadSchema.safeParse(payload);
    if (artifact.success) {
      if (artifact.data.targetNodeId !== session.peer.fingerprint) return;
      const pending = session.pendingArtifacts.get(artifact.data.requestId);
      if (pending
        && pending.taskId === artifact.data.taskId
        && pending.artifactId === artifact.data.manifest.artifactId) {
        clearTimeout(pending.timer);
        session.pendingArtifacts.delete(artifact.data.requestId);
        try {
          const manifest = validateResultArtifactManifest(artifact.data.manifest);
          if (manifest.taskId !== artifact.data.taskId) throw new Error("result artifact task binding mismatch");
          pending.resolve(manifest);
        } catch {
          pending.reject(new Error("result artifact integrity validation failed"));
        }
      }
      return;
    }

    const result = MeshTaskResultPayloadSchema.safeParse(payload);
    if (result.success) {
      if (result.data.targetNodeId !== session.peer.fingerprint) return;
      const record = this.journal.get(result.data.taskId);
      if (!record || record.targetNodeId !== session.peer.fingerprint) return;
      this.journal.update(result.data.taskId, {
        status: result.data.status,
        decision: result.data.decision,
        message: result.data.message,
        result: result.data.result,
      });
      if (isTerminal(result.data.status)) this.outbox.remove(result.data.taskId);
    }
  }

  private async send(session: PeerSession, payload: unknown): Promise<void> {
    if (session.closed) throw new Error("设备通道已关闭");
    const next = session.sendChain.then(async () => {
      if (session.closed) throw new Error("设备通道已关闭");
      session.conn.send({ op: "chan-data", data: { enc: await session.chan.seal(payload) } });
    });
    session.sendChain = next.catch(() => undefined);
    return next;
  }

  private async reconcilePeer(peerId: string): Promise<void> {
    const session = this.requireSession(peerId);
    for (const record of this.outbox.list(peerId)) {
      try {
        const remote = await this.requestTaskStatus(peerId, record.taskId);
        if (remote.known) {
          this.applyTaskStatus(peerId, remote);
          if (isTerminal(toControlStatus(remote.status))) {
            this.outbox.remove(record.taskId);
            continue;
          }
          // Re-send a pending proposal so a target can reconstruct a missing
          // local approval-inbox entry after a restart. The target task journal
          // still enforces the same request digest and cannot execute it twice.
          if (remote.status === "approval-required" || remote.status === "received") {
            await this.dispatchOutboxRecord(session, record).catch(() => undefined);
          }
          continue;
        }
      } catch {
        // A lost status reply is safe: resend the same idempotent envelope.
      }
      await this.dispatchOutboxRecord(session, record).catch(() => undefined);
    }
  }

  private async dispatchOutboxRecord(session: PeerSession, record: ControlOutboxRecord): Promise<void> {
    await this.send(session, record.payload);
    this.outbox.markAttempt(record.taskId);
  }

  private applyTaskStatus(peerId: string, status: MeshTaskStatusPayload): void {
    const current = this.journal.get(status.taskId);
    if (!current || current.targetNodeId !== peerId || status.targetNodeId !== peerId) return;
    const result = status.result;
    const updated = this.journal.update(status.taskId, {
      status: toControlStatus(status.status),
      message: status.message ?? result?.message,
      ...(result ? { decision: result.decision, result: result.result } : {}),
    });
    if (updated && isTerminal(updated.status)) this.outbox.remove(status.taskId);
  }

  private requireSession(peerId: string): PeerSession {
    const session = this.sessions.get(peerId);
    if (!session || session.closed) throw new Error(`设备未连接: ${peerId}`);
    return session;
  }

  private syncPeers(): void {
    const peers = this.loadPeers();
    for (const peer of Object.values(peers)) {
      if (!this.snapshots.has(peer.fingerprint)) {
        this.snapshots.set(peer.fingerprint, {
          fingerprint: peer.fingerprint,
          deviceName: peer.deviceName,
          platform: peer.platform,
          pairedAt: peer.pairedAt,
          status: "offline",
          lastSeen: null,
          error: null,
          resources: [],
          resourceStatuses: {},
        });
      }
    }
    for (const peerId of this.snapshots.keys()) {
      if (!peers[peerId] && !this.sessions.has(peerId)) this.snapshots.delete(peerId);
    }
  }

  private setSnapshot(peer: StoredPeer, patch: Partial<ControllerPeerSnapshot>): void {
    const current = this.snapshots.get(peer.fingerprint) ?? {
      fingerprint: peer.fingerprint,
      deviceName: peer.deviceName,
      platform: peer.platform,
      pairedAt: peer.pairedAt,
      status: "offline" as const,
      lastSeen: null,
      error: null,
      resources: [],
      resourceStatuses: {},
    };
    this.snapshots.set(peer.fingerprint, {
      ...current,
      deviceName: peer.deviceName,
      platform: peer.platform,
      pairedAt: peer.pairedAt,
      ...patch,
    });
  }

  private handleSessionLost(session: PeerSession, error: Error): void {
    if (session.closed) return;
    session.closed = true;
    this.rejectPending(session, error);
    this.codex.handleDisconnect(session.peer.fingerprint, error);
    if (this.sessions.get(session.peer.fingerprint) === session) this.sessions.delete(session.peer.fingerprint);
    this.setSnapshot(session.peer, { status: "offline", error: error.message });
    this.scheduleReconnect(session.peer.fingerprint);
  }

  private rejectPending(session: PeerSession, error: Error): void {
    for (const pending of session.pendingResources.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingResources.clear();
    for (const pending of session.pendingStatuses.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingStatuses.clear();
    for (const pending of session.pendingTaskStatuses.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingTaskStatuses.clear();
    for (const pending of session.pendingTaskCancels.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingTaskCancels.clear();
    for (const pending of session.pendingArtifacts.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingArtifacts.clear();
  }

  private scheduleReconnect(peerId: string): void {
    if (!this.started || this.reconnectTimers.has(peerId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      void this.connectPeer(peerId)
        .then(() => this.refreshResources())
        .catch(() => undefined);
    }, this.reconnectDelayMs);
    timer.unref();
    this.reconnectTimers.set(peerId, timer);
  }

  private runReconciliation(work: () => Promise<number>): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const startedAt = Date.now();
    this.readinessState = {
      ...this.readinessState,
      reconciliationInProgress: true,
      lastReconciliationStartedAt: startedAt,
    };
    const reconciliation = (async () => {
      let failedPeers = 0;
      let unexpectedFailure = false;
      try {
        failedPeers = await work();
      } catch {
        unexpectedFailure = true;
      }
      this.readinessState = {
        state: unexpectedFailure || failedPeers > 0 ? "degraded" : "ready",
        reconciliationInProgress: false,
        lastReconciliationStartedAt: startedAt,
        lastReconciliationCompletedAt: Date.now(),
        lastReconciliationError: unexpectedFailure
          ? "controller reconciliation failed"
          : failedPeers > 0
            ? `${failedPeers} peer reconciliation operation(s) failed`
            : null,
      };
    })();
    this.reconciliation = reconciliation;
    void reconciliation.then(() => {
      if (this.reconciliation === reconciliation) this.reconciliation = undefined;
    });
    return reconciliation;
  }
}

function toControlStatus(status: string): ControlTaskRecord["status"] {
  if (status === "received") return "queued";
  if (status === "unknown") return "queued";
  if (["queued", "running", "completed", "denied", "approval-required", "failed", "cancelled"].includes(status)) {
    return status as ControlTaskRecord["status"];
  }
  return "failed";
}

function isTerminal(status: ControlTaskRecord["status"]): boolean {
  return ["completed", "denied", "failed", "cancelled"].includes(status);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function deadlineAt(deadlineMs: number): number {
  const bounded = Number.isFinite(deadlineMs)
    ? Math.max(1_000, Math.min(Math.trunc(deadlineMs), 2 * 60_000))
    : 30_000;
  return Date.now() + bounded;
}

function taskResultArtifactId(record: ControlTaskRecord): string | undefined {
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) return undefined;
  const value = (record.result as Record<string, unknown>).resultArtifactId;
  return typeof value === "string" ? value : undefined;
}
