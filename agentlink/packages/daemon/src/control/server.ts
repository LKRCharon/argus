import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MeshRunScopeSchema,
  MeshTaskRequestSchema,
} from "@agentlink/wire";
import { MeshController, type ControllerOverview } from "./controller";
import { type ControlTaskJournal, type ControlTaskRecord } from "./journal";
import {
  HttpRequestError,
  assertLoopbackHostname,
  hasJsonContentType,
  isLoopbackRequest,
  isSameOriginRequest,
  readBoundedJson,
} from "./http-security";

const MAX_CONTROL_REQUEST_BYTES = 2 * 1024 * 1024;
const ControlIdSchema = z.string().trim().min(1).max(256);
const CodexTextSchema = z.string().max(64 * 1024)
  .refine((value) => value.trim().length > 0, "text must not be blank");
const CodexTargetSchema = z.object({
  targetNodeId: ControlIdSchema,
}).strip();
const CodexThreadSchema = CodexTargetSchema.extend({
  sessionId: ControlIdSchema,
}).strip();
const CodexStartSchema = CodexTargetSchema.extend({
  text: CodexTextSchema,
  cwd: z.string().max(4_096).optional(),
}).strip();
const CodexInputSchema = CodexThreadSchema.extend({
  text: CodexTextSchema,
}).strip();
const CodexEventsSchema = CodexTargetSchema.extend({
  afterSeq: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
  sessionId: ControlIdSchema.optional(),
}).strip();
const CodexApprovalSchema = CodexTargetSchema.extend({
  requestId: ControlIdSchema,
  optionId: z.enum(["allow", "deny"]),
}).strip();

export interface ControlServerOptions {
  host?: string;
  port?: number;
  distDir?: string;
}

export interface ControlRequestHandlerOptions extends ControlServerOptions {
  controller: ControlController;
}

export interface ControlController {
  readonly nodeId: string;
  readonly journal: ControlTaskJournal;
  overview(): ControllerOverview;
  refreshResources(): Promise<void>;
  submitTask(task: Parameters<MeshController["submitTask"]>[0], grant?: Parameters<MeshController["submitTask"]>[1], approval?: Parameters<MeshController["submitTask"]>[2]): Promise<ControlTaskRecord>;
  cancelTask(taskId: string): Promise<ControlTaskRecord>;
  listCodexThreads(targetNodeId: string): Promise<Record<string, unknown>>;
  readCodexThread(targetNodeId: string, sessionId: string): Promise<Record<string, unknown>>;
  startCodexThread(targetNodeId: string, text: string, cwd?: string): Promise<Record<string, unknown>>;
  sendCodexInput(targetNodeId: string, sessionId: string, text: string): Promise<Record<string, unknown>>;
  interruptCodexThread(targetNodeId: string, sessionId: string): Promise<Record<string, unknown>>;
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
  const server = Bun.serve({
    hostname: host,
    port,
    // A manual refresh performs resource discovery followed by the optional
    // status probe. Each encrypted round trip has a 15 second deadline, so
    // Bun's 10 second default can close a healthy refresh before it completes.
    idleTimeout: 40,
    fetch: handler,
  });
  console.log(`[control] Seoul Mesh Console: http://${host}:${server.port}`);
  return { stop: () => { controller.stop(); server.stop(true); }, port: server.port ?? port, host };
}

async function handleApi(request: Request, url: URL, controller: ControlController): Promise<Response> {
  try {
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/overview") return json(controller.overview());
    if (request.method === "GET" && path === "/api/tasks") return json({ tasks: controller.journal.list(100) });
    if (request.method === "GET" && path === "/api/resources") return json({ resources: controller.overview().resources });
    if (request.method === "GET" && path === "/api/codex/threads") {
      const input = CodexTargetSchema.parse(Object.fromEntries(url.searchParams));
      return json(await controller.listCodexThreads(input.targetNodeId));
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
      return json(await controller.readCodexThread(input.targetNodeId, input.sessionId));
    }
    if (request.method === "POST" && path === "/api/codex/start") {
      const input = CodexStartSchema.parse(await readJsonRequest(request));
      return json(await controller.startCodexThread(input.targetNodeId, input.text, input.cwd), 202);
    }
    if (request.method === "POST" && path === "/api/codex/input") {
      const input = CodexInputSchema.parse(await readJsonRequest(request));
      return json(await controller.sendCodexInput(input.targetNodeId, input.sessionId, input.text), 202);
    }
    if (request.method === "POST" && path === "/api/codex/interrupt") {
      const input = CodexThreadSchema.parse(await readJsonRequest(request));
      return json(await controller.interruptCodexThread(input.targetNodeId, input.sessionId), 202);
    }
    if (request.method === "POST" && path === "/api/codex/approval") {
      const input = CodexApprovalSchema.parse(await readJsonRequest(request));
      return json(await controller.respondCodexApproval(
        input.targetNodeId,
        input.requestId,
        input.optionId,
      ), 202);
    }
    const taskId = taskPathId(path);
    if (request.method === "GET" && taskId) {
      const task = controller.journal.get(taskId);
      return task ? json(task) : json({ error: "未找到任务" }, 404);
    }
    const cancelTaskId = cancelTaskPathId(path);
    if (request.method === "POST" && cancelTaskId) {
      return json(await controller.cancelTask(cancelTaskId), 202);
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
  return match ? decodeURIComponent(match[1]) : undefined;
}

function cancelTaskPathId(path: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
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
  const groupId = stringField(body, "groupId");
  const scope = operation === "run" ? MeshRunScopeSchema.parse(body.scope) : undefined;
  const task = MeshTaskRequestSchema.parse({
    groupId,
    taskId: typeof body.taskId === "string" && body.taskId.trim() ? body.taskId : `web-${randomUUID()}`,
    requesterNodeId: controller.nodeId,
    targetNodeId,
    resourceId,
    operation,
    ...(scope ? { scope } : {}),
  });
  // The Seoul browser never handles owner grants or signing material. A run
  // arrives at the target as a proposal and waits for target-local approval.
  const record = await controller.submitTask(task);
  return json(record, 202);
}

function controllerHealth(controller: ControlController): Record<string, unknown> {
  const overview = controller.overview();
  return {
    controllerNodeId: overview.controllerNodeId,
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
