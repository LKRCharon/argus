import { randomUUID } from "node:crypto";
import {
  b64decode,
  fingerprint,
  MeshResourceListPayloadSchema,
  MeshResourceStatusPayloadSchema,
  MeshTaskCancelledPayloadSchema,
  MeshTaskProgressPayloadSchema,
  MeshTaskResultPayloadSchema,
  MeshTaskRequestPayloadSchema,
  MeshTaskStatusPayloadSchema,
  type MeshApproval,
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
  resources: Array<MeshResource & { nodeId: string; deviceName: string }>;
  tasks: ControlTaskRecord[];
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

interface PeerSession {
  peer: StoredPeer;
  conn: WsConn;
  chan: Awaited<ReturnType<typeof joinChan>>;
  closed: boolean;
  pendingResources: Map<string, PendingResourceRequest>;
  pendingStatuses: Map<string, PendingResourceStatusRequest>;
  pendingTaskStatuses: Map<string, PendingTaskStatusRequest>;
  pendingTaskCancels: Map<string, PendingTaskCancelRequest>;
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

  private readonly loadPeers: () => Record<string, StoredPeer>;
  private readonly reconnectDelayMs: number;
  private readonly snapshots = new Map<string, ControllerPeerSnapshot>();
  private readonly sessions = new Map<string, PeerSession>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(options: MeshControllerOptions = {}) {
    this.relayUrl = options.relayUrl ?? process.env.AGENTLINK_RELAY ?? "ws://127.0.0.1:8787/ws";
    this.nodeId = options.nodeId ?? fingerprint(loadOrCreateIdentity().publicKey);
    this.loadPeers = options.loadPeers ?? listPeers;
    this.journal = options.journal ?? new ControlTaskJournal();
    this.outbox = options.outbox ?? new ControlTaskOutbox();
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.syncPeers();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.connectAll();
    await this.refreshResources();
    this.refreshTimer = setInterval(() => {
      void this.refreshResources();
    }, RESOURCE_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
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
      this.rejectPending(session, new Error("Mesh controller stopped"));
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
        sendChain: Promise.resolve(),
        receiveLoop: Promise.resolve(),
      };
      this.sessions.set(peerId, session);
      conn.onClose = () => this.handleSessionLost(session, new Error("relay 连接已断开"));
      this.setSnapshot(peer, { status: "online", lastSeen: Date.now(), error: null });
      session.receiveLoop = this.receive(session);
      void session.receiveLoop.catch((error) => this.handleSessionLost(session, toError(error)));
      void this.requestResources(peerId).catch(() => undefined);
      void this.reconcilePeer(peerId).catch(() => undefined);
    } catch (error) {
      this.setSnapshot(peer, { status: "error", error: toError(error).message });
      this.scheduleReconnect(peerId);
      throw error;
    }
  }

  async refreshResources(): Promise<void> {
    this.syncPeers();
    await Promise.allSettled([...this.snapshots.keys()].map(async (peerId) => {
      const session = this.sessions.get(peerId);
      if (!session || session.closed) {
        await this.connectPeer(peerId).catch(() => undefined);
        return;
      }
      await Promise.allSettled([
        this.requestResources(peerId),
        this.reconcilePeer(peerId),
      ]);
    }));
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
          .filter((resource) => Boolean(resource.statusRunnerId))
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
  ): Promise<ControlTaskRecord> {
    const payload = MeshTaskRequestPayloadSchema.parse({
      kind: "mesh-task-request",
      task,
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
      groupId: task.groupId,
      targetNodeId: task.targetNodeId,
      resourceId: task.resourceId,
      operation: task.operation,
      requestDigest,
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
    const resources = MeshResourceListPayloadSchema.safeParse(payload);
    if (resources.success) {
      const pending = session.pendingResources.get(resources.data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        session.pendingResources.delete(resources.data.requestId);
        this.setSnapshot(session.peer, { resources: resources.data.resources, lastSeen: Date.now() });
        pending.resolve(resources.data.resources);
      }
      return;
    }

    const status = MeshResourceStatusPayloadSchema.safeParse(payload);
    if (status.success) {
      if (status.data.nodeId !== session.peer.fingerprint) return;
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
      }
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
          if (isTerminal(toControlStatus(remote.status))) this.outbox.remove(record.taskId);
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
  }

  private scheduleReconnect(peerId: string): void {
    if (!this.started || this.reconnectTimers.has(peerId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      void this.connectPeer(peerId).catch(() => undefined);
    }, this.reconnectDelayMs);
    timer.unref();
    this.reconnectTimers.set(peerId, timer);
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
