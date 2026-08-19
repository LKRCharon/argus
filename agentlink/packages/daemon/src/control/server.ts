import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MeshTaskRequestSchema,
  type MeshApproval,
  type MeshCapabilityGrant,
} from "@agentlink/wire";
import { MeshController, type ControllerOverview } from "./controller";
import { type ControlTaskJournal, type ControlTaskRecord } from "./journal";

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
}

export function createControlRequestHandler(options: ControlRequestHandlerOptions): (request: Request) => Promise<Response> {
  const distDir = resolve(options.distDir ?? process.env.ARGUS_CONTROL_DIST ?? "packages/app/dist");
  const controller = options.controller;

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "argus-mesh-control", ...controllerHealth(controller) });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url.pathname, controller);
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
  await controller.start();
  const host = options.host ?? process.env.ARGUS_CONTROL_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.ARGUS_CONTROL_PORT ?? 8790);
  const handler = createControlRequestHandler({ ...options, host, port, controller });
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handler,
  });
  console.log(`[control] Seoul Mesh Console: http://${host}:${server.port}`);
  return { stop: () => { controller.stop(); server.stop(true); }, port: server.port ?? port, host };
}

async function handleApi(request: Request, path: string, controller: ControlController): Promise<Response> {
  try {
    if (request.method === "GET" && path === "/api/overview") return json(controller.overview());
    if (request.method === "GET" && path === "/api/tasks") return json({ tasks: controller.journal.list(100) });
    if (request.method === "GET" && path === "/api/resources") return json({ resources: controller.overview().resources });
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
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
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
  const body = await request.json() as Record<string, unknown>;
  const operation = typeof body.operation === "string" ? body.operation : "";
  if (operation !== "inspect" && operation !== "run") {
    return json({ error: "控制台当前只开放 inspect 和 named runner run" }, 400);
  }
  const grant = body.grant as MeshCapabilityGrant | undefined;
  const approval = body.approval as MeshApproval | undefined;
  if (operation !== "inspect" && !grant) {
    return json({ error: "此操作需要目标资源所有者签发 grant" }, 400);
  }
  if (["run", "apply-patch", "quarantine"].includes(operation) && !approval) {
    return json({ error: "此操作需要目标资源所有者单独签发 approval" }, 400);
  }

  const targetNodeId = stringField(body, "targetNodeId");
  const resourceId = stringField(body, "resourceId");
  const groupId = stringField(body, "groupId");
  const task = MeshTaskRequestSchema.parse({
    groupId,
    taskId: typeof body.taskId === "string" && body.taskId.trim() ? body.taskId : `web-${randomUUID()}`,
    requesterNodeId: controller.nodeId,
    targetNodeId,
    resourceId,
    operation,
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
  });
  const record = await controller.submitTask(task, grant, approval);
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
