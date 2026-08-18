import { createRelayServer } from "./server";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.RELAY_HOST?.trim() || undefined;
const server = createRelayServer(port, hostname);

console.log(`[agentlink-relay] listening on ${hostname ?? "0.0.0.0"}:${server.port}  (ws path: /ws, health: /health)`);
