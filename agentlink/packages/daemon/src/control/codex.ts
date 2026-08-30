import { randomUUID } from "node:crypto";
import {
  MeshRequestIdSchema,
  MeshThreadIdSchema,
  type MeshDeadlineStage,
} from "@agentlink/wire";

export interface RemoteCodexApproval {
  targetNodeId: string;
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  options: Array<{ id: string; label: string }>;
  receivedAt: number;
}

export interface RemoteCodexEvent {
  seq: number;
  targetNodeId: string;
  receivedAt: number;
  payload: Record<string, unknown>;
}

export interface RemoteCodexEventsPage {
  targetNodeId: string;
  events: RemoteCodexEvent[];
  nextSeq: number;
}

export interface CodexPeerGatewayOptions {
  requestTimeoutMs?: number;
  maxEventsPerPeer?: number;
  maxApprovalsPerPeer?: number;
  onUnmatchedResponse?: (
    targetNodeId: string,
    controlRequestId: string,
    payload: Record<string, unknown>,
  ) => void;
}

type SendToPeer = (targetNodeId: string, payload: Record<string, unknown>) => Promise<void>;

interface PendingRequest {
  targetNodeId: string;
  expectedKinds: ReadonlySet<string>;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexRequestOptions {
  deadlineAt?: number;
  controlRequestId?: string;
  onSent?: () => void;
  /** Allow a durable new-session request to use its bounded operation deadline. */
  durableStart?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_EVENTS_PER_PEER = 500;
const DEFAULT_MAX_APPROVALS_PER_PEER = 100;
const MAX_REMOTE_ERROR_CHARS = 512;
const DURABLE_START_RESPONSE_MARGIN_MS = 250;

export class CodexGatewayError extends Error {
  constructor(
    message: string,
    readonly stage: MeshDeadlineStage,
    readonly retryable: boolean,
    readonly timedOut: boolean,
    readonly sessionId?: string,
  ) {
    super(message);
  }
}

/**
 * Request/response and event state for Codex sessions on paired AgentLink peers.
 * Transport encryption and peer authentication remain owned by MeshController.
 */
export class CodexPeerGateway {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events = new Map<string, RemoteCodexEvent[]>();
  private readonly approvals = new Map<string, Map<string, RemoteCodexApproval>>();
  private readonly requestTimeoutMs: number;
  private readonly maxEventsPerPeer: number;
  private readonly maxApprovalsPerPeer: number;
  private readonly onUnmatchedResponse?: CodexPeerGatewayOptions["onUnmatchedResponse"];
  private nextEventSeq = 1;

  constructor(
    private readonly sendToPeer: SendToPeer,
    options: CodexPeerGatewayOptions = {},
  ) {
    this.requestTimeoutMs = boundedPositiveInt(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxEventsPerPeer = boundedPositiveInt(options.maxEventsPerPeer, DEFAULT_MAX_EVENTS_PER_PEER);
    this.maxApprovalsPerPeer = boundedPositiveInt(options.maxApprovalsPerPeer, DEFAULT_MAX_APPROVALS_PER_PEER);
    this.onUnmatchedResponse = options.onUnmatchedResponse;
  }

  async listThreads(targetNodeId: string, deadlineAt?: number): Promise<Record<string, unknown>> {
    return this.request(targetNodeId, { kind: "codex-threads" }, ["codex-thread-list"], { deadlineAt });
  }

  async readThread(targetNodeId: string, sessionId: string, deadlineAt?: number): Promise<Record<string, unknown>> {
    return this.request(targetNodeId, {
      kind: "codex-resume",
      sessionId,
    }, ["codex-resumed"], { deadlineAt });
  }

  async startThread(
    targetNodeId: string,
    text: string,
    cwd?: string,
    options: CodexRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request(targetNodeId, {
      kind: "new-session",
      agent: "codex",
      text,
      ...(cwd ? { cwd } : {}),
    }, ["input-ack"], { ...options, durableStart: true });
  }

  async sendInput(targetNodeId: string, sessionId: string, text: string, deadlineAt?: number): Promise<Record<string, unknown>> {
    return this.request(targetNodeId, {
      kind: "codex-input",
      sessionId,
      text,
    }, ["input-ack"], { deadlineAt });
  }

  async interrupt(targetNodeId: string, sessionId: string, deadlineAt?: number): Promise<Record<string, unknown>> {
    return this.request(targetNodeId, {
      kind: "codex-interrupt",
      sessionId,
    }, ["input-ack"], { deadlineAt });
  }

  listEvents(
    targetNodeId: string,
    afterSeq = 0,
    limit = 100,
    sessionId?: string,
  ): RemoteCodexEventsPage {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = (this.events.get(targetNodeId) ?? [])
      .filter((event) => event.seq > afterSeq)
      .filter((event) => !sessionId || payloadSessionId(event.payload) === sessionId)
      .slice(0, safeLimit);
    const latest = Math.max(afterSeq, this.events.get(targetNodeId)?.at(-1)?.seq ?? 0);
    return {
      targetNodeId,
      events: rows,
      nextSeq: rows.at(-1)?.seq ?? latest,
    };
  }

  listApprovals(targetNodeId?: string): RemoteCodexApproval[] {
    const rows = targetNodeId
      ? [...(this.approvals.get(targetNodeId)?.values() ?? [])]
      : [...this.approvals.values()].flatMap((items) => [...items.values()]);
    return rows.sort((a, b) => a.receivedAt - b.receivedAt);
  }

  async respondApproval(
    targetNodeId: string,
    requestId: string,
    optionId: "allow" | "deny",
  ): Promise<Record<string, unknown>> {
    const approval = this.approvals.get(targetNodeId)?.get(requestId);
    if (!approval) throw new Error("未找到待处理的远端 Codex 审批");
    if (!approval.options.some((option) => option.id === optionId)) {
      throw new Error("远端 Codex 审批不支持该选项");
    }
    const response = await this.request(targetNodeId, {
      kind: "permission-response",
      sessionId: approval.sessionId,
      requestId,
      optionId,
    }, ["permission-response-ack"]);
    if (response.status === "answered") {
      this.approvals.get(targetNodeId)?.delete(requestId);
    }
    return response;
  }

  /** Returns true when the payload belongs to the remote Codex control plane. */
  handlePayload(targetNodeId: string, payload: unknown): boolean {
    const value = record(payload);
    if (!value || typeof value.kind !== "string") return false;

    const controlRequestId = typedString(value.controlRequestId, MeshRequestIdSchema);
    if (controlRequestId) {
      const pending = this.pending.get(controlRequestId);
      if (pending && pending.targetNodeId === targetNodeId) {
        if (value.kind === "codex-error") {
          this.finishPending(controlRequestId);
          pending.reject(remoteGatewayError(value));
          return true;
        }
        if (pending.expectedKinds.has(value.kind)) {
          this.finishPending(controlRequestId);
          pending.resolve(value);
          return true;
        }
      }
      if (!pending && controlRequestId.startsWith("codex-op:")) {
        this.onUnmatchedResponse?.(targetNodeId, controlRequestId, value);
        return true;
      }
    }

    if (value.kind === "permission-request" && value.agent === "codex") {
      this.storeApproval(targetNodeId, value);
      this.storeEvent(targetNodeId, value);
      return true;
    }

    if (isCodexEvent(value)) {
      this.storeEvent(targetNodeId, value);
      return true;
    }
    return false;
  }

  handleDisconnect(targetNodeId: string, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.targetNodeId !== targetNodeId) continue;
      this.finishPending(requestId);
      pending.reject(asTransportError(error));
    }
  }

  private async request(
    targetNodeId: string,
    payload: Record<string, unknown>,
    expectedKinds: readonly string[],
    options: CodexRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const controlRequestId = options.controlRequestId ?? `codex:${randomUUID()}`;
    const deadlineAt = options.deadlineAt ?? Date.now() + this.requestTimeoutMs;
    const deadlineRemaining = deadlineAt - Date.now();
    const requestBudget = options.durableStart
      ? Math.max(1, deadlineRemaining - DURABLE_START_RESPONSE_MARGIN_MS)
      : this.requestTimeoutMs;
    const remaining = Math.min(requestBudget, deadlineRemaining);
    if (remaining <= 0) {
      throw new CodexGatewayError("controller deadline elapsed before dispatch", "controller", true, true);
    }
    let dispatched = false;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(controlRequestId);
        reject(dispatched
          ? new CodexGatewayError("等待 watcher 响应超时", "watcher", true, true)
          : new CodexGatewayError("relay dispatch 超时", "relay", true, true));
      }, remaining);
      this.pending.set(controlRequestId, {
        targetNodeId,
        expectedKinds: new Set(expectedKinds),
        resolve,
        reject,
        timer,
      });
    });
    void Promise.resolve()
      .then(() => this.sendToPeer(targetNodeId, { ...payload, controlRequestId, deadlineAt }))
      .then(() => {
        dispatched = true;
        options.onSent?.();
      }, (error) => {
        const pending = this.pending.get(controlRequestId);
        this.finishPending(controlRequestId);
        pending?.reject(asTransportError(error));
      });
    return await response;
  }

  private finishPending(controlRequestId: string): void {
    const pending = this.pending.get(controlRequestId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(controlRequestId);
  }

  private storeEvent(targetNodeId: string, payload: Record<string, unknown>): void {
    const rows = this.events.get(targetNodeId) ?? [];
    rows.push({
      seq: this.nextEventSeq++,
      targetNodeId,
      receivedAt: Date.now(),
      payload,
    });
    if (rows.length > this.maxEventsPerPeer) {
      rows.splice(0, rows.length - this.maxEventsPerPeer);
    }
    this.events.set(targetNodeId, rows);
  }

  private storeApproval(targetNodeId: string, payload: Record<string, unknown>): void {
    const requestId = typedString(payload.requestId, MeshRequestIdSchema);
    if (!requestId) return;
    const rows = this.approvals.get(targetNodeId) ?? new Map<string, RemoteCodexApproval>();
    rows.set(requestId, {
      targetNodeId,
      requestId,
      sessionId: typedString(payload.sessionId, MeshThreadIdSchema),
      toolName: boundedString(payload.toolName, 256),
      summary: boundedString(payload.summary, 2_000),
      options: Array.isArray(payload.options)
        ? payload.options.slice(0, 16).flatMap((item) => {
            const option = record(item);
            const id = boundedString(option?.id, 64);
            const label = boundedString(option?.label, 128);
            return id && label ? [{ id, label }] : [];
          })
        : [],
      receivedAt: Date.now(),
    });
    while (rows.size > this.maxApprovalsPerPeer) {
      const oldest = rows.keys().next().value;
      if (typeof oldest !== "string") break;
      rows.delete(oldest);
    }
    this.approvals.set(targetNodeId, rows);
  }
}

