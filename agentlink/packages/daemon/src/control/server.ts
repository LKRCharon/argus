import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MeshBaseArtifactManifestSchema,
  MeshGroupIdSchema,
  MeshIdempotencyKeySchema,
  MeshNodeIdSchema,
  MeshOperationIdSchema,
  MeshRequestIdSchema,
  MeshResourceIdSchema,
  MeshRunScopeSchema,
  MeshTaskIdSchema,
  MeshTaskRequestSchema,
  MeshThreadIdSchema,
  stableStringify,
} from "@agentlink/wire";
import { MeshController, type ControllerOverview, type ControllerReadiness } from "./controller";
import { CodexGatewayError } from "./codex";
import { CodexOperationStatusSchema, type CodexOperationListQuery, type CodexOperationRecord } from "./codex-operations";
import { type ControlTaskJournal, type ControlTaskRecord } from "./journal";
import {
  HttpRequestError,
  assertLoopbackHostname,
  hasJsonContentType,
  isLoopbackRequest,
  isSameOriginRequest,
  readBoundedJson,
} from "./http-security";
import { validateBaseArtifactManifest } from "../mesh/artifact-store";

const MAX_CONTROL_REQUEST_BYTES = 12 * 1024 * 1024;
const CodexTextSchema = z.string().max(64 * 1024)
  .refine((value) => value.trim().length > 0, "text must not be blank");
const DeadlineMsSchema = z.coerce.number().int().min(1_000).max(2 * 60_000);
const CodexTargetSchema = z.object({
  targetNodeId: MeshNodeIdSchema,
  deadlineMs: DeadlineMsSchema.optional().default(30_000),
}).strip();
const CodexThreadSchema = CodexTargetSchema.extend({
  sessionId: MeshThreadIdSchema,
}).strip();
const CodexStartSchema = CodexTargetSchema.extend({
  text: CodexTextSchema,
  cwd: z.string().max(4_096).optional(),
  idempotencyKey: MeshIdempotencyKeySchema.optional(),
  deadlineMs: DeadlineMsSchema.optional().default(120_000),
}).strip();
const CodexInputSchema = CodexThreadSchema.extend({
  text: CodexTextSchema,
}).strip();
const CodexEventsSchema = CodexTargetSchema.extend({
  afterSeq: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
  sessionId: MeshThreadIdSchema.optional(),
}).strip();

