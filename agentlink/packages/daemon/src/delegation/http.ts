import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ZodError } from "zod";
import { DelegationAuthorizationError } from "./auth";
import { DelegationIdempotencyConflictError } from "./journal";
import {
  DelegationService,
  DelegationServiceError,
  publicJobView,
} from "./service";

const MAX_PUBLIC_BODY_BYTES = 32 * 1024;
const MAX_OWNER_BODY_BYTES = 16 * 1024;

export interface DelegationHttpOptions {
  host?: string;
  port?: number;
  distDir?: string;
}

export interface DelegationRequestHandlerOptions extends DelegationHttpOptions {
  service: DelegationService;
}

export function createDelegationRequestHandler(
  options: DelegationRequestHandlerOptions,
): (request: Request) => Promise<Response> {
  const service = options.service;
  const distDir = resolve(options.distDir
    ?? process.env.ARGUS_DELEGATION_DIST
    ?? process.env.ARGUS_CONTROL_DIST
    ?? "packages/app/dist");

  return async (request) => {
    const url = new URL(request.url);
    const publicRequest = url.pathname.startsWith("/d/");
    try {
      if (url.pathname === "/health") {
        const overview = service.overview();
        return secureJson({
          ok: true,
          service: "argus-marksec-delegation",
          enabled: overview.enabled,
          runnerReady: overview.runnerReady,
          queued: overview.jobs.filter((job) => job.status === "queued").length,
          running: overview.jobs.filter((job) => job.status === "running").length,
        });
      }
      if (publicRequest) return await handlePublic(request, url.pathname, service);
      if (url.pathname.startsWith("/api/delegation/")) {
        return await handleOwnerApi(request, url, service);
      }
      if (url.pathname.startsWith("/api/")) return notFound();
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
      return serveFrontend(request, url.pathname, distDir);
    } catch (error) {
      return errorResponse(error, publicRequest);
    }
  };
}

export function startDelegationServer(
  service: DelegationService,
  options: DelegationHttpOptions = {},
): { stop: () => void; port: number; host: string } {
  service.start();
  const host = options.host ?? process.env.ARGUS_DELEGATION_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.ARGUS_DELEGATION_PORT ?? 8792);
  const handler = createDelegationRequestHandler({ ...options, host, port, service });
  const server = Bun.serve({ hostname: host, port, idleTimeout: 45, fetch: handler });
  console.log(`[delegation] MarkSec owner console: http://${host}:${server.port}/delegate`);
  return {
    stop: () => {
      service.stop();
      server.stop(true);
    },
    port: server.port ?? port,
    host,
  };
}

async function handlePublic(
  request: Request,
  path: string,
  service: DelegationService,
): Promise<Response> {
  if (!service.isEnabled()) return notFound();
  const jobsPath = `${service.publicPath}/jobs`;
  const principal = service.authenticate(request.headers.get("authorization"));
  if (!principal) return notFound();

  if (request.method === "POST" && path === jobsPath) {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new DelegationServiceError("缺少 Idempotency-Key", 400);
    const body = await readJsonBody(request, MAX_PUBLIC_BODY_BYTES);
    const result = service.submit(principal, idempotencyKey, body);
    return secureJson({
      job: publicJobView(result.record),
      replayed: !result.created,
    }, result.created ? 202 : 200);
  }

  if (!path.startsWith(`${jobsPath}/`)) return notFound();
  const suffix = path.slice(jobsPath.length + 1);
  if (!suffix || suffix.includes("%2f") || suffix.includes("%2F")) return notFound();
  if (request.method === "GET" && suffix.endsWith("/patch")) {
    const encodedJobId = suffix.slice(0, -"/patch".length);
    if (!encodedJobId || encodedJobId.includes("/")) return notFound();
    const jobId = decodePathSegment(encodedJobId);
    const patch = service.readPatchForPrincipal(principal, jobId);
    return new Response(Uint8Array.from(patch.bytes), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${jobId}.patch"`,
        "content-type": "text/x-diff; charset=utf-8",
        digest: `sha-256=${Buffer.from(patch.sha256, "hex").toString("base64")}`,
        etag: `"${patch.sha256}"`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && !suffix.includes("/")) {
    const record = service.getForPrincipal(principal, decodePathSegment(suffix));
    return record ? secureJson({ job: publicJobView(record) }) : notFound();
  }
  if (request.method === "POST" && suffix.endsWith("/cancel")) {
    ensureEmptyBody(request);
    const encodedJobId = suffix.slice(0, -"/cancel".length);
    if (!encodedJobId || encodedJobId.includes("/")) return notFound();
    const record = service.cancelForPrincipal(principal, decodePathSegment(encodedJobId));
    return secureJson({ job: publicJobView(record) }, 202);
  }
  return notFound();
}

async function handleOwnerApi(
  request: Request,
  url: URL,
  service: DelegationService,
): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/delegation/overview") {
    return secureJson(service.overview());
  }
  assertOwnerMutation(request, url);

  if (request.method === "POST" && path === "/api/delegation/tokens") {
    return secureJson(service.createToken(await readJsonBody(request, MAX_OWNER_BODY_BYTES)), 201);
  }
  const revoke = /^\/api\/delegation\/tokens\/([^/]+)\/revoke$/.exec(path);
  if (request.method === "POST" && revoke) {
    ensureEmptyBody(request);
    return secureJson({ principal: service.revokeToken(decodePathSegment(revoke[1]!)) });
  }
  const action = /^\/api\/delegation\/jobs\/([^/]+)\/(cancel|approve|deny)$/.exec(path);
  if (request.method === "POST" && action) {
    ensureEmptyBody(request);
    const jobId = decodePathSegment(action[1]!);
    const record = action[2] === "cancel"
      ? service.cancelAsOwner(jobId)
      : action[2] === "deny"
        ? service.denyAsOwner(jobId)
        : service.approveAsOwner(jobId);
    return secureJson({ job: ownerJob(record) }, 202);
  }
  return notFound();
}

