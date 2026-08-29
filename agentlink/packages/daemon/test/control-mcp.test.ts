import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createControlMcpServer,
  type ControlFetch,
} from "../src/control/mcp";

interface ConnectedMcp {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

async function connectMcp(fetchImpl: ControlFetch): Promise<ConnectedMcp> {
  const server = createControlMcpServer({
    controlUrl: "http://control.test",
    fetchImpl,
    requestTimeoutMs: 1_000,
  });
  const client = new Client({ name: "argus-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("expected MCP content array");
  const item = content[0];
  if (!item || typeof item !== "object") throw new Error("expected MCP content block");
  const block = item as { type?: unknown; text?: unknown };
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected MCP text content");
  }
  return block.text;
}

describe("Seoul Codex MCP gateway", () => {
  test("registers the four tools and returns a bounded device summary", async () => {
    let captured: Request | undefined;
    const fetchImpl: ControlFetch = async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        controllerNodeId: "node-seoul",
        relayUrl: "wss://relay.example/secret",
        generatedAt: 123,
        peers: [{
          fingerprint: "node-l40",
          deviceName: "L40",
          platform: "linux",
          status: "online",
          lastSeen: 120,
          resources: [{ id: "gpu:l40" }],
        }],
        resources: [{
          id: "gpu:l40",
          nodeId: "node-l40",
          deviceName: "L40",
          kind: "gpu",
          displayName: "L40 GPU",
          rootHint: "/private/gpu/path",
          runnerIds: ["gpu:run"],
          status: {
            state: "ready",
            summary: "1 GPU",
            observedAt: "2026-08-19T00:00:00.000Z",
            gpu: { devices: [{ index: 0, name: "L40", utilizationGpuPercent: 12 }] },
          },
        }],
        tasks: [{ status: "running", grant: "do-not-return" }],
      });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "mesh_cancel_job",
        "mesh_get_job",
        "mesh_list_devices",
        "mesh_submit_job",
      ]);
      const submitTool = tools.tools.find((tool) => tool.name === "mesh_submit_job");
      expect(submitTool?.inputSchema.properties).toHaveProperty("groupId");
      expect(submitTool?.inputSchema.properties).toHaveProperty("runnerId");

      const result = await mcp.client.callTool({ name: "mesh_list_devices", arguments: {} });
      const text = textContent(result);
      const summary = JSON.parse(text) as Record<string, unknown>;
      expect(captured?.method).toBe("GET");
      expect(captured ? new URL(captured.url).pathname : "").toBe("/api/overview");
      expect(captured?.headers.get("authorization")).toBeNull();
      expect(summary).toMatchObject({
        controllerNodeId: "node-seoul",
        counts: { peers: 1, onlinePeers: 1, resources: 1, tasks: 1 },
        taskStatusCounts: { running: 1 },
      });
      expect(text.length).toBeLessThanOrEqual(12_000);
      expect(text).not.toContain("relay.example");
      expect(text).not.toContain("/private/gpu/path");
      expect(text).not.toContain("do-not-return");
    } finally {
      await mcp.close();
    }
  });

  test("submits only the declared job fields and bounds task output", async () => {
    let captured: Request | undefined;
    const fetchImpl: ControlFetch = async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        taskId: "task-1",
        groupId: "group-alpha",
        targetNodeId: "node-l40",
        resourceId: "gpu:l40",
        operation: "run",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
        result: {
          stdout: "x".repeat(20_000),
          token: "super-secret-token",
          artifactUrl: "https://files.example/private",
        },
      }, { status: 202 });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_submit_job",
        arguments: {
          groupId: "group-alpha",
          targetNodeId: "node-l40",
          resourceId: "gpu:l40",
          operation: "run",
          runnerId: "gpu:run",
          args: ["--model", "small"],
          input: "payload",
          timeoutMs: 30_000,
        },
      });
      expect(captured?.method).toBe("POST");
      expect(captured ? new URL(captured.url).pathname : "").toBe("/api/tasks");
      expect(captured ? await captured.clone().json() : null).toEqual({
        groupId: "group-alpha",
        targetNodeId: "node-l40",
        resourceId: "gpu:l40",
        operation: "run",
        scope: {
          runnerId: "gpu:run",
          args: ["--model", "small"],
          input: "payload",
          timeoutMs: 30_000,
        },
      });
      const text = textContent(result);
      expect(text.length).toBeLessThanOrEqual(12_000);
      expect(text).not.toContain("super-secret-token");
      expect(text).not.toContain("files.example");
      expect(text).toContain("<redacted>");
    } finally {
      await mcp.close();
    }
  });

  test("refuses run without a named runner before calling the control API", async () => {
    let calls = 0;
    const fetchImpl: ControlFetch = async () => {
      calls += 1;
      return Response.json({ taskId: "unexpected" });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_submit_job",
        arguments: {
          groupId: "group-alpha",
          targetNodeId: "node-l40",
          resourceId: "gpu:l40",
          operation: "run",
        },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).toBe("run 操作必须指定 owner-configured runnerId");
      expect(calls).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  test("encodes task IDs for get and cancel without changing their methods", async () => {
    const captured: Request[] = [];
    const fetchImpl: ControlFetch = async (input, init) => {
      captured.push(new Request(input, init));
      return Response.json({ taskId: "task:a.b-1", status: "running" });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      await mcp.client.callTool({ name: "mesh_get_job", arguments: { taskId: "task:a.b-1" } });
      await mcp.client.callTool({ name: "mesh_cancel_job", arguments: { taskId: "task:a.b-1" } });
      expect(captured.map((request) => request.method)).toEqual(["GET", "POST"]);
      expect(captured.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/tasks/task%3Aa%2Eb-1",
        "/api/tasks/task%3Aa%2Eb-1/cancel",
      ]);
    } finally {
      await mcp.close();
    }
  });

  test("redacts API error details and never returns response blobs", async () => {
    let oversized = false;
    const fetchImpl: ControlFetch = async () => {
      if (oversized) return new Response("sensitive-blob-".repeat(6_000), { status: 500 });
      return Response.json({
        error: "Authorization: Bearer private-token failed at https://control.example/admin",
      }, { status: 403 });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const denied = await mcp.client.callTool({ name: "mesh_get_job", arguments: { taskId: "task-1" } });
      const deniedText = textContent(denied);
      expect(denied.isError).toBe(true);
      expect(deniedText.length).toBeLessThanOrEqual(512);
      expect(deniedText).not.toContain("private-token");
      expect(deniedText).not.toContain("control.example");

      oversized = true;
      const tooLarge = await mcp.client.callTool({ name: "mesh_list_devices", arguments: {} });
      const tooLargeText = textContent(tooLarge);
      expect(tooLarge.isError).toBe(true);
      expect(tooLargeText).toBe("控制 API 响应超过安全上限");
      expect(tooLargeText).not.toContain("sensitive-blob");
    } finally {
      await mcp.close();
    }
  });
});
