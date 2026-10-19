import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync } from "node:crypto";
import { GatewayAuth } from "../src/gateway-auth";
import { BackendWebSocket, createGateway } from "../src/gateway";

const root = mkdtempSync(join(tmpdir(), "argus-gateway-test-"));
const file = join(root, "users.json"), password = "test-only-long-password";
const salt = Buffer.alloc(16, 7);
function verifier(value = password) {
  return JSON.stringify({ version: 1, kdf: "pbkdf2_sha256", users: { owner: { salt: salt.toString("hex"), hash: pbkdf2Sync(value, salt, 600000, 32, "sha256").toString("hex") } } });
}
writeFileSync(file, verifier());
const stops: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const base = "/r/" + "ab".repeat(20), origin = "https://argus.example";
function setup() {
  const received: { path: string; origin: string | null; host: string | null; cookie: string | null }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      received.push({ path, origin: request.headers.get("origin"), host: request.headers.get("host"), cookie: request.headers.get("cookie") });
      if (path === "/api/events" && server.upgrade(request)) return;
      if (path === "/api/session") return Response.json({ token: "native-token", platform: "win32" });
      return Response.json({ ok: true });
    },
    websocket: { open(ws) { ws.send(JSON.stringify({ type: "connection", connected: true })); }, message(ws, message) { ws.send(message); } },
  });
  const deviceOrigin = `http://127.0.0.1:${upstream.port}`;
  const gateway = createGateway({ origin, basePath: base, authFile: file, allowedUsers: ["owner"], port: 0, devices: [{ id: "windows", name: "Windows", upstream: deviceOrigin }] });
  stops.push(() => upstream.stop(true), () => gateway.stop());
  const fetchGateway = (path: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${gateway.server.port}${path}`, { ...options, redirect: "manual", headers: { Host: "argus.example", ...Object.fromEntries(new Headers(options.headers)) } });
  const login = () => fetchGateway("/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password }) });
  return { gateway, fetchGateway, login, received, deviceOrigin };
}

test("OJ password verification rejects wrong or unlisted accounts; expiry and verifier changes revoke sessions", async () => {
  let now = Date.now();
  const privateFile = join(root, "rotation.json"); writeFileSync(privateFile, verifier());
  const auth = new GatewayAuth(privateFile, () => now, 10000, ["owner"]);
  expect(await auth.login("owner", "wrong", "a")).toBeNull();
  expect(await new GatewayAuth(privateFile, () => now, 10000, ["another"]).login("owner", password, "a")).toBeNull();
  const first = (await auth.login("owner", password, "a"))!;
  expect(auth.resolve(first.token)?.username).toBe("owner");
  expect(auth.resolve(first.token + "x")).toBeNull();
  now += 11000; expect(auth.resolve(first.token)).toBeNull();
  const second = (await auth.login("owner", password, "a"))!;
  writeFileSync(privateFile, verifier("different-test-password")); now += 2100;
  expect(auth.resolve(second.token)).toBeNull();
  writeFileSync(privateFile, "{}"); now += 2100;
  expect(() => auth.resolve(second.token)).toThrow();
});

test("all device HTTP/WS endpoints need login; Host and cross-site requests fail before reaching devices", async () => {
  const { fetchGateway, received } = setup();
  for (const path of ["/api/session", `${base}/d/windows/`, `${base}/d/windows/api/session`, `${base}/d/windows/api/events`, `${base}/d/windows/app.js`]) expect((await fetchGateway(path)).status).toBe(401);
  expect((await fetchGateway("/login", { headers: { Host: "attacker.example" } })).status).toBe(403);
  expect((await fetchGateway("/login", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  expect(received).toHaveLength(0);
});

test("authenticated proxy rewrites native Origin, isolates cookies, and logout revokes HTTP and open WS", async () => {
  const { fetchGateway, login, received, deviceOrigin, gateway } = setup();
  const result = await login(); expect(result.status).toBe(200);
  const setCookie = result.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly; Secure; SameSite=Strict");
  const cookie = setCookie.split(";")[0];
  const response = await fetchGateway(`${base}/d/windows/api/session`, { headers: { Cookie: cookie } });
  const session = await response.json();
  expect(session).toMatchObject({ token: "native-token", gateway: { deviceId: "windows", devices: [{ id: "windows" }] } });
  expect(received.at(-1)).toMatchObject({ origin: deviceOrigin, host: deviceOrigin.slice(7), cookie: null });
  expect((await fetchGateway(`${base}/d/windows//attacker.example/api/session`, { headers: { Cookie: cookie } })).status).toBe(400);
  expect((await fetchGateway(`${base}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status).toBe(403);
  const ws = new BackendWebSocket(`ws://127.0.0.1:${gateway.server.port}${base}/d/windows/api/events`, { headers: { Host: "argus.example", Origin: origin, Cookie: cookie } });
  stops.push(() => ws.close());
  const firstMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS timeout")), 4000);
    ws.onmessage = event => { clearTimeout(timer); resolve(String(event.data)); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WS failed")); };
  });
  expect(JSON.parse(firstMessage).connected).toBe(true);
  const echo = new Promise<string>(resolve => { ws.onmessage = event => resolve(String(event.data)); });
  ws.send("ping"); expect(await echo).toBe("ping");
  const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); });
  expect((await fetchGateway(`${base}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "X-Argus-Session-Csrf": session.gateway.csrf } })).status).toBe(200);
  expect(await closed).toBe(1008);
  expect((await fetchGateway(`${base}/d/windows/api/session`, { headers: { Cookie: cookie } })).status).toBe(401);
});

test("login attempts are bounded even when attempted concurrently", async () => {
  const auth = new GatewayAuth(file);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => auth.login("owner", "wrong", "same-client")));
  expect(results.filter(result => result.status === "rejected")).toHaveLength(6);
  const successful = await auth.login("owner", password, "different-client");
  expect(successful).not.toBeNull();
});