function ownerJob(record: Parameters<typeof publicJobView>[0]): Record<string, unknown> {
  return { ...publicJobView(record), principalId: record.principalId };
}

function assertOwnerMutation(request: Request, url: URL): void {
  if (request.method !== "POST") throw new DelegationServiceError("method not allowed", 405);
  if (request.headers.get("x-argus-owner") !== "1") {
    throw new DelegationServiceError("缺少本地所有者请求标记", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new DelegationServiceError("拒绝跨站所有者操作", 403);
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new DelegationServiceError("Origin 无效", 403);
    }
    if (parsed.origin !== url.origin) throw new DelegationServiceError("拒绝跨源所有者操作", 403);
  }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new DelegationServiceError("Content-Type 必须是 application/json", 415);
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new DelegationServiceError("请求体过大", 413);
  }
  if (!request.body) throw new DelegationServiceError("请求体不能为空", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DelegationServiceError("请求体过大", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DelegationServiceError("请求体不是有效 UTF-8", 400);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DelegationServiceError("请求体不是有效 JSON", 400);
  }
}

function ensureEmptyBody(request: Request): void {
  const length = request.headers.get("content-length");
  if (request.body || (length && length !== "0")) {
    throw new DelegationServiceError("该操作不接受请求体", 400);
  }
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/") || decoded.includes("\\")) throw new Error("unsafe segment");
    return decoded;
  } catch {
    throw new DelegationServiceError("路径无效", 404);
  }
}

function errorResponse(error: unknown, publicRequest: boolean): Response {
  if (error instanceof DelegationServiceError) {
    const response = secureJson({ error: publicRequest ? publicError(error.status) : error.message }, error.status);
    if (error.retryAfterSeconds) response.headers.set("retry-after", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof DelegationIdempotencyConflictError) {
    return secureJson({ error: publicRequest ? "Idempotency-Key 已用于不同请求" : error.message }, 409);
  }
  if (error instanceof DelegationAuthorizationError) {
    return secureJson({ error: publicRequest ? "请求超出令牌授权范围" : error.message }, 403);
  }
  if (error instanceof ZodError) return secureJson({ error: "请求格式无效" }, 400);
  return secureJson({ error: publicRequest ? "委托请求失败" : "委托服务内部错误" }, 500);
}

function publicError(status: number): string {
  if (status === 429) return "请求过于频繁";
  if (status === 503) return "执行器暂不可用";
  if (status === 404) return "not found";
  return "请求格式无效";
}

function secureJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function methodNotAllowed(): Response {
  return new Response("method not allowed", {
    status: 405,
    headers: { allow: "GET, HEAD", "cache-control": "no-store" },
  });
}

async function serveFrontend(request: Request, pathname: string, distDir: string): Promise<Response> {
  if (!existsSync(distDir)) return new Response("delegation console not built", { status: 503 });
  const relative = pathname === "/" || !pathname.includes(".") ? "index.html" : pathname.slice(1);
  const root = distDir.endsWith(sep) ? distDir : `${distDir}${sep}`;
  const filePath = resolve(distDir, relative);
  if (filePath !== distDir && !filePath.startsWith(root)) return notFound();
  if (!existsSync(filePath)) return notFound();
  const file = Bun.file(filePath);
  return new Response(request.method === "HEAD" ? undefined : file, {
    headers: {
      "content-type": contentType(filePath),
      "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
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
