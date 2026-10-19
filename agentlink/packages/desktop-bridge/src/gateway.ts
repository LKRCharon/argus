import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { GatewayAuth, type GatewaySession } from "./gateway-auth";
import { responseHeaders, validToken } from "./security";

export interface GatewayDevice { id: string; name: string; upstream: string }
export interface GatewayOptions {
  origin: string; basePath: string; authFile: string; devices: GatewayDevice[];
  allowedUsers: string[]; port?: number; assets?: string; auth?: GatewayAuth;
}
// This package also typechecks browser sources with lib.dom. The Bun backend
// supports handshake headers in its WebSocket constructor; browsers do not.
export const BackendWebSocket = WebSocket as unknown as { new(url: string, options: import("bun").WebSocketOptions): WebSocket };
interface Client {
  sessionId: string; upstream: WebSocket; socket?: ServerWebSocket<Client>;
  queue: string[]; input: (string | Buffer)[]; bytes: number; closed: boolean; connectTimer?: ReturnType<typeof setTimeout>;
}
const COOKIE = "__Host-argus_session";
const cookie = (request: Request) => request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? null;
const MAX_BUFFER = 2 * 1024 * 1024;

export function createGateway(options: GatewayOptions) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.protocol !== "https:") throw new Error("Gateway requires an exact HTTPS origin");
  if (!/^\/r\/[a-f0-9]{40,64}$/.test(options.basePath)) throw new Error("Use a random basePath with at least 160 bits");
  if (!options.devices.length || options.devices.length > 16) throw new Error("Configure 1 to 16 trusted devices");
  const devices = new Map<string, GatewayDevice>();
  for (const device of options.devices) {
    const upstream = new URL(device.upstream);
    if (!/^[a-z0-9-]{1,40}$/.test(device.id) || devices.has(device.id) || typeof device.name !== "string" || device.name.length > 100 || upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("Device upstream must be a fixed loopback HTTP origin");
    devices.set(device.id, { ...device, upstream: upstream.origin });
  }
  if (!Array.isArray(options.allowedUsers) || !options.allowedUsers.length || options.allowedUsers.some(user => typeof user !== "string" || !user || user.length > 64)) throw new Error("Configure the OJ accounts allowed to control devices");
  const auth = options.auth ?? new GatewayAuth(options.authFile, Date.now, 12 * 60 * 60 * 1000, options.allowedUsers);
  const assets = options.assets ?? join(import.meta.dir, "../gateway-web");
  const clients = new Set<ServerWebSocket<Client>>();
  const headers = { ...responseHeaders, "Strict-Transport-Security": "max-age=31536000", "X-Frame-Options": "DENY" };
  const json = (value: unknown, status = 200, extra = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
  const firstRoute = `${options.basePath}/d/${options.devices[0].id}/`;
  const sameOrigin = (request: Request) => request.headers.get("origin") === options.origin && request.headers.get("sec-fetch-site") !== "cross-site";
  const closeClient = (client: Client, code = 1013, reason = "Reconnect to refresh") => {
    if (client.closed) return;
    client.closed = true; client.queue = []; client.input = []; client.bytes = 0; clearTimeout(client.connectTimer);
    client.upstream.close(code, reason); client.socket?.close(code, reason);
  };
  const publicSession = (session: GatewaySession, device: GatewayDevice) => ({
    deviceId: device.id, devices: [...devices.values()].map(d => ({ id: d.id, name: d.name, url: `${options.basePath}/d/${d.id}/` })),
    logoutUrl: `${options.basePath}/api/logout`, csrf: session.csrf,
  });
  let activeRequests = 0;
  const server = Bun.serve<Client>({
    hostname: "127.0.0.1", port: options.port ?? 18945, maxRequestBodySize: 128 * 1024,
    async fetch(request, server) {
      // Nginx preserves the public Host and overwrites the client IP header.
      if (request.headers.get("host") !== origin.host) return json({ error: "Host rejected" }, 403);
      const url = new URL(request.url), path = url.pathname;
      if (request.headers.has("origin") && !sameOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Origin rejected" }, 403);
      try {
        if (request.method === "GET" && ["/login.js", "/login.css"].includes(path)) return new Response(Bun.file(join(assets, path.slice(1))), { headers });
        if (path === "/login" && request.method === "POST") {
          if (!sameOrigin(request)) return json({ error: "Origin rejected" }, 403);
          if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
          const body = await request.json();
          if (typeof body?.username !== "string" || !body.username || body.username.length > 64 || typeof body.password !== "string" || !body.password || body.password.length > 256) return json({ error: "请输入 OJ 账号和密码" }, 400);
          const previous = auth.resolve(cookie(request));
          const login = await auth.login(body.username, body.password, request.headers.get("x-real-ip") ?? "local");
          if (!login) return json({ error: "账号或密码不正确" }, 401);
          if (previous) { auth.revoke(previous.id); for (const socket of clients) if (socket.data.sessionId === previous.id) closeClient(socket.data, 1008, "Session replaced"); }
          return json({ next: firstRoute }, 200, { "Set-Cookie": `${COOKIE}=${login.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` });
        }
        const session = auth.resolve(cookie(request));
        if ((path === "/" || path === "/login") && request.method === "GET") {
          if (session) return new Response(null, { status: 303, headers: { ...headers, Location: firstRoute } });
          return new Response(Bun.file(join(assets, "login.html")), { headers });
        }
        if (!session) return json({ error: "请先登录", login: "/login" }, 401);
        if (path === `${options.basePath}/api/logout` && request.method === "POST") {
          if (!sameOrigin(request) || !validToken(request.headers.get("x-argus-session-csrf"), session.csrf)) return json({ error: "Request rejected" }, 403);
          auth.revoke(session.id);
          for (const socket of clients) if (socket.data.sessionId === session.id) closeClient(socket.data, 1008, "Logged out");
          return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
        }
        const prefix = `${options.basePath}/d/`;
        if (!path.startsWith(prefix)) return json({ error: "Not found" }, 404);
        const rest = path.slice(prefix.length), slash = rest.indexOf("/");
        if (slash < 0) return json({ error: "Not found" }, 404);
        const device = devices.get(rest.slice(0, slash));
        if (!device) return json({ error: "Not found" }, 404);
        const upstream = new URL(rest.slice(slash) + url.search, device.upstream);
        // A leading // must never turn a user-controlled path into a host.
        if (upstream.origin !== device.upstream) return json({ error: "Invalid path" }, 400);
        if (upstream.pathname === "/api/events") {
          if (!sameOrigin(request) || request.method !== "GET") return json({ error: "Origin rejected" }, 403);
          if (clients.size >= 64) return json({ error: "Too many connections" }, 429);
          const peer = new BackendWebSocket(upstream.href.replace(/^http:/, "ws:"), { headers: { Origin: device.upstream } });
          const data: Client = { sessionId: session.id, upstream: peer, queue: [], input: [], bytes: 0, closed: false };
          peer.onmessage = event => {
            if (data.closed) return;
            const message = typeof event.data === "string" ? event.data : "";
            if (!message) { closeClient(data, 1008, "Text frames required"); return; }
            if (data.socket) {
              if (data.socket.getBufferedAmount() > MAX_BUFFER) closeClient(data);
              else data.socket.send(message);
            } else {
              data.bytes += Buffer.byteLength(message);
              if (data.bytes > MAX_BUFFER) closeClient(data);
              else data.queue.push(message);
            }
          };
          peer.onclose = () => closeClient(data, 1013, "Device disconnected");
          data.connectTimer = setTimeout(() => closeClient(data, 1013, "Device unavailable"), 5000);
          peer.onopen = () => {
            clearTimeout(data.connectTimer);
            try {
              if (!auth.resolveId(session.id)) { closeClient(data, 1008, "Session expired"); return; }
              for (const message of data.input) peer.send(message);
              data.input = [];
            } catch { closeClient(data, 1008, "Session unavailable"); }
          };
          peer.onerror = () => closeClient(data, 1013, "Device unavailable");
          if (server.upgrade(request, { data })) return undefined;
          closeClient(data); return json({ error: "WebSocket upgrade required" }, 400);
        }
        if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        if (request.method === "POST" && !sameOrigin(request)) return json({ error: "Origin rejected" }, 403);
        if (activeRequests >= 64) return json({ error: "Busy, retry later" }, 503);
        activeRequests++;
        try {
          const forwarded = new Headers();
          if (request.headers.get("content-type")) forwarded.set("content-type", request.headers.get("content-type")!);
          if (request.headers.get("x-argus-token")) forwarded.set("x-argus-token", request.headers.get("x-argus-token")!);
          forwarded.set("Origin", device.upstream);
          const response = await fetch(upstream, { method: request.method, headers: forwarded, body: request.method === "POST" ? await request.arrayBuffer() : undefined, redirect: "manual", signal: AbortSignal.timeout(45000) });
          // An expired session cannot return credentials or chat data after a slow read.
          if (!auth.resolveId(session.id)) { await response.body?.cancel(); return json({ error: "请重新登录" }, 401); }
          if (upstream.pathname === "/api/session" && response.ok) return json({ ...await response.json(), gateway: publicSession(session, device) });
          const resultHeaders = new Headers(headers);
          resultHeaders.set("Content-Type", response.headers.get("content-type") ?? "application/octet-stream");
          return new Response(response.body, { status: response.status, headers: resultHeaders });
        } catch { return json({ error: "设备暂时离线，请稍后重试" }, 502); }
        finally { activeRequests--; }
      } catch (error) {
        if (error instanceof Error && error.message === "LOGIN_RATE_LIMIT") return json({ error: "登录尝试过多，请稍后再试" }, 429, { "Retry-After": "900" });
        // Never put filesystem paths, verifier contents or proxy errors on the public wire.
        return json({ error: "请求暂时无法处理" }, 503);
      }
    },
    websocket: {
      open(socket) {
        const data = socket.data;
        data.socket = socket; clients.add(socket);
        if (data.closed) { socket.close(1013, "Device disconnected"); return; }
        for (const message of data.queue) socket.send(message);
        data.queue = []; data.bytes = 0;
      },
      message(socket, raw) {
        const data = socket.data;
        try {
          if (!auth.resolveId(data.sessionId)) { closeClient(data, 1008, "Session expired"); return; }
          if (data.upstream.readyState === WebSocket.CONNECTING) {
            if (data.input.length >= 16) closeClient(data);
            else data.input.push(typeof raw === "string" ? raw : Buffer.from(raw));
            return;
          }
          if (data.upstream.readyState !== WebSocket.OPEN || data.upstream.bufferedAmount > MAX_BUFFER) { closeClient(data); return; }
          data.upstream.send(raw);
        } catch { closeClient(data, 1008, "Session unavailable"); }
      },
      close(socket) {
        clients.delete(socket); closeClient(socket.data, 1000, "Browser disconnected");
        socket.data.socket = undefined;
        socket.data.upstream.onmessage = null;
      },
      maxPayloadLength: 4096, idleTimeout: 65, sendPings: true,
    },
  });
  const timer = setInterval(() => {
    for (const socket of clients) {
      try { if (!auth.resolveId(socket.data.sessionId)) closeClient(socket.data, 1008, "Session expired"); }
      catch { closeClient(socket.data, 1008, "Session unavailable"); }
    }
  }, 15000);
  return {
    server,
    async stop() {
      clearInterval(timer);
      for (const socket of clients) { closeClient(socket.data, 1001, "Gateway restarting"); socket.terminate(); }
      // Bun 1.3.14 can retain its pending-WebSocket counter after a server-
      // initiated close (also reproducible without this proxy). The listener
      // stops immediately; bound the drain promise so service restarts finish.
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 250);
        void server.stop(true).then(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

if (import.meta.main) {
  const config = process.env.ARGUS_GATEWAY_CONFIG;
  if (!config) throw new Error("Set ARGUS_GATEWAY_CONFIG to a private host-local JSON file");
  const gateway = createGateway(JSON.parse(readFileSync(config, "utf8")));
  console.log(`Argus authenticated gateway listening on 127.0.0.1:${gateway.server.port}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await gateway.stop(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