const TaskListQuerySchema = z.object({
  targetNodeId: MeshNodeIdSchema.optional(),
  resourceId: MeshResourceIdSchema.optional(),
  groupId: MeshGroupIdSchema.optional(),
  status: z.enum(["queued", "running", "completed", "denied", "approval-required", "failed", "cancelled"]).optional(),
  createdAfter: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strip();
const CodexApprovalSchema = CodexTargetSchema.extend({
  requestId: MeshRequestIdSchema,
  optionId: z.enum(["allow", "deny"]),
}).strip();
const CodexOperationListSchema = z.object({
  targetNodeId: MeshNodeIdSchema.optional(),
  status: CodexOperationStatusSchema.optional(),
  createdAfter: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strip();

export interface ControlServerOptions {
  host?: string;
  port?: number;
  distDir?: string;
  serve?: (options: {
    hostname: string;
    port: number;
    idleTimeout: number;
    fetch: (request: Request) => Promise<Response>;
  }) => { port?: number; stop(closeActiveConnections?: boolean): void };
}

export interface ControlRequestHandlerOptions extends ControlServerOptions {
  controller: ControlController;
}

export interface ControlController {
  readonly nodeId: string;
  readonly journal: ControlTaskJournal;
  readiness?(): ControllerReadiness;
  overview(): ControllerOverview;
  refreshResources(): Promise<void>;
  submitTask(
    task: Parameters<MeshController["submitTask"]>[0],
    grant?: Parameters<MeshController["submitTask"]>[1],
    approval?: Parameters<MeshController["submitTask"]>[2],
    submission?: Parameters<MeshController["submitTask"]>[3],
  ): Promise<ControlTaskRecord>;
  cancelTask(taskId: string): Promise<ControlTaskRecord>;
  requestResultArtifact(taskId: string): ReturnType<MeshController["requestResultArtifact"]>;
  listCodexThreads(targetNodeId: string, deadlineMs?: number): Promise<Record<string, unknown>>;
  readCodexThread(targetNodeId: string, sessionId: string, deadlineMs?: number): Promise<Record<string, unknown>>;
  startCodexThreadOperation(targetNodeId: string, text: string, idempotencyKey: string, cwd?: string, deadlineMs?: number): CodexOperationRecord;
  getCodexOperation(operationId: string): CodexOperationRecord | undefined;
  listCodexOperations(query: CodexOperationListQuery): { operations: CodexOperationRecord[]; nextCursor?: string };
  sendCodexInput(targetNodeId: string, sessionId: string, text: string, deadlineMs?: number): Promise<Record<string, unknown>>;
  interruptCodexThread(targetNodeId: string, sessionId: string, deadlineMs?: number): Promise<Record<string, unknown>>;
  listCodexEvents(targetNodeId: string, afterSeq?: number, limit?: number, sessionId?: string): unknown;
  listCodexApprovals(targetNodeId?: string): unknown;
  respondCodexApproval(targetNodeId: string, requestId: string, optionId: "allow" | "deny"): Promise<Record<string, unknown>>;
}

export function createControlRequestHandler(options: ControlRequestHandlerOptions): (request: Request) => Promise<Response> {
  const distDir = resolve(options.distDir ?? process.env.ARGUS_CONTROL_DIST ?? "packages/app/dist");
  const controller = options.controller;

  return async (request) => {
    if (!isLoopbackRequest(request)) return json({ error: "loopback host required" }, 403);
    if (request.method !== "GET" && request.method !== "HEAD" && !isSameOriginRequest(request)) {
      return json({ error: "cross-origin request rejected" }, 403);
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "argus-mesh-control", ...controllerHealth(controller) });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, controller);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    return serveFrontend(request, url.pathname, distDir);
  };
}

export async function startControlServer(
  controller: MeshController,
  options: ControlServerOptions = {},
): Promise<{ stop: () => void; port: number; host: string }> {
  const host = options.host ?? process.env.ARGUS_CONTROL_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.ARGUS_CONTROL_PORT ?? 8790);
  assertLoopbackHostname(host, "Control server");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Control server port is invalid");
  await controller.start();
  const handler = createControlRequestHandler({ ...options, host, port, controller });
  const serveOptions = {
    hostname: host,
    port,
    // A manual refresh performs resource discovery followed by the optional
    // status probe. Each encrypted round trip has a 15 second deadline, so
    // Bun's 10 second default can close a healthy refresh before it completes.
    idleTimeout: 40,
    fetch: handler,
  };
  const server = options.serve ? options.serve(serveOptions) : Bun.serve(serveOptions);
  console.log(`[control] Seoul Mesh Console: http://${host}:${server.port}`);
  return { stop: () => { controller.stop(); server.stop(true); }, port: server.port ?? port, host };
}

async function handleApi(request: Request, url: URL, controller: ControlController): Promise<Response> {
  try {
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/overview") return json(controller.overview());
    if (request.method === "GET" && path === "/api/tasks") {
      const query = TaskListQuerySchema.parse(Object.fromEntries(url.searchParams));
      const page = controller.journal.listVisible(controller.nodeId, query);
      return json({
        jobs: page.tasks.map(jobView),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    if (request.method === "GET" && path === "/api/resources") return json({ resources: controller.overview().resources });
    if (request.method === "GET" && path === "/api/codex/threads") {
      const input = CodexTargetSchema.parse(Object.fromEntries(url.searchParams));
      return json(await controller.listCodexThreads(input.targetNodeId, input.deadlineMs));
    }
    if (request.method === "GET" && path === "/api/codex/operations") {
      const input = CodexOperationListSchema.parse(Object.fromEntries(url.searchParams));
      const page = controller.listCodexOperations(input);
      return json({
        operations: page.operations.map(codexOperationView),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    const operationId = codexOperationPathId(path);
    if (request.method === "GET" && operationId) {
      const operation = controller.getCodexOperation(operationId);
      return operation ? json(codexOperationView(operation)) : json({ error: "未找到 Codex operation" }, 404);
    }
    if (request.method === "GET" && path === "/api/codex/events") {
      const input = CodexEventsSchema.parse(Object.fromEntries(url.searchParams));
      return json(controller.listCodexEvents(
        input.targetNodeId,
        input.afterSeq,
        input.limit,
        input.sessionId,
      ));
    }
    if (request.method === "GET" && path === "/api/codex/approvals") {
      const input = CodexTargetSchema.partial().parse(Object.fromEntries(url.searchParams));
      return json({ approvals: controller.listCodexApprovals(input.targetNodeId) });
    }
    if (request.method === "POST" && path === "/api/codex/read") {
      const input = CodexThreadSchema.parse(await readJsonRequest(request));
      return json(await controller.readCodexThread(input.targetNodeId, input.sessionId, input.deadlineMs));
    }
    if (request.method === "POST" && path === "/api/codex/start") {
      const input = CodexStartSchema.parse(await readJsonRequest(request));
      const idempotencyKey = input.idempotencyKey ?? `codex-${randomUUID()}`;
      let operation;
      try {
        operation = controller.startCodexThreadOperation(
          input.targetNodeId,
          input.text,
          idempotencyKey,
          input.cwd,
          input.deadlineMs,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("idempotencyKey")) {
          throw new ControlApiError("IDEMPOTENCY_CONFLICT", "idempotencyKey 已绑定不同 Codex operation", 409);
        }
        throw error;
      }
      return json(codexOperationView(operation), 202);
    }
    if (request.method === "POST" && path === "/api/codex/input") {
      const input = CodexInputSchema.parse(await readJsonRequest(request));
      return json(await controller.sendCodexInput(
        input.targetNodeId,
        input.sessionId,
        input.text,
        input.deadlineMs,
      ), 202);
    }
    if (request.method === "POST" && path === "/api/codex/interrupt") {
      const input = CodexThreadSchema.parse(await readJsonRequest(request));
      return json(await controller.interruptCodexThread(
        input.targetNodeId,
        input.sessionId,
        input.deadlineMs,
      ), 202);
    }
    if (request.method === "POST" && path === "/api/codex/approval") {
      const input = CodexApprovalSchema.parse(await readJsonRequest(request));
      return json(await controller.respondCodexApproval(
        input.targetNodeId,
        input.requestId,
        input.optionId,
      ), 202);
    }
    const artifactTaskId = artifactTaskPathId(path);
    if (request.method === "GET" && artifactTaskId) {
      const record = controller.journal.get(artifactTaskId);
      if (!record || (record.requesterNodeId && record.requesterNodeId !== controller.nodeId)) {
        return json({ error: "未找到任务" }, 404);
      }
      const manifest = await controller.requestResultArtifact(artifactTaskId);
      return json({
        kind: "mesh-artifact",
        requestId: `artifact-http-${randomUUID()}`,
        targetNodeId: record.targetNodeId,
        taskId: artifactTaskId,
        manifest,
      });
    }
    const taskId = taskPathId(path);
    if (request.method === "GET" && taskId) {
      const task = controller.journal.get(taskId);
      return task && (!task.requesterNodeId || task.requesterNodeId === controller.nodeId)
        ? json(jobView(task))
        : json({ error: "未找到任务" }, 404);
    }
    const cancelTaskId = cancelTaskPathId(path);
    if (request.method === "POST" && cancelTaskId) {
      return json(submissionView(await controller.cancelTask(cancelTaskId)), 202);
    }
    if (request.method === "POST" && path === "/api/refresh") {
      await controller.refreshResources();
      return json(controller.overview());
    }
    if (request.method === "POST" && path === "/api/tasks") {
      return await createTask(request, controller);
    }
    return new Response("not found", { status: 404 });
  } catch (error) {
    if (error instanceof CodexGatewayError) {
      return json({
        error: {
          code: error.timedOut ? "CODEX_DEADLINE_EXCEEDED" : "CODEX_CONTROL_FAILED",
          message: error.message,
          timedOutStage: error.stage,
          retryable: error.retryable,
        },
      }, error.timedOut ? 504 : 503);
    }
    if (error instanceof ControlApiError) {
      return json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      }, error.status);
    }
    const status = error instanceof HttpRequestError ? error.status : 400;
    return json({ error: error instanceof Error ? error.message : String(error) }, status);
  }
}

async function readJsonRequest(request: Request): Promise<unknown> {
  if (!hasJsonContentType(request)) {
    throw new HttpRequestError("content-type must be application/json", 415);
  }
  return readBoundedJson(request, MAX_CONTROL_REQUEST_BYTES);
}

function taskPathId(path: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)$/.exec(path);
  return match ? MeshTaskIdSchema.parse(decodeURIComponent(match[1])) : undefined;
}

function cancelTaskPathId(path: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(path);
  return match ? MeshTaskIdSchema.parse(decodeURIComponent(match[1])) : undefined;
}

function artifactTaskPathId(path: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/artifact$/.exec(path);
  return match ? MeshTaskIdSchema.parse(decodeURIComponent(match[1])) : undefined;
}

function codexOperationPathId(path: string): string | undefined {
  const match = /^\/api\/codex\/operations\/([^/]+)$/.exec(path);
  return match ? MeshOperationIdSchema.parse(decodeURIComponent(match[1])) : undefined;
}

async function createTask(request: Request, controller: ControlController): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415);
  const value = await readBoundedJson(request, MAX_CONTROL_REQUEST_BYTES);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpRequestError("request body must be a JSON object", 400);
  }
  const body = value as Record<string, unknown>;
  const operation = typeof body.operation === "string" ? body.operation : "";
  if (operation !== "inspect" && operation !== "run") {
    return json({ error: "控制台当前只开放 inspect 和 named runner run" }, 400);
  }
  const targetNodeId = stringField(body, "targetNodeId");
  const resourceId = stringField(body, "resourceId");
  MeshNodeIdSchema.parse(targetNodeId);
  MeshResourceIdSchema.parse(resourceId);
  const resource = controller.overview().resources.find((item) => (
    item.nodeId === targetNodeId && item.id === resourceId
  ));
  if (!resource) throw new ControlApiError("RESOURCE_NOT_FOUND", "目标资源不存在", 404);
  const allowedOperations = resource.allowedOperations ?? resource.capabilities ?? [];
  if (!allowedOperations.includes(operation)) {
    throw new ControlApiError("OPERATION_NOT_ALLOWED", "资源不允许该操作", 403);
  }
  const groupId = resolveTaskGroup(body.groupId, resource.allowedGroupIds, resource.defaultGroupId);
  const idempotencyKey = MeshIdempotencyKeySchema.parse(
    typeof body.idempotencyKey === "string" ? body.idempotencyKey : `job-${randomUUID()}`,
  );
  let baseArtifact;
  if (body.baseArtifact !== undefined) {
    if (operation !== "run") throw new ControlApiError("ARTIFACT_REQUIRES_RUN", "base artifact 只允许用于 run", 400);
    try {
      baseArtifact = validateBaseArtifactManifest(MeshBaseArtifactManifestSchema.parse(body.baseArtifact)).manifest;
    } catch {
      throw new ControlApiError("INVALID_ARTIFACT", "base artifact manifest 无效", 400);
    }
  }
  const scope = operation === "run" ? MeshRunScopeSchema.parse(body.scope) : undefined;
  if (scope?.baseArtifactId !== baseArtifact?.artifactId
    && (scope?.baseArtifactId !== undefined || baseArtifact !== undefined)) {
    throw new ControlApiError("ARTIFACT_ID_MISMATCH", "scope.baseArtifactId 与 manifest 不匹配", 400);
  }
  const task = MeshTaskRequestSchema.parse({
    groupId,
    taskId: typeof body.taskId === "string" && body.taskId.trim()
      ? MeshTaskIdSchema.parse(body.taskId)
      : `web-${randomUUID()}`,
    requesterNodeId: controller.nodeId,
    targetNodeId,
    resourceId,
    operation,
    ...(scope ? { scope } : {}),
  });
  const idempotencyDigest = createHash("sha256").update(stableStringify({
    groupId,
    targetNodeId,
    resourceId,
    operation,
    scope,
    baseArtifact,
  }), "utf8").digest("hex");
  // The Seoul browser never handles owner grants or signing material. A run
  // arrives at the target as a proposal and waits for target-local approval.
  let record;
  try {
    record = await controller.submitTask(task, undefined, undefined, {
      idempotencyKey,
      idempotencyDigest,
      ...(baseArtifact ? { baseArtifact } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("idempotencyKey")) {
      throw new ControlApiError("IDEMPOTENCY_CONFLICT", "idempotencyKey 已绑定不同任务", 409);
    }
    throw error;
  }
  return json(submissionView(record), 202);
}

class ControlApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function resolveTaskGroup(
  value: unknown,
  allowedGroupIds: string[] | undefined,
  defaultGroupId: string | undefined,
): string {
  const allowed = allowedGroupIds ?? [];
  if (allowed.length === 0) {
    throw new ControlApiError(
      "GROUP_METADATA_UNAVAILABLE",
      "资源未发布 trusted group 元数据，无法安全派单",
      409,
    );
  }
  if (defaultGroupId && !allowed.includes(defaultGroupId)) {
    throw new ControlApiError(
      "GROUP_METADATA_INVALID",
      "资源的 defaultGroupId 不在 allowedGroupIds 中",
      409,
      { allowedGroupIds: allowed },
    );
  }
  if (typeof value === "string" && value.trim()) {
    const groupId = MeshGroupIdSchema.parse(value);
    if (allowed.length > 0 && !allowed.includes(groupId)) {
      throw new ControlApiError("GROUP_NOT_ALLOWED", "资源不允许该 trusted group", 403, {
        allowedGroupIds: allowed,
      });
    }
    return groupId;
  }
  const inferred = defaultGroupId ?? (allowed.length === 1 ? allowed[0] : undefined);
  if (!inferred) {
    throw new ControlApiError("GROUP_REQUIRED", "资源绑定多个 trusted group，必须明确 groupId", 400, {
      allowedGroupIds: allowed,
    });
  }
  return inferred;
}

function submissionView(record: ControlTaskRecord): Record<string, unknown> {
  return {
    ...jobView(record),
    idempotencyKey: record.idempotencyKey ?? null,
    pollAfterMs: ["completed", "denied", "failed", "cancelled"].includes(record.status) ? 0 : 1_000,
  };
}

function jobView(record: ControlTaskRecord): Record<string, unknown> {
  const result = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : undefined;
  const integrity = result?.integrity;
  const message = record.status === "queued"
    ? "任务已进入目标队列"
    : record.status === "running"
      ? "任务正在目标设备执行"
      : record.message;
  return {
    taskId: record.taskId,
    groupId: record.groupId,
    targetNodeId: record.targetNodeId,
    resourceId: record.resourceId,
    operation: record.operation,
    status: record.status,
    phase: record.status,
    approvalStatus: record.status === "approval-required"
      ? "pending"
      : record.status === "denied"
        ? "denied"
        : record.decision === "allow"
          ? "approved"
          : "not-required",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(message ? { message } : {}),
    ...(result && Object.hasOwn(result, "resultSummary")
      ? { resultSummary: result.resultSummary }
      : {}),
    ...(integrity !== undefined ? { integrity } : {}),
    ...(typeof result?.baseArtifactId === "string" ? { baseArtifactId: result.baseArtifactId } : {}),
    ...(typeof result?.resultArtifactId === "string" ? { resultArtifactId: result.resultArtifactId } : {}),
    ...(typeof result?.resultArtifactSha256 === "string"
      ? { resultArtifactSha256: result.resultArtifactSha256 }
      : {}),
  };
}

function codexOperationView(record: CodexOperationRecord): Record<string, unknown> {
  return {
    operationId: record.operationId,
    targetNodeId: record.targetNodeId,
    kind: record.kind,
    idempotencyKey: record.idempotencyKey,
    status: record.status,
    retryable: record.retryable,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadlineAt: record.deadlineAt,
    ...(record.sentAt !== undefined ? { sentAt: record.sentAt } : {}),
    ...(record.acknowledgedAt !== undefined ? { acknowledgedAt: record.acknowledgedAt } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.timedOutStage ? { timedOutStage: record.timedOutStage } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.message ? { message: record.message } : {}),
    pollAfterMs: ["completed", "failed", "timed_out"].includes(record.status) ? 0 : 1_000,
  };
}

function controllerHealth(controller: ControlController): Record<string, unknown> {
  const overview = controller.overview();
  const readiness = controller.readiness?.() ?? {
    state: "ready" as const,
    reconciliationInProgress: false,
    lastReconciliationStartedAt: null,
    lastReconciliationCompletedAt: null,
    lastReconciliationError: null,
  };
  return {
    controllerNodeId: overview.controllerNodeId,
    ready: readiness.state === "ready",
    readiness,
    peers: overview.peers.length,
    onlinePeers: overview.peers.filter((peer) => peer.status === "online").length,
    tasks: overview.tasks.length,
  };
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value;
}

async function serveFrontend(request: Request, pathname: string, distDir: string): Promise<Response> {
  if (!existsSync(distDir)) {
    return new Response("控制台前端尚未构建，请先运行 bun run build:app", { status: 503 });
  }
  const relative = pathname === "/" || !pathname.includes(".") ? "index.html" : pathname.slice(1);
  const root = distDir.endsWith(sep) ? distDir : `${distDir}${sep}`;
  const filePath = resolve(distDir, relative);
  if (filePath !== distDir && !filePath.startsWith(root)) return new Response("not found", { status: 404 });
  if (!existsSync(filePath)) return new Response("not found", { status: 404 });
  const file = Bun.file(filePath);
  return new Response(request.method === "HEAD" ? undefined : file, {
    headers: {
      "content-type": contentType(filePath),
      "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
