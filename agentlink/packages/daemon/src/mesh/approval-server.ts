import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { MeshApprovalInbox } from "./approval-inbox";
import {
  HttpRequestError,
  assertLoopbackHostname,
  hasJsonContentType,
  isLoopbackRequest,
  isSameOriginRequest,
  readBoundedJson,
} from "../control/http-security";

const MAX_APPROVAL_REQUEST_BYTES = 16 * 1024;

export type HostApprovalDecision = "allow-once" | "deny";

export interface HostApprovalRequestHandlerOptions {
  nodeId: string;
  inbox: MeshApprovalInbox;
  onDecision: (taskId: string, decision: HostApprovalDecision) => void | Promise<void>;
  distDir?: string;
}

export interface HostApprovalServerOptions extends HostApprovalRequestHandlerOptions {
  host?: string;
  port?: number;
}

export function createHostApprovalRequestHandler(
  options: HostApprovalRequestHandlerOptions,
): (request: Request) => Promise<Response> {
  const distDir = resolve(options.distDir ?? process.env.ARGUS_HOST_APPROVAL_DIST ?? "packages/app/dist");

  return async (request) => {
    if (!isLoopbackRequest(request)) return json({ error: "loopback host required" }, 403);
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "argus-host-approval", nodeId: options.nodeId });
    }
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      return json({ nodeId: options.nodeId, approvals: options.inbox.listPending() });
    }

    const taskId = decisionPathId(url.pathname);
    if (request.method === "POST" && taskId) {
      if (!isSameOriginRequest(request)) return json({ error: "cross-origin decision rejected" }, 403);
      if (!hasJsonContentType(request)) {
        return json({ error: "content-type must be application/json" }, 415);
      }
      let body: { decision?: unknown };
      try {
        const value = await readBoundedJson(request, MAX_APPROVAL_REQUEST_BYTES);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new HttpRequestError("request body must be a JSON object", 400);
        }
        body = value as { decision?: unknown };
      } catch (error) {
        const status = error instanceof HttpRequestError ? error.status : 400;
        return json({ error: error instanceof Error ? error.message : "invalid request body" }, status);
      }
      if (body.decision !== "allow-once" && body.decision !== "deny") {
        return json({ error: "decision must be allow-once or deny" }, 400);
      }
      try {
        await options.onDecision(taskId, body.decision);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "approval decision failed" }, 409);
      }
      return json({ taskId, decision: body.decision, accepted: true }, 202);
    }

    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    return serveFrontend(request, url.pathname, distDir);
  };
}

export function startHostApprovalServer(options: HostApprovalServerOptions): {
  stop: () => void;
  host: string;
  port: number;
} {
  const host = options.host ?? process.env.ARGUS_HOST_APPROVAL_HOST ?? "127.0.0.1";
  assertLoopbackHostname(host, "Host approval server");
  const port = options.port ?? Number(process.env.ARGUS_HOST_APPROVAL_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Host approval port is invalid");
  const handler = createHostApprovalRequestHandler(options);
  const server = Bun.serve({ hostname: host, port, fetch: handler });
  console.log(`[mesh] 目标机审批页: http://${host}:${server.port}/host`);
  return { stop: () => server.stop(true), host, port: server.port ?? port };
}

function decisionPathId(path: string): string | undefined {
  const match = /^\/api\/approvals\/([^/]+)\/decision$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function serveFrontend(request: Request, pathname: string, distDir: string): Promise<Response> {
  if (!existsSync(distDir)) return new Response("审批前端尚未构建", { status: 503 });
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
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
