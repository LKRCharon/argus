import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DEFAULT_CONTROL_URL = "http://127.0.0.1:8790";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const MAX_TOOL_TEXT_CHARS = 12_000;
const MAX_ERROR_TEXT_CHARS = 512;
const MAX_PEERS = 32;
const MAX_RESOURCES = 64;
const MAX_GPU_DEVICES = 16;
const MAX_TASK_RESULT_DEPTH = 3;
const MAX_TASK_RESULT_ITEMS = 16;
const MAX_TASK_RESULT_STRING_CHARS = 1_024;

const IdSchema = z.string().trim().min(1).max(256);
const TaskIdSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "taskId 必须是安全的单路径段标识符");

const SubmitJobInputSchema = z.object({
  groupId: IdSchema,
  targetNodeId: IdSchema,
  resourceId: IdSchema,
  operation: z.union([z.literal("inspect"), z.literal("run")]),
  runnerId: IdSchema.optional(),
  args: z.array(z.string().max(4_096)).max(64).optional(),
  input: z.string().max(1_048_576).optional(),
  timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
}).strip();

const JobIdInputSchema = z.object({
  taskId: TaskIdSchema,
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
    return this.request("GET", "/api/overview");
  }

  async submitJob(input: MeshSubmitJobInput): Promise<unknown> {
    return this.request("POST", "/api/tasks", input);
  }

  async getJob(taskId: string): Promise<unknown> {
    return this.request("GET", `/api/tasks/${encodePathSegment(taskId)}`);
  }

  async cancelJob(taskId: string): Promise<unknown> {
    return this.request("POST", `/api/tasks/${encodePathSegment(taskId)}/cancel`);
  }

  private endpoint(path: string): URL {
    const endpoint = new URL(this.baseUrl.href);
    const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/, "");
    endpoint.pathname = `${basePath}${path}`;
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.requestTimeoutMs);
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
        if (abort.signal.aborted) throw new GatewayError("本地控制 API 请求超时");
        throw new GatewayError("本地控制 API 不可用");
      }

      const payload = await readBoundedJson(response);
      if (!response.ok) {
        const detail = safeApiErrorDetail(payload);
        throw new GatewayError(
          `控制 API 拒绝请求（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (abort.signal.aborted) throw new GatewayError("本地控制 API 请求超时");
      throw new GatewayError("控制 API 响应读取失败");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createControlMcpServer(options: ControlMcpOptions = {}): McpServer {
  const api = new ControlApiClient(options);
  const server = new McpServer({
    name: "argus-seoul-mesh",
    version: "0.2.0",
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

  server.registerTool("mesh_submit_job", {
    title: "Submit Mesh job",
    description: "经 Seoul 控制 API 提交 inspect 或 owner-configured named runner 任务。",
    inputSchema: SubmitJobInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
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

  return server;
}

export async function startControlMcpServer(options: ControlMcpOptions = {}): Promise<void> {
  const server = createControlMcpServer(options);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 2 * 1024 * 1024,
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

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function summarizeOverview(value: unknown): Record<string, unknown> {
  const overview = record(value);
  if (!overview) throw new GatewayError("控制 API 返回的设备摘要格式无效");
  const peers = array(overview.peers);
  const resources = array(overview.resources);
  const tasks = array(overview.tasks);
  const taskStatusCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const item of tasks) {
    const status = textField(record(item), "status", 64);
    if (status) taskStatusCounts[status] = (taskStatusCounts[status] ?? 0) + 1;
  }

  return {
    controllerNodeId: textField(overview, "controllerNodeId", 256),
    generatedAt: numberField(overview, "generatedAt"),
    counts: {
      peers: peers.length,
      onlinePeers: peers.filter((peer) => textField(record(peer), "status", 64) === "online").length,
      resources: resources.length,
      tasks: tasks.length,
    },
    peers: peers.slice(0, MAX_PEERS).map(summarizePeer),
    resources: resources.slice(0, MAX_RESOURCES).map(summarizeResource),
    taskStatusCounts,
    truncated: {
      peers: Math.max(0, peers.length - MAX_PEERS),
      resources: Math.max(0, resources.length - MAX_RESOURCES),
    },
  };
}

function summarizePeer(value: unknown): Record<string, unknown> {
  const peer = record(value);
  return {
    nodeId: textField(peer, "fingerprint", 256),
    deviceName: textField(peer, "deviceName", 256),
    platform: textField(peer, "platform", 128),
    status: textField(peer, "status", 64),
    lastSeen: numberField(peer, "lastSeen"),
    resourceCount: array(peer?.resources).length,
  };
}

function summarizeResource(value: unknown): Record<string, unknown> {
  const resource = record(value);
  const status = record(resource?.status);
  const gpu = record(status?.gpu);
  const devices = array(gpu?.devices);
  return {
    resourceId: textField(resource, "id", 256),
    nodeId: textField(resource, "nodeId", 256),
    deviceName: textField(resource, "deviceName", 256),
    kind: textField(resource, "kind", 64),
    displayName: textField(resource, "displayName", 256),
    capabilities: stringArray(resource?.capabilities, 32, 64),
    runnerIds: stringArray(resource?.runnerIds, 32, 256),
    statusRunnerId: textField(resource, "statusRunnerId", 256),
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
      },
    } : {}),
  };
}

function summarizeTask(value: unknown): Record<string, unknown> {
  const outer = record(value);
  const candidate = record(outer?.task) ?? record(outer?.job) ?? outer;
  if (!candidate) throw new GatewayError("控制 API 返回的任务格式无效");
  return {
    taskId: textField(candidate, "taskId", 256),
    groupId: textField(candidate, "groupId", 256),
    targetNodeId: textField(candidate, "targetNodeId", 256),
    resourceId: textField(candidate, "resourceId", 256),
    operation: textField(candidate, "operation", 64),
    status: textField(candidate, "status", 64),
    decision: textField(candidate, "decision", 64),
    message: textField(candidate, "message", 512),
    createdAt: numberField(candidate, "createdAt"),
    updatedAt: numberField(candidate, "updatedAt"),
    ...(Object.hasOwn(candidate, "result")
      ? { result: safeUnknown(candidate.result, 0) }
      : {}),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
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
      if (bytes > MAX_HTTP_RESPONSE_BYTES) {
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
  return typeof detail === "string" ? safeString(detail, 320) : "";
}

function safeGatewayError(error: unknown): string {
  const message = error instanceof GatewayError ? error.message : "MCP 网关请求失败";
  return safeString(message, MAX_ERROR_TEXT_CHARS);
}

function safeJsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return truncate(text, MAX_TOOL_TEXT_CHARS);
}

function safeUnknown(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safeString(value, MAX_TASK_RESULT_STRING_CHARS);
  if (depth >= MAX_TASK_RESULT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_TASK_RESULT_ITEMS).map((item) => safeUnknown(item, depth + 1));
    if (value.length > MAX_TASK_RESULT_ITEMS) output.push(`[${value.length - MAX_TASK_RESULT_ITEMS} more items]`);
    return output;
  }
  const input = record(value);
  if (!input) return safeString(String(value), 128);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(input).slice(0, MAX_TASK_RESULT_ITEMS);
  for (const [key, item] of entries) {
    const safeKey = safeString(key, 64);
    if (!safeKey || ["__proto__", "constructor", "prototype"].includes(safeKey)) continue;
    output[safeKey] = sensitiveKey(safeKey) ? "<redacted>" : safeUnknown(item, depth + 1);
  }
  if (Object.keys(input).length > MAX_TASK_RESULT_ITEMS) {
    output._truncatedKeys = Object.keys(input).length - MAX_TASK_RESULT_ITEMS;
  }
  return output;
}

function sensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[-_]/g, "");
  return compact === "header"
    || compact === "headers"
    || compact === "authorization"
    || compact === "proxyauthorization"
    || compact === "cookie"
    || compact === "setcookie"
    || compact === "apikey"
    || compact === "password"
    || compact === "secret"
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

function parseControlUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayError("ARGUS_CONTROL_URL 配置无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
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
  return Math.min(60_000, Math.max(1_000, Math.trunc(value)));
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
