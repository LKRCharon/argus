import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MeshBaseArtifactManifestSchema,
  MeshArtifactPayloadSchema,
  MeshGroupIdSchema,
  MeshIdempotencyKeySchema,
  MeshNodeIdSchema,
  MeshOperationIdSchema,
  MeshRequestIdSchema,
  MeshResourceIdSchema,
  MeshRunnerIdSchema,
  MeshTaskIdSchema,
  MeshThreadIdSchema,
  meshArtifactSha256,
} from "@agentlink/wire";
import { isLoopbackHostname } from "./http-security";
import { validateResultArtifactManifest } from "../mesh/artifact-store";

const DEFAULT_CONTROL_URL = "http://127.0.0.1:8790";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const MAX_ARTIFACT_HTTP_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_LIST_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_TEXT_CHARS = 256 * 1024;
const MAX_ERROR_TEXT_CHARS = 512;
const MAX_PEERS = 32;
const MAX_RESOURCES = 64;
const MAX_GPU_DEVICES = 16;
const MAX_CODEX_THREADS = 40;
const MAX_CODEX_EVENTS = 100;
const MAX_CODEX_APPROVALS = 50;
const MAX_TASK_RESULT_DEPTH = 3;
const MAX_TASK_RESULT_ITEMS = 16;
const MAX_TASK_RESULT_STRING_CHARS = 1_024;

const DeadlineMsSchema = z.number().int().min(1_000).max(2 * 60_000);

const SubmitJobInputSchema = z.object({
  groupId: MeshGroupIdSchema.optional(),
  targetNodeId: MeshNodeIdSchema,
  resourceId: MeshResourceIdSchema,
  operation: z.union([z.literal("inspect"), z.literal("run")]),
  runnerId: MeshRunnerIdSchema.optional(),
  args: z.array(z.string().max(4_096)).max(64).optional(),
  input: z.string().max(1_048_576).optional(),
  timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
  idempotencyKey: MeshIdempotencyKeySchema.optional(),
  baseArtifact: MeshBaseArtifactManifestSchema.optional(),
}).strip();