function isCodexEvent(payload: Record<string, unknown>): boolean {
  if (payload.kind === "codex-event" || payload.kind === "codex-error") return true;
  if (payload.kind === "session-started" && payload.agent === "codex") return true;
  if (payload.kind === "agent-event" && payload.agent === "codex") return true;
  return payload.kind === "input-ack" && typeof payload.sessionId === "string";
}

function payloadSessionId(payload: Record<string, unknown>): string {
  if (typeof payload.sessionId === "string") return payload.sessionId;
  const params = record(payload.params);
  if (typeof params?.threadId === "string") return params.threadId;
  const thread = record(params?.thread);
  return typeof thread?.id === "string" ? thread.id : "";
}

function boundedPositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function typedString(value: unknown, schema: typeof MeshRequestIdSchema): string {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : "";
}

function remoteGatewayError(payload: Record<string, unknown>): CodexGatewayError {
  const candidate = boundedString(payload.timedOutStage, 32);
  const stage: MeshDeadlineStage = ["controller", "relay", "peer", "watcher", "app-server"].includes(candidate)
    ? candidate as MeshDeadlineStage
    : "app-server";
  const timedOut = payload.timedOut === true;
  return new CodexGatewayError(
    boundedString(payload.note, MAX_REMOTE_ERROR_CHARS) || "远端 Codex 请求失败",
    stage,
    payload.retryable === true || timedOut,
    timedOut,
    typedString(payload.sessionId, MeshThreadIdSchema) || undefined,
  );
}

function asTransportError(error: unknown): CodexGatewayError {
  if (error instanceof CodexGatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const stage: MeshDeadlineStage = /未连接|closed|关闭|peer/i.test(message) ? "peer" : "relay";
  return new CodexGatewayError(message.slice(0, MAX_REMOTE_ERROR_CHARS), stage, true, false);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
