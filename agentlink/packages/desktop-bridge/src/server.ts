import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { DesktopBridge } from "./bridge";
import { Deliveries } from "./delivery";
import { responseHeaders, sameOrigin, validLocalHost, validToken } from "./security";
import { sendingDefaults } from "./permissions";
import { desktopDataRoot } from "./platform";

const port = Number(process.env.ARGUS_WEB_PORT ?? 18943);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid ARGUS_WEB_PORT");
const dataRoot = process.env.ARGUS_WEB_DATA ?? desktopDataRoot();
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const bridge = new DesktopBridge(new Deliveries(join(dataRoot, "delivery.sqlite")), process.env.ARGUS_DESKTOP_SOCKET);
const token = randomBytes(32).toString("hex");
interface Client { threadId?: string; release?: () => void; generation: number; closed: boolean }
const clients = new Set<ServerWebSocket<Client>>();
const webRoot = process.env.ARGUS_WEB_ASSETS ?? join(import.meta.dir, "../web");
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let release: Record<string, unknown> | null = null;
try { release = JSON.parse(readFileSync(join(import.meta.dir, "../../../release.json"), "utf8")); } catch { /* A source checkout has no installation manifest. */ }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: responseHeaders });
function threadId(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new Error("Invalid thread ID");
  return value;
}

const server = Bun.serve<Client>({
  hostname: "127.0.0.1", port, maxRequestBodySize: 128 * 1024,
  async fetch(request, server) {
    if (!validLocalHost(request.headers.get("host"), port)) return json({ error: "Loopback host required" }, 403);
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/events") {
        if (!sameOrigin(request)) return json({ error: "Same origin required" }, 403);
        if (server.upgrade(request, { data: { generation: 0, closed: false } })) return undefined;
        return json({ error: "WebSocket upgrade required" }, 400);
      }
      if (request.method === "POST") {
        if (!sameOrigin(request) || !validToken(request.headers.get("x-argus-token"), token)) return json({ error: "Request verification failed" }, 403);
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
        const body = await request.json() as Record<string, any>;
        if (path === "/api/new") {
          if (typeof body.clientCreationId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.clientCreationId)) throw new Error("Invalid creation ID");
          if (typeof body.title !== "string" || body.title.length > 32000) throw new Error("Invalid title");
          return json({ creation: await bridge.create(threadId(body.projectId), body.clientCreationId, body.title) });
        }
        if (path === "/api/select") { await bridge.select(threadId(body.threadId)); return json({ ok: true }); }
        if (path === "/api/input") {
          const id = body.clientMessageId;
          if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error("Invalid message ID");
          if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 32000) throw new Error("消息不能为空，最多 32000 字符");
          if (body.mode !== "send" && body.mode !== "steer") throw new Error("Invalid input mode");
          return json({ delivery: await bridge.send(threadId(body.threadId), body.text, id, body.mode) });
        }
        if (path === "/api/interrupt") {
          return json({ result: await bridge.interrupt(threadId(body.threadId), threadId(body.turnId)) });
        }
        if (path === "/api/approval") {
          if (typeof body.method !== "string" || body.method.length > 200 || body.decision == null) throw new Error("Invalid approval decision");
          if (typeof body.requestId !== "number" && typeof body.requestId !== "string") throw new Error("Invalid request ID");
          return json({ result: await bridge.approval(threadId(body.threadId), body.requestId, body.method, body.decision) });
        }
        return json({ error: "Not found" }, 404);
      }
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      if (path === "/api/session") return json({ token, version: "0.2.0", transport: "desktop-ipc", platform: process.platform, sendingDefaults });
      if (path === "/api/status") return json({ service: "argus-desktop-web", version: "0.2.0", platform: process.platform, desktopConnected: bridge.ipc.connected, release, sendingDefaults });
      if (path === "/api/projects") return json(await bridge.projects());
      if (path === "/api/threads") return json(await bridge.list(url.searchParams.get("cursor"), url.searchParams.has("projectId") ? threadId(url.searchParams.get("projectId")) : null));
      if (path === "/api/history") return json(await bridge.history(threadId(url.searchParams.get("threadId")), url.searchParams.get("cursor")));
      if (path === "/api/settings") return json({ settings: await bridge.settings(threadId(url.searchParams.get("threadId"))) });
      if (path.startsWith("/api/delivery/")) {
        const delivery = bridge.deliveries.get(decodeURIComponent(path.slice("/api/delivery/".length)));
        return delivery ? json({ delivery }) : json({ error: "Message ID not received" }, 404);
      }
      if (path.startsWith("/api/creation/")) {
        const creation = bridge.deliveries.creation(decodeURIComponent(path.slice("/api/creation/".length)));
        return creation ? json({ creation }) : json({ error: "Creation ID not received" }, 404);
      }
      const assets: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
      if (assets[path]) {
        const file = Bun.file(join(webRoot, assets[path]));
        if (await file.exists()) return new Response(file, { headers: responseHeaders });
        return json({ error: "Run bun run desktop:build first" }, 503);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  },
  websocket: {
    open(socket) { clients.add(socket); socket.send(JSON.stringify({ type: "connection", connected: bridge.ipc.connected })); },
    async message(socket, raw) {
      let generation: number | undefined;
      try {
        if (Buffer.byteLength(raw) > 4096) throw new Error("Subscription too large");
        const message = JSON.parse(raw.toString());
        if (message.type === "ping") { socket.send(JSON.stringify({ type: "pong" })); return; }
        if (message.type !== "subscribe" || !validToken(message.token, token)) throw new Error("Invalid subscription");
        const id = threadId(message.threadId);
        if (socket.data.threadId === id && socket.data.release) return;
        generation = ++socket.data.generation;
        socket.data.release?.(); socket.data.release = undefined;
        socket.data.threadId = id;
        const release = await bridge.subscribe(id);
        if (socket.data.closed || socket.data.generation !== generation) { release(); return; }
        socket.data.release = release;
        const snapshot = bridge.snapshot(id);
        if (snapshot) socket.send(JSON.stringify(snapshot));
      } catch (error) {
        if (generation !== undefined && generation === socket.data.generation) socket.data.threadId = undefined;
        if (!socket.data.closed) socket.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
      }
    },
    close(socket) { clients.delete(socket); socket.data.closed = true; socket.data.release?.(); socket.data.release = undefined; },
    idleTimeout: 65, sendPings: true, maxPayloadLength: 4096,
  },
});

bridge.on("event", event => {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (event.threadId && client.data.threadId !== event.threadId) continue;
    if (client.getBufferedAmount() > 2 * 1024 * 1024) { client.close(1013, "Reconnect to refresh thread"); continue; }
    client.send(message);
  }
});
void bridge.ipc.ready().catch(() => {});
console.log(`Argus Desktop Web listening on http://127.0.0.1:${server.port}`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  for (const client of clients) client.close();
  server.stop(true); await bridge.close(); process.exit(0);
}
process.once("SIGINT", close); process.once("SIGTERM", close);