const JobIdInputSchema = z.object({
  taskId: MeshTaskIdSchema,
}).strip();
const ListJobsInputSchema = z.object({
  targetNodeId: MeshNodeIdSchema.optional(),
  resourceId: MeshResourceIdSchema.optional(),
  groupId: MeshGroupIdSchema.optional(),
  status: z.enum(["queued", "running", "completed", "denied", "approval-required", "failed", "cancelled"]).optional(),
  createdAfter: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strip();
const RemoteTargetInputSchema = z.object({
  targetNodeId: MeshNodeIdSchema,
  deadlineMs: DeadlineMsSchema.optional().default(30_000),
}).strip();
const RemoteThreadInputSchema = RemoteTargetInputSchema.extend({
  sessionId: MeshThreadIdSchema,
}).strip();
const RemoteStartInputSchema = RemoteTargetInputSchema.extend({
  text: z.string().max(64 * 1024).refine((value) => value.trim().length > 0, "text 不能为空"),
  cwd: z.string().max(4_096).optional(),
  idempotencyKey: MeshIdempotencyKeySchema.optional(),
  deadlineMs: DeadlineMsSchema.optional().default(120_000),
}).strip();
const RemoteInputSchema = RemoteThreadInputSchema.extend({
  text: z.string().max(64 * 1024).refine((value) => value.trim().length > 0, "text 不能为空"),
}).strip();
const RemoteEventsInputSchema = RemoteTargetInputSchema.extend({
  afterSeq: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(100).optional().default(50),
  sessionId: MeshThreadIdSchema.optional(),
}).strip();
const RemoteApprovalInputSchema = RemoteTargetInputSchema.extend({
  requestId: MeshRequestIdSchema,
  optionId: z.enum(["allow", "deny"]),
}).strip();
const RemoteOperationInputSchema = z.object({
  operationId: MeshOperationIdSchema,
}).strip();
const RemoteOperationListInputSchema = z.object({
  targetNodeId: MeshNodeIdSchema.optional(),
  status: z.enum(["queued", "sent", "acknowledged", "running", "completed", "failed", "timed_out"]).optional(),
  createdAfter: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strip();

export type MeshSubmitJobInput = z.infer<typeof SubmitJobInputSchema>;

export type ControlFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ControlMcpOptions {
  controlUrl?: string;
  fetchImpl?: ControlFetch;
  requestTimeoutMs?: number;
}

class GatewayError extends Error {}

/**
 * Narrow HTTP adapter for Seoul's loopback control API. It owns no device
 * identity, relay key, grant, or approval material.
 */
export class ControlApiClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: ControlFetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ControlMcpOptions = {}) {
    this.baseUrl = parseControlUrl(
      options.controlUrl ?? process.env.ARGUS_CONTROL_URL ?? DEFAULT_CONTROL_URL,
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = boundedRequestTimeout(options.requestTimeoutMs);
  }

  async listDevices(): Promise<unknown> {
    return this.request("GET", "/api/discovery");
  }

  async submitJob(input: MeshSubmitJobInput): Promise<unknown> {
    const common = {
      ...(input.groupId ? { groupId: input.groupId } : {}),
      targetNodeId: input.targetNodeId,
      resourceId: input.resourceId,
      operation: input.operation,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.baseArtifact ? { baseArtifact: input.baseArtifact } : {}),
    };
    const body = input.operation === "run" ? {
      ...common,
      scope: {
        runnerId: input.runnerId,
        args: input.args ?? [],
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.baseArtifact ? { baseArtifactId: input.baseArtifact.artifactId } : {}),
      },
    } : common;
    return this.request("POST", "/api/tasks", body);
  }

  async listJobs(input: z.infer<typeof ListJobsInputSchema>): Promise<unknown> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.targetNodeId) query.set("targetNodeId", input.targetNodeId);
    if (input.resourceId) query.set("resourceId", input.resourceId);
    if (input.groupId) query.set("groupId", input.groupId);
    if (input.status) query.set("status", input.status);
    if (input.createdAfter !== undefined) query.set("createdAfter", String(input.createdAfter));
    if (input.cursor) query.set("cursor", input.cursor);
    return this.request("GET", `/api/tasks?${query}`, undefined, {
      maxResponseBytes: MAX_LIST_HTTP_RESPONSE_BYTES,
    });
  }

  async getJob(taskId: string): Promise<unknown> {
    return this.request("GET", `/api/tasks/${encodePathSegment(taskId)}`);
  }

  async cancelJob(taskId: string): Promise<unknown> {
    return this.request("POST", `/api/tasks/${encodePathSegment(taskId)}/cancel`);
  }

  async getResultArtifact(taskId: string): Promise<unknown> {
    return this.request("GET", `/api/tasks/${encodePathSegment(taskId)}/artifact`, undefined, {
      maxResponseBytes: MAX_ARTIFACT_HTTP_RESPONSE_BYTES,
      timeoutMs: 35_000,
    });
  }

  async listCodexThreads(targetNodeId: string, deadlineMs: number): Promise<unknown> {
    const query = new URLSearchParams({ targetNodeId, deadlineMs: String(deadlineMs) });
    return this.request("GET", `/api/codex/threads?${query}`, undefined, {
      maxResponseBytes: MAX_LIST_HTTP_RESPONSE_BYTES,
      timeoutMs: deadlineMs + 2_000,
    });
  }

  async readCodexThread(targetNodeId: string, sessionId: string, deadlineMs: number): Promise<unknown> {
    return this.request("POST", "/api/codex/read", { targetNodeId, sessionId, deadlineMs }, { timeoutMs: deadlineMs + 2_000 });
  }

  async startCodexThread(
    targetNodeId: string,
    text: string,
    deadlineMs: number,
    cwd?: string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.request("POST", "/api/codex/start", {
      targetNodeId,
      text,
      deadlineMs,
      ...(cwd ? { cwd } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async getCodexOperation(operationId: string): Promise<unknown> {
    return this.request("GET", `/api/codex/operations/${encodePathSegment(operationId)}`);
  }

  async listCodexOperations(input: z.infer<typeof RemoteOperationListInputSchema>): Promise<unknown> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.targetNodeId) query.set("targetNodeId", input.targetNodeId);
    if (input.status) query.set("status", input.status);
    if (input.createdAfter !== undefined) query.set("createdAfter", String(input.createdAfter));
    if (input.cursor) query.set("cursor", input.cursor);
    return this.request("GET", `/api/codex/operations?${query}`);
  }

  async sendCodexInput(targetNodeId: string, sessionId: string, text: string, deadlineMs: number): Promise<unknown> {
    return this.request("POST", "/api/codex/input", { targetNodeId, sessionId, text, deadlineMs }, { timeoutMs: deadlineMs + 2_000 });
  }

  async interruptCodexThread(targetNodeId: string, sessionId: string, deadlineMs: number): Promise<unknown> {
    return this.request("POST", "/api/codex/interrupt", { targetNodeId, sessionId, deadlineMs }, { timeoutMs: deadlineMs + 2_000 });
  }

  async listCodexEvents(
    targetNodeId: string,
    afterSeq = 0,
    limit = 50,
    sessionId?: string,
  ): Promise<unknown> {
    const query = new URLSearchParams({
      targetNodeId,
      afterSeq: String(afterSeq),
      limit: String(limit),
    });
    if (sessionId) query.set("sessionId", sessionId);
    return this.request("GET", `/api/codex/events?${query}`);
  }

  async listCodexApprovals(targetNodeId: string): Promise<unknown> {
    return this.request("GET", `/api/codex/approvals?targetNodeId=${encodeURIComponent(targetNodeId)}`);
  }

  async respondCodexApproval(
    targetNodeId: string,
    requestId: string,
    optionId: "allow" | "deny",
  ): Promise<unknown> {
    return this.request("POST", "/api/codex/approval", { targetNodeId, requestId, optionId });
  }

  private endpoint(path: string): URL {
    const endpoint = new URL(this.baseUrl.href);
    const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/, "");
    const queryAt = path.indexOf("?");
    const pathname = queryAt >= 0 ? path.slice(0, queryAt) : path;
    const query = queryAt >= 0 ? path.slice(queryAt + 1) : "";
    endpoint.pathname = `${basePath}${pathname}`;
    endpoint.search = query;
    endpoint.hash = "";
    return endpoint;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; maxResponseBytes?: number } = {},
  ): Promise<unknown> {
    const abort = new AbortController();
    const timeoutMs = boundedRequestTimeout(options.timeoutMs ?? this.requestTimeoutMs);
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint(path), {
          method,
          headers: body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: abort.signal,
          redirect: "error",
        });
      } catch {
        if (abort.signal.aborted) throw new GatewayError("本地控制 API 请求超时（timedOutStage=controller, retryable=true）");
        throw new GatewayError("本地控制 API 不可用");
      }

      const payload = await readBoundedJson(response, options.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES);
      if (!response.ok) {
        const detail = safeApiErrorDetail(payload);
        throw new GatewayError(
          `控制 API 拒绝请求（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (abort.signal.aborted) throw new GatewayError("本地控制 API 请求超时（timedOutStage=controller, retryable=true）");
      throw new GatewayError("控制 API 响应读取失败");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createControlMcpServer(options: ControlMcpOptions = {}): McpServer {
  const api = new ControlApiClient(options);
  const server = new McpServer({
    name: "argus-seoul-control",
    version: "0.3.0",
  }, {
    instructions: "Argus Seoul Control 管理已配对设备。Mesh 只调度 owner-configured typed runner；远端 Codex 工具只操作用户指定的目标节点和线程，并保留目标 Codex 的审批。先用 mesh_list_devices 确认 targetNodeId；发送消息、打断回合或回答审批前必须有用户明确意图。绝不要请求或发送密钥、环境变量或任意 shell。",
  });

  server.registerTool("mesh_list_devices", {
    title: "List Mesh devices",
    description: "返回 Seoul 控制面已发现设备、资源和 GPU 状态的有界摘要。",
    inputSchema: z.object({}).strip(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => toolCall(async () => summarizeOverview(await api.listDevices())));

  server.registerTool("mesh_list_jobs", {
    title: "List Mesh jobs",
    description: "按目标、资源、可信组、状态和时间列出调用方可见任务；最多返回 100 条并使用 cursor 翻页。",
    inputSchema: ListJobsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => toolCall(async () => summarizeJobPage(await api.listJobs(input))));

  server.registerTool("mesh_submit_job", {
    title: "Submit Mesh job",
    description: "经 Seoul 控制 API 提交 inspect，或把 named runner 任务送到目标设备等待所有者本地批准。",
    inputSchema: SubmitJobInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => toolCall(async () => {
    if (input.operation === "run" && !input.runnerId) {
      throw new GatewayError("run 操作必须指定 owner-configured runnerId");
    }
    return summarizeTask(await api.submitJob(input));
  }));

  server.registerTool("mesh_get_job", {
    title: "Get Mesh job",
    description: "读取一个 Mesh 任务的当前状态和有界结果摘要。",
    inputSchema: JobIdInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ taskId }) => toolCall(async () => summarizeTask(await api.getJob(taskId))));

  server.registerTool("mesh_get_result_artifact", {
    title: "Get Mesh result artifact",
    description: "按 taskId 读取并校验目标返回的 content-addressed changed/deleted file manifest。",
    inputSchema: JobIdInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ taskId }) => artifactToolCall(async () => await api.getResultArtifact(taskId)));

  server.registerTool("mesh_cancel_job", {
    title: "Cancel Mesh job",
    description: "请求 Seoul 控制面取消一个 Mesh 任务。",
    inputSchema: JobIdInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ taskId }) => toolCall(async () => summarizeTask(await api.cancelJob(taskId))));

  server.registerTool("remote_codex_list_threads", {
    title: "List remote Codex threads",
    description: "列出指定已配对设备上的 Codex 线程、状态和工作目录摘要。",
    inputSchema: RemoteTargetInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, deadlineMs }) => toolCall(async () => (
    summarizeCodexThreadList(await api.listCodexThreads(targetNodeId, deadlineMs), targetNodeId)
  )));

  server.registerTool("remote_codex_read_thread", {
    title: "Read remote Codex thread",
    description: "续接并读取指定远端 Codex 线程的有界历史；不会发送新消息。",
    inputSchema: RemoteThreadInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, sessionId, deadlineMs }) => toolCall(async () => (
    summarizeCodexThread(await api.readCodexThread(targetNodeId, sessionId, deadlineMs), targetNodeId)
  )));

  server.registerTool("remote_codex_start_thread", {
    title: "Start remote Codex thread",
    description: "持久化异步创建操作并立即返回 operationId；使用状态工具取得最终 sessionId 和超时阶段。",
    inputSchema: RemoteStartInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, text, cwd, idempotencyKey, deadlineMs }) => toolCall(async () => (
    summarizeCodexOperation(await api.startCodexThread(
      targetNodeId,
      text,
      deadlineMs,
      cwd,
      idempotencyKey,
    ))
  )));

  server.registerTool("remote_codex_get_operation", {
    title: "Get remote Codex operation",
    description: "读取异步 Codex 创建操作的持久状态、超时阶段、可重试性和最终 sessionId。",
    inputSchema: RemoteOperationInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ operationId }) => toolCall(async () => (
    summarizeCodexOperation(await api.getCodexOperation(operationId))
  )));

  server.registerTool("remote_codex_list_operations", {
    title: "List remote Codex operations",
    description: "有界列出调用方可见的异步 Codex 操作，并支持 cursor 翻页。",
    inputSchema: RemoteOperationListInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => toolCall(async () => summarizeCodexOperationPage(
    await api.listCodexOperations(input),
  )));

  server.registerTool("remote_codex_send_message", {
    title: "Send remote Codex message",
    description: "向指定远端 Codex 线程发送消息；运行中的回合会被 steer，空闲线程会开始新回合。",
    inputSchema: RemoteInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, sessionId, text, deadlineMs }) => toolCall(async () => (
    summarizeCodexAck(await api.sendCodexInput(targetNodeId, sessionId, text, deadlineMs), targetNodeId)
  )));

  server.registerTool("remote_codex_interrupt", {
    title: "Interrupt remote Codex turn",
    description: "打断指定远端 Codex 线程当前正在运行的回合。",
    inputSchema: RemoteThreadInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, sessionId, deadlineMs }) => toolCall(async () => (
    summarizeCodexAck(await api.interruptCodexThread(targetNodeId, sessionId, deadlineMs), targetNodeId)
  )));

  server.registerTool("remote_codex_get_events", {
    title: "Get remote Codex events",
    description: "按递增游标读取指定设备上的远端 Codex 事件；使用返回的 nextSeq 继续轮询。",
    inputSchema: RemoteEventsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, afterSeq, limit, sessionId }) => toolCall(async () => (
    summarizeCodexEvents(
      await api.listCodexEvents(targetNodeId, afterSeq, limit, sessionId),
      targetNodeId,
    )
  )));

  server.registerTool("remote_codex_list_approvals", {
    title: "List remote Codex approvals",
    description: "列出指定设备上等待用户决定的 Codex 审批，不会自动批准。",
    inputSchema: RemoteTargetInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ targetNodeId }) => toolCall(async () => (
    summarizeCodexApprovals(await api.listCodexApprovals(targetNodeId), targetNodeId)
  )));

  server.registerTool("remote_codex_respond_approval", {
    title: "Respond to remote Codex approval",
    description: "仅在用户明确决定后，对指定远端 Codex 审批回答 allow 或 deny。",
    inputSchema: RemoteApprovalInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ targetNodeId, requestId, optionId }) => toolCall(async () => (
    summarizeCodexAck(
      await api.respondCodexApproval(targetNodeId, requestId, optionId),
      targetNodeId,
    )
  )));

  return server;
}

export async function startControlMcpServer(options: ControlMcpOptions = {}): Promise<void> {
  const server = createControlMcpServer(options);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 16 * 1024 * 1024,
  });
  await server.connect(transport);
}

async function toolCall(load: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(safeJsonText(await load()));
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: safeGatewayError(error) }],
    };
  }
}

async function artifactToolCall(load: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const payload = MeshArtifactPayloadSchema.parse(await load());
    const manifest = validateResultArtifactManifest(payload.manifest);
    if (manifest.taskId !== payload.taskId) throw new GatewayError("result artifact 任务绑定校验失败");
    const digest = meshArtifactSha256(manifest);
    if (payload.manifest.sha256 !== digest || payload.manifest.artifactId !== `sha256:${digest}`) {
      throw new GatewayError("result artifact 完整性校验失败");
    }
    const text = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_HTTP_RESPONSE_BYTES) {
      throw new GatewayError("result artifact 超过 MCP 安全上限");
    }
    return textResult(text);
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: safeGatewayError(error) }],
    };
  }
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function summarizeOverview(value: unknown): Record<string, unknown> {
  const overview = record(value);
  if (!overview) throw new GatewayError("控制 API 返回的设备摘要格式无效");
  const peers = array(overview.peers);
  const resources = array(overview.resources);
  const totalPeerCount = boundedCount(overview, "totalPeerCount");
  const totalResourceCount = boundedCount(overview, "totalResourceCount");
  const truncated = boundedTruncation(overview.truncated, totalPeerCount, totalResourceCount, peers.length, resources.length);
  const taskCount = numberField(overview, "taskCount");
  const taskStatusCounts = boundedTaskStatusCounts(overview.taskStatusCounts);
  return {
    controllerNodeId: idField(overview, "controllerNodeId", MeshNodeIdSchema),
    generatedAt: numberField(overview, "generatedAt"),
    counts: {
      peers: totalPeerCount,
      onlinePeers: boundedCount(overview, "onlinePeerCount"),
      resources: totalResourceCount,
      tasks: taskCount,
    },
    peers: peers.slice(0, MAX_PEERS).map(summarizePeer),
    resources: resources.slice(0, MAX_RESOURCES).map(summarizeResource),
    taskStatusCounts,
    truncated: {
      peers: truncated.peers,
      resources: truncated.resources,
    },
  };
}

function boundedCount(body: Record<string, unknown>, name: string, fallback?: number): number {
  const value = body[name] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(`控制 API 返回的 ${name} 格式无效`);
  }
  return value;
}

function boundedTruncation(value: unknown, totalPeers: number, totalResources: number, peerLength: number, resourceLength: number): { peers: number; resources: number } {
  const truncation = record(value);
  if (!truncation) throw new GatewayError("控制 API 返回的截断摘要格式无效");
  const peers = boundedCount(truncation, "peers");
  const resources = boundedCount(truncation, "resources");
  if (peers !== totalPeers - peerLength || resources !== totalResources - resourceLength) {
    throw new GatewayError("控制 API 返回的设备截断摘要不一致");
  }
  return { peers, resources };
}

function boundedTaskStatusCounts(value: unknown): Record<string, number> {
  const counts = record(value);
  if (!counts) throw new GatewayError("控制 API 返回的任务状态摘要格式无效");
  return Object.fromEntries(Object.entries(counts).slice(0, 16).flatMap(([status, count]) => (
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? [[status.slice(0, 64), count] as [string, number]]
      : []
  )));
}

function summarizePeer(value: unknown): Record<string, unknown> {
  const peer = record(value);
  return {
    nodeId: idField(peer, "fingerprint", MeshNodeIdSchema),
    deviceName: textField(peer, "deviceName", 256),
    platform: textField(peer, "platform", 128),
    status: textField(peer, "status", 64),
    lastSeen: numberField(peer, "lastSeen"),
    resourceCount: boundedCount(peer ?? {}, "resourceCount"),
  };
}

function summarizeResource(value: unknown): Record<string, unknown> {
  const resource = record(value);
  const status = record(resource?.status);
  const gpu = record(status?.gpu);
  const workspace = record(status?.workspace);
  const devices = array(gpu?.devices);
  const runners = array(resource?.runners);
  return {
    resourceId: idField(resource, "id", MeshResourceIdSchema),
    nodeId: idField(resource, "nodeId", MeshNodeIdSchema),
    deviceName: textField(resource, "deviceName", 256),
    kind: textField(resource, "kind", 64),
    displayName: textField(resource, "displayName", 256),
    capabilities: stringArray(resource?.capabilities, 32, 64),
    allowedOperations: stringArray(resource?.allowedOperations, 16, 64),
    allowedGroupIds: typedStringArray(resource?.allowedGroupIds, 32, MeshGroupIdSchema),
    defaultGroupId: idField(resource, "defaultGroupId", MeshGroupIdSchema),
    runnerIds: typedStringArray(resource?.runnerIds, 32, MeshRunnerIdSchema),
    statusRunnerId: idField(resource, "statusRunnerId", MeshRunnerIdSchema),
    runners: runners.slice(0, 32).map((item) => {
      const runner = record(item);
      return {
        runnerId: idField(runner, "runnerId", MeshRunnerIdSchema),
        title: textField(runner, "title", 128),
        purpose: textField(runner, "purpose", 16),
        approvalRequired: runner?.approvalRequired === true,
        maxRuntimeMs: numberField(runner, "maxRuntimeMs"),
        workspaceCapabilities: stringArray(runner?.workspaceCapabilities, 8, 64),
        inputSchema: safeUnknown(runner?.inputSchema, 0),
        resultSchema: safeUnknown(runner?.resultSchema, 0),
      };
    }),
    ...(status ? {
      status: {
        state: textField(status, "state", 64),
        summary: textField(status, "summary", 512),
        observedAt: textField(status, "observedAt", 128),
        error: textField(status, "error", 512),
        gpuDevices: devices.slice(0, MAX_GPU_DEVICES).map((item) => {
          const device = record(item);
          return {
            index: numberField(device, "index"),
            name: textField(device, "name", 128),
            temperatureC: numberField(device, "temperatureC"),
            memoryUsedMiB: numberField(device, "memoryUsedMiB"),
            memoryTotalMiB: numberField(device, "memoryTotalMiB"),
            utilizationGpuPercent: numberField(device, "utilizationGpuPercent"),
            driverVersion: textField(device, "driverVersion", 128),
          };
        }),
        truncatedGpuDevices: Math.max(0, devices.length - MAX_GPU_DEVICES),
        ...(workspace ? {
          workspace: {
            connectionStatus: textField(workspace, "connectionStatus", 32),
            watcherAvailable: workspace.watcherAvailable === true,
            codexAppServerAvailable: workspace.codexAppServerAvailable === true,
            remoteCodexControl: workspace.remoteCodexControl === true,
            activeJobs: numberField(workspace, "activeJobs"),
            workspaceRevision: workspaceRevisionField(workspace.workspaceRevision),
            lastSuccess: textField(workspace, "lastSuccess", 128),
            lastErrorStage: textField(workspace, "lastErrorStage", 32),
            checkedAt: textField(workspace, "checkedAt", 128),
          },
        } : {}),
      },
    } : {}),
  };
}

function summarizeTask(value: unknown): Record<string, unknown> {
  const outer = record(value);
  const candidate = record(outer?.task) ?? record(outer?.job) ?? outer;
  if (!candidate) throw new GatewayError("控制 API 返回的任务格式无效");
  const directSummary = Object.hasOwn(candidate, "resultSummary")
    ? safeUnknownTracked(candidate.resultSummary, 0)
    : undefined;
  return {
    taskId: idField(candidate, "taskId", MeshTaskIdSchema),
    groupId: idField(candidate, "groupId", MeshGroupIdSchema),
    targetNodeId: idField(candidate, "targetNodeId", MeshNodeIdSchema),
    resourceId: idField(candidate, "resourceId", MeshResourceIdSchema),
    operation: textField(candidate, "operation", 64),
    status: textField(candidate, "status", 64),
    phase: textField(candidate, "phase", 64),
    approvalStatus: textField(candidate, "approvalStatus", 64),
    decision: textField(candidate, "decision", 64),
    message: textField(candidate, "message", 512),
    createdAt: numberField(candidate, "createdAt"),
    updatedAt: numberField(candidate, "updatedAt"),
    pollAfterMs: numberField(candidate, "pollAfterMs"),
    idempotencyKey: idField(candidate, "idempotencyKey", MeshIdempotencyKeySchema),
    baseArtifactId: idField(candidate, "baseArtifactId", z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    resultArtifactId: idField(candidate, "resultArtifactId", z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    resultArtifactSha256: idField(
      candidate,
      "resultArtifactSha256",
      z.string().regex(/^[a-f0-9]{64}$/),
    ),
    ...(directSummary
      ? { resultSummary: directSummary.value }
      : {}),
    ...(Object.hasOwn(candidate, "integrity")
      ? { integrity: gatewayIntegrity(candidate.integrity, directSummary?.truncated ?? false) }
      : {}),
    ...(Object.hasOwn(candidate, "result")
      ? summarizeLegacyTaskResult(candidate.result)
      : {}),
  };
}

function summarizeJobPage(value: unknown): Record<string, unknown> {
  const page = record(value);
  if (!page) throw new GatewayError("控制 API 返回的任务列表格式无效");
  const jobs = array(page.jobs);
  return {
    jobs: jobs.slice(0, 100).map(summarizeTask),
    nextCursor: cursorField(page.nextCursor),
  };
}

function summarizeLegacyTaskResult(value: unknown): { result: unknown } {
  const safe = safeUnknownTracked(value, 0);
  const output = record(safe.value);
  if (output && Object.hasOwn(output, "integrity")) {
    output.integrity = gatewayIntegrity(record(value)?.integrity, safe.truncated);
  }
  return { result: output ?? safe.value };
}

function gatewayIntegrity(value: unknown, gatewayTruncated: boolean): Record<string, unknown> {
  const upstream = record(value);
  const sanitized = record(safeUnknown(value, 0)) ?? {};
  return {
    ...sanitized,
    complete: upstream?.complete === true && !gatewayTruncated,
    gateway: { truncated: gatewayTruncated },
  };
}

function summarizeCodexOperation(value: unknown): Record<string, unknown> {
  const operation = record(value);
  if (!operation) throw new GatewayError("控制 API 返回的 Codex operation 格式无效");
  return {
    operationId: idField(operation, "operationId", MeshOperationIdSchema),
    targetNodeId: idField(operation, "targetNodeId", MeshNodeIdSchema),
    idempotencyKey: idField(operation, "idempotencyKey", MeshIdempotencyKeySchema),
    kind: textField(operation, "kind", 64),
    status: textField(operation, "status", 64),
    timedOutStage: textField(operation, "timedOutStage", 64),
    retryable: operation.retryable === true,
    sessionId: idField(operation, "sessionId", MeshThreadIdSchema),
    message: textField(operation, "message", 512),
    createdAt: numberField(operation, "createdAt"),
    updatedAt: numberField(operation, "updatedAt"),
    deadlineAt: numberField(operation, "deadlineAt"),
    sentAt: numberField(operation, "sentAt"),
    acknowledgedAt: numberField(operation, "acknowledgedAt"),
    completedAt: numberField(operation, "completedAt"),
    pollAfterMs: numberField(operation, "pollAfterMs"),
  };
}

function summarizeCodexOperationPage(value: unknown): Record<string, unknown> {
  const page = record(value);
  if (!page) throw new GatewayError("控制 API 返回的 Codex operation 列表格式无效");
  return {
    operations: array(page.operations).slice(0, 100).map(summarizeCodexOperation),
    nextCursor: cursorField(page.nextCursor),
  };
}

function summarizeCodexThreadList(value: unknown, targetNodeId: string): Record<string, unknown> {
  const payload = record(value);
  if (!payload || payload.kind !== "codex-thread-list") {
    throw new GatewayError("控制 API 返回的 Codex 线程列表格式无效");
  }
  const threads = array(payload.threads);
  return {
    targetNodeId,
    threads: threads.slice(0, MAX_CODEX_THREADS).map(summarizeCodexThreadRow),
    truncatedThreads: Math.max(0, threads.length - MAX_CODEX_THREADS),
  };
}

function summarizeCodexThread(value: unknown, targetNodeId: string): Record<string, unknown> {
  const payload = record(value);
  if (!payload || payload.kind !== "codex-resumed") {
    throw new GatewayError("控制 API 返回的 Codex 线程历史格式无效");
  }
  const events = array(payload.events);
  return {
    targetNodeId,
    sessionId: idField(payload, "sessionId", MeshThreadIdSchema),
    cwd: textField(payload, "cwd", 4_096),
    canAcceptDirectInput: payload.canAcceptDirectInput === true,
    events: events.slice(-MAX_CODEX_EVENTS).map(summarizeCodexEventPayload),
    truncatedEvents: Math.max(0, events.length - MAX_CODEX_EVENTS),
  };
}

function summarizeCodexAck(value: unknown, targetNodeId: string): Record<string, unknown> {
  const payload = record(value);
  if (!payload || !["input-ack", "permission-response-ack"].includes(String(payload.kind ?? ""))) {
    throw new GatewayError("控制 API 返回的 Codex 操作回执格式无效");
  }
  return {
    targetNodeId,
    kind: textField(payload, "kind", 64),
    sessionId: idField(payload, "sessionId", MeshThreadIdSchema),
    requestId: idField(payload, "requestId", MeshRequestIdSchema),
    status: textField(payload, "status", 64),
    note: textField(payload, "note", 512),
  };
}

function summarizeCodexEvents(value: unknown, targetNodeId: string): Record<string, unknown> {
  const payload = record(value);
  if (!payload) throw new GatewayError("控制 API 返回的 Codex 事件格式无效");
  const events = array(payload.events);
  return {
    targetNodeId,
    nextSeq: numberField(payload, "nextSeq"),
    events: events.slice(0, MAX_CODEX_EVENTS).map((item) => {
      const event = record(item);
      return {
        seq: numberField(event, "seq"),
        receivedAt: numberField(event, "receivedAt"),
        event: summarizeCodexEventPayload(event?.payload),
      };
    }),
    truncatedEvents: Math.max(0, events.length - MAX_CODEX_EVENTS),
  };
}

function summarizeCodexApprovals(value: unknown, targetNodeId: string): Record<string, unknown> {
  const payload = record(value);
  if (!payload) throw new GatewayError("控制 API 返回的 Codex 审批格式无效");
  const approvals = array(payload.approvals);
  return {
    targetNodeId,
    approvals: approvals.slice(0, MAX_CODEX_APPROVALS).map((item) => {
      const approval = record(item);
      return {
        requestId: idField(approval, "requestId", MeshRequestIdSchema),
        sessionId: idField(approval, "sessionId", MeshThreadIdSchema),
        toolName: textField(approval, "toolName", 256),
        summary: textField(approval, "summary", 2_000),
        options: array(approval?.options).slice(0, 16).map((optionValue) => {
          const option = record(optionValue);
          return {
            id: textField(option, "id", 64),
            label: textField(option, "label", 128),
          };
        }),
        receivedAt: numberField(approval, "receivedAt"),
      };
    }),
    truncatedApprovals: Math.max(0, approvals.length - MAX_CODEX_APPROVALS),
  };
}

function summarizeCodexThreadRow(value: unknown): Record<string, unknown> {
  const thread = record(value);
  return {
    sessionId: idField(thread, "id", MeshThreadIdSchema),
    name: textField(thread, "name", 512),
    preview: textField(thread, "preview", 1_024),
    cwd: textField(thread, "cwd", 4_096),
    status: textField(thread, "status", 64),
    source: textField(thread, "source", 64),
    parentThreadId: idField(thread, "parentThreadId", MeshThreadIdSchema),
    agentNickname: textField(thread, "agentNickname", 256),
    depth: numberField(thread, "depth"),
    updatedAt: numberField(thread, "updatedAt"),
    canAcceptDirectInput: thread?.canAcceptDirectInput === true,
  };
}

function summarizeCodexEventPayload(value: unknown): Record<string, unknown> {
  const event = record(value);
  if (!event) return { type: "unknown" };
  return {
    kind: textField(event, "kind", 64),
    type: textField(event, "type", 64),
    method: textField(event, "method", 256),
    sessionId: idField(event, "sessionId", MeshThreadIdSchema),
    agent: textField(event, "agent", 64),
    status: textField(event, "status", 64),
    name: textField(event, "name", 256),
    text: textField(event, "text", 2_000),
    summary: textField(event, "summary", 2_000),
    message: textField(event, "message", 2_000),
    reason: textField(event, "reason", 256),
    note: textField(event, "note", 512),
    ...(Object.hasOwn(event, "event") ? { event: safeUnknown(event.event, 0) } : {}),
    ...(Object.hasOwn(event, "params") ? { params: safeUnknown(event.params, 0) } : {}),
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new GatewayError("控制 API 响应超过安全上限");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError("控制 API 返回了无效 JSON");
  }
}

function safeApiErrorDetail(value: unknown): string {
  const payload = record(value);
  const detail = payload?.error ?? payload?.message;
  if (typeof detail === "string") return safeString(detail, 320);
  const error = record(detail);
  if (!error) return "";
  const message = typeof error.message === "string" ? safeString(error.message, 240) : "";
  const stage = typeof error.timedOutStage === "string" ? safeString(error.timedOutStage, 32) : "";
  const retryable = typeof error.retryable === "boolean" ? String(error.retryable) : "";
  return [message, stage ? `timedOutStage=${stage}` : "", retryable ? `retryable=${retryable}` : ""]
    .filter(Boolean)
    .join(", ");
}

function safeGatewayError(error: unknown): string {
  const message = error instanceof GatewayError ? error.message : "MCP 网关请求失败";
  return safeString(message, MAX_ERROR_TEXT_CHARS);
}

function safeJsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  return JSON.stringify({
    message: "MCP output exceeded its bounded response size; retry with a smaller page limit",
    gatewayTruncated: true,
    integrity: { complete: false, gateway: { truncated: true } },
  }, null, 2);
}

function safeUnknown(value: unknown, depth: number): unknown {
  return safeUnknownTracked(value, depth).value;
}

function safeUnknownTracked(
  value: unknown,
  depth: number,
): { value: unknown; truncated: boolean } {
  if (value === null || typeof value === "boolean") return { value, truncated: false };
  if (typeof value === "number") return { value: Number.isFinite(value) ? value : null, truncated: false };
  if (typeof value === "string") {
    return {
      value: looksLikeExplicitSecret(value)
        ? "<redacted-token>"
        : safeString(value, MAX_TASK_RESULT_STRING_CHARS),
      truncated: value.length > MAX_TASK_RESULT_STRING_CHARS,
    };
  }
  if (depth >= MAX_TASK_RESULT_DEPTH) return { value: "[truncated]", truncated: true };
  if (Array.isArray(value)) {
    let truncated = value.length > MAX_TASK_RESULT_ITEMS;
    const output = value.slice(0, MAX_TASK_RESULT_ITEMS).map((item) => {
      const safe = safeUnknownTracked(item, depth + 1);
      truncated ||= safe.truncated;
      return safe.value;
    });
    if (value.length > MAX_TASK_RESULT_ITEMS) output.push(`[${value.length - MAX_TASK_RESULT_ITEMS} more items]`);
    return { value: output, truncated };
  }
  const input = record(value);
  if (!input) return { value: safeString(String(value), 128), truncated: false };
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(input).slice(0, MAX_TASK_RESULT_ITEMS);
  let truncated = Object.keys(input).length > MAX_TASK_RESULT_ITEMS;
  for (const [key, item] of entries) {
    const safeKey = safeString(key, 64);
    if (!safeKey || ["__proto__", "constructor", "prototype"].includes(safeKey)) continue;
    if (sensitiveKey(safeKey)) {
      output[safeKey] = "<redacted>";
    } else {
      const safe = safeUnknownTracked(item, depth + 1);
      output[safeKey] = safe.value;
      truncated ||= safe.truncated;
    }
  }
  if (Object.keys(input).length > MAX_TASK_RESULT_ITEMS) {
    output._truncatedKeys = Object.keys(input).length - MAX_TASK_RESULT_ITEMS;
  }
  return { value: output, truncated };
}

function sensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[-_]/g, "");
  return compact === "header"
    || compact === "headers"
    || compact === "authorization"
    || compact === "proxyauthorization"
    || compact === "cookie"
    || compact === "setcookie"
    || compact.endsWith("apikey")
    || compact.endsWith("password")
    || compact.endsWith("secret")
    || compact.endsWith("token")
    || compact.endsWith("url")
    || compact.endsWith("uri")
    || compact.endsWith("endpoint");
}

function safeString(value: string, max: number): string {
  const redacted = value
    .replace(/\b(?:headers?|authorization|proxy-authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|cookie|set-cookie)\b\s*[:=]\s*[^\r\n,;]+/gi, "$1=<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\btoken\s+[A-Za-z0-9._~+/=-]{8,}/gi, "token <redacted>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s\"'<>]+/gi, "<redacted-url>")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, "<redacted-token>")
    .replace(/\b[A-Za-z0-9][A-Za-z0-9._~+/=-]{39,}/g, "<redacted-token>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return truncate(redacted, max);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const suffix = "\n[truncated]";
  return `${value.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textField(value: Record<string, unknown> | undefined, key: string, max: number): string | null {
  const field = value?.[key];
  return typeof field === "string" ? safeString(field, max) : null;
}

function idField(
  value: Record<string, unknown> | undefined,
  key: string,
  schema: z.ZodType<string>,
): string | null {
  const parsed = schema.safeParse(value?.[key]);
  if (!parsed.success) return null;
  return parsed.data;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function stringArray(value: unknown, limit: number, maxString: number): string[] {
  return array(value)
    .filter((item): item is string => typeof item === "string")
    .slice(0, limit)
    .map((item) => safeString(item, maxString));
}

function typedStringArray(value: unknown, limit: number, schema: z.ZodType<string>): string[] {
  return array(value)
    .slice(0, limit)
    .flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
}

function workspaceRevisionField(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/.test(value) ? value : null;
}

function cursorField(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return looksLikeExplicitSecret(value) ? "<redacted>" : value;
}

function looksLikeExplicitSecret(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?$/.test(value)
    || /^(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|AIza|AKIA)[A-Za-z0-9._-]{16,}$/.test(value);
}

function parseControlUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayError("ARGUS_CONTROL_URL 配置无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || !isLoopbackHostname(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new GatewayError("ARGUS_CONTROL_URL 配置无效");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed;
}

function boundedRequestTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(125_000, Math.max(1_000, Math.trunc(value)));
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
    .replace(/\./g, "%2E")
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

if (import.meta.main) {
  void startControlMcpServer().catch(() => {
    process.stderr.write("Argus MCP gateway failed to start.\n");
    process.exitCode = 1;
  });
}
