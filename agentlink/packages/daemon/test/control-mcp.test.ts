import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { meshArtifactSha256 } from "@agentlink/wire";
import {
  ControlApiClient,
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
    controlUrl: "http://127.0.0.1:8790",
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
  test("refuses a non-loopback control API", () => {
    expect(() => new ControlApiClient({ controlUrl: "https://control.example" })).toThrow();
  });

  test("registers Mesh and remote Codex tools and returns a bounded device summary", async () => {
    let captured: Request | undefined;
    const apiKeyInTypedIdArray = `sk-proj-${"s".repeat(24)}`;
    const fetchImpl: ControlFetch = async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        controllerNodeId: "node-seoul",
        generatedAt: 123,
        peers: [{
          fingerprint: "node-l40",
          deviceName: "L40",
          platform: "linux",
          status: "online",
          lastSeen: 120,
          resourceCount: 1,
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
        }, {
          id: "workspace:kmac-m4",
          nodeId: "node-kmac",
          deviceName: "KMac",
          kind: "directory",
          displayName: "KMac M4 workspace",
          rootHint: "/private/kmac/path",
          allowedOperations: ["inspect", "run"],
          allowedGroupIds: ["seoul-mac"],
          defaultGroupId: "seoul-mac",
          runnerIds: ["kmac-codex-v1", apiKeyInTypedIdArray],
          statusRunnerId: "kmac-status-v1",
          runners: [{
            runnerId: "kmac-status-v1",
            title: "KMac workspace status",
            purpose: "status",
            inputSchema: { type: "null" },
            resultSchema: { type: "object" },
            approvalRequired: false,
            maxRuntimeMs: 10_000,
            workspaceCapabilities: ["read-only-status"],
            executable: "/must/not/cross/the/gateway",
          }],
          status: {
            state: "ready",
            summary: "workspace ready",
            observedAt: "2026-08-19T00:00:00.000Z",
            workspace: {
              connectionStatus: "online",
              watcherAvailable: true,
              codexAppServerAvailable: true,
              remoteCodexControl: true,
              activeJobs: 0,
              workspaceRevision: "a".repeat(40),
              lastSuccess: "2026-08-19T00:00:00.000Z",
              lastErrorStage: null,
              checkedAt: "2026-08-19T00:00:00.000Z",
            },
            github: {
              status: "authenticated",
              login: "octocat",
              source: "keychain",
              checkedAt: "2026-08-19T00:00:00.000Z",
            },
          },
        }],
        totalPeerCount: 1,
        totalResourceCount: 2,
        onlinePeerCount: 1,
        taskCount: 1,
        taskStatusCounts: { running: 1 },
        truncated: { peers: 0, resources: 0 },
      });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "mesh_cancel_job",
        "mesh_get_job",
        "mesh_get_result_artifact",
        "mesh_list_devices",
        "mesh_list_jobs",
        "mesh_submit_job",
        "remote_codex_get_events",
        "remote_codex_get_operation",
        "remote_codex_interrupt",
        "remote_codex_list_approvals",
        "remote_codex_list_operations",
        "remote_codex_list_threads",
        "remote_codex_read_thread",
        "remote_codex_respond_approval",
        "remote_codex_send_message",
        "remote_codex_start_thread",
      ]);
      const submitTool = tools.tools.find((tool) => tool.name === "mesh_submit_job");
      expect(submitTool?.inputSchema.properties).toHaveProperty("groupId");
      expect(submitTool?.inputSchema.properties).toHaveProperty("runnerId");

      const result = await mcp.client.callTool({ name: "mesh_list_devices", arguments: {} });
      const text = textContent(result);
      const summary = JSON.parse(text) as Record<string, unknown>;
      expect(captured?.method).toBe("GET");
      expect(captured ? new URL(captured.url).pathname : "").toBe("/api/discovery");
      expect(captured?.headers.get("authorization")).toBeNull();
      expect(summary).toMatchObject({
        controllerNodeId: "node-seoul",
        counts: { peers: 1, onlinePeers: 1, resources: 2, tasks: 1 },
        taskStatusCounts: { running: 1 },
      });
      expect(summary).toMatchObject({
        resources: [{ resourceId: "gpu:l40" }, {
          resourceId: "workspace:kmac-m4",
          defaultGroupId: "seoul-mac",
          statusRunnerId: "kmac-status-v1",
          runners: [{
            runnerId: "kmac-status-v1",
            title: "KMac workspace status",
            purpose: "status",
            approvalRequired: false,
            maxRuntimeMs: 10_000,
            workspaceCapabilities: ["read-only-status"],
            inputSchema: { type: "null" },
            resultSchema: { type: "object" },
          }],
          status: {
            workspace: {
              connectionStatus: "online",
              watcherAvailable: true,
              codexAppServerAvailable: true,
              remoteCodexControl: true,
              activeJobs: 0,
              workspaceRevision: "a".repeat(40),
            },
            github: {
              status: "authenticated",
              login: "octocat",
              source: "keychain",
              checkedAt: "2026-08-19T00:00:00.000Z",
            },
          },
        }],
      });
      expect(text.length).toBeLessThanOrEqual(12_000);
      expect(text).not.toContain("relay.example");
      expect(text).not.toContain("/private/gpu/path");
      expect(text).not.toContain("do-not-return");
      expect(text).not.toContain("must/not/cross");
      expect(text).toContain(apiKeyInTypedIdArray);
    } finally {
      await mcp.close();
    }
  });

  test("keeps only a valid safe GitHub status in the discovery summary", async () => {
    const checkedAt = "2026-08-19T00:00:00.000Z";
    const baseDiscovery = (github: unknown) => ({
      controllerNodeId: "node-seoul",
      generatedAt: 1,
      peers: [{
        fingerprint: "node-kmac",
        deviceName: "KMac",
        platform: "macOS",
        status: "online",
        lastSeen: 1,
        resourceCount: 1,
      }],
      resources: [{
        id: "workspace:kmac-m4",
        nodeId: "node-kmac",
        deviceName: "KMac",
        kind: "directory",
        displayName: "KMac",
        capabilities: [],
        allowedOperations: ["inspect"],
        allowedGroupIds: ["seoul-mac"],
        defaultGroupId: "seoul-mac",
        runnerIds: [],
        statusRunnerId: "kmac-status-v1",
        runners: [],
        status: {
          state: "ready",
          summary: "workspace ready",
          observedAt: checkedAt,
          github,
        },
      }],
      totalPeerCount: 1,
      totalResourceCount: 1,
      onlinePeerCount: 1,
      taskCount: 0,
      taskStatusCounts: {},
      truncated: { peers: 0, resources: 0 },
    });
    const safeStatus = {
      status: "authenticated",
      login: "octocat",
      source: "config",
      checkedAt,
    };
    const validMcp = await connectMcp(async () => Response.json(baseDiscovery(safeStatus)));
    try {
      const valid = await validMcp.client.callTool({ name: "mesh_list_devices", arguments: {} });
      expect(valid.isError).not.toBe(true);
      expect(JSON.parse(textContent(valid))).toMatchObject({
        resources: [{
          status: {
            github: safeStatus,
          },
        }],
      });
    } finally {
      await validMcp.close();
    }

    const hostile = {
      ...safeStatus,
      stdout: "ghp_hostile-discovery-output",
    };
    const impossible = {
      status: "authenticated",
      login: null,
      source: "none",
      checkedAt,
      errorCode: "command-failed",
    };
    for (const github of [hostile, impossible]) {
      const mcp = await connectMcp(async () => Response.json(baseDiscovery(github)));
      try {
        const result = await mcp.client.callTool({ name: "mesh_list_devices", arguments: {} });
        const text = textContent(result);
        expect(result.isError).toBe(true);
        expect(text).not.toContain("ghp_hostile-discovery-output");
        expect(text).not.toContain("command-failed");
      } finally {
        await mcp.close();
      }
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
          resultSummary: "x".repeat(20_000),
          integrity: {
            complete: true,
            runner: { resultSummaryTruncated: false, debugOutputTruncated: false },
            mesh: { resultSummaryTruncated: false, debugOutputTruncated: false },
          },
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
      expect(JSON.parse(text)).toMatchObject({
        result: {
          integrity: { complete: false, gateway: { truncated: true } },
        },
      });
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

  test("lists jobs with bounded filters and cursor without returning prompts or environment", async () => {
    let captured: Request | undefined;
    const inputCursor = Buffer.from(JSON.stringify({ createdAt: 103, taskId: "task-list-0" })).toString("base64url");
    const nextCursor = Buffer.from(JSON.stringify({ createdAt: 101, taskId: "task-list-1" })).toString("base64url");
    const fetchImpl: ControlFetch = async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        jobs: [{
          taskId: "task-list-1",
          groupId: "group-alpha",
          targetNodeId: "node-l40",
          resourceId: "repo:gpu",
          operation: "run",
          status: "completed",
          phase: "completed",
          approvalStatus: "approved",
          createdAt: 101,
          updatedAt: 102,
          resultSummary: "done",
          prompt: "must-not-return",
          env: { API_KEY: "must-not-return" },
        }],
        nextCursor,
      });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_list_jobs",
        arguments: {
          targetNodeId: "node-l40",
          resourceId: "repo:gpu",
          groupId: "group-alpha",
          status: "completed",
          createdAfter: 100,
          limit: 25,
          cursor: inputCursor,
        },
      });
      const query = new URL(captured!.url).searchParams;
      expect(Object.fromEntries(query)).toEqual({
        limit: "25",
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        groupId: "group-alpha",
        status: "completed",
        createdAfter: "100",
        cursor: inputCursor,
      });
      const text = textContent(result);
      expect(JSON.parse(text)).toMatchObject({
        jobs: [{ taskId: "task-list-1", resultSummary: "done" }],
        nextCursor,
      });
      expect(text).not.toContain("must-not-return");
    } finally {
      await mcp.close();
    }
  });

  test("returns a complete verified result artifact without token-style ID redaction", async () => {
    const content = Buffer.from("changed source\n", "utf8");
    const changed = [{
      type: "file" as const,
      path: "src/solution.ts",
      mode: 0o644,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    }];
    const identity = {
      version: 1 as const,
      kind: "result" as const,
      baseArtifactId: `sha256:${"b".repeat(64)}`,
      taskId: "task-artifact-1",
      changed,
      deleted: ["old.txt"],
    };
    const sha256 = meshArtifactSha256(identity);
    const manifest = { ...identity, artifactId: `sha256:${sha256}`, sha256 };
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "mesh-artifact",
      requestId: "artifact-request-1",
      targetNodeId: "node-kmac",
      taskId: identity.taskId,
      manifest,
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_get_result_artifact",
        arguments: { taskId: identity.taskId },
      });
      expect(result.isError).not.toBe(true);
      const text = textContent(result);
      expect(text).toContain(manifest.artifactId);
      expect(text).toContain(changed[0].contentBase64);
      expect(JSON.parse(text)).toMatchObject({ manifest: { sha256, deleted: ["old.txt"] } });
    } finally {
      await mcp.close();
    }
  });

  test("rejects a result artifact whose declared file hash does not match its content", async () => {
    const content = Buffer.from("actual content\n", "utf8");
    const changed = [{
      type: "file" as const,
      path: "src/solution.ts",
      mode: 0o644,
      size: content.byteLength,
      sha256: "0".repeat(64),
      contentBase64: content.toString("base64"),
    }];
    const identity = {
      version: 1 as const,
      kind: "result" as const,
      baseArtifactId: `sha256:${"b".repeat(64)}`,
      taskId: "task-artifact-invalid",
      changed,
      deleted: [] as string[],
    };
    const sha256 = meshArtifactSha256(identity);
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "mesh-artifact",
      requestId: "artifact-request-invalid",
      targetNodeId: "node-kmac",
      taskId: identity.taskId,
      manifest: { ...identity, artifactId: `sha256:${sha256}`, sha256 },
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_get_result_artifact",
        arguments: { taskId: identity.taskId },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).not.toContain(content.toString("base64"));
    } finally {
      await mcp.close();
    }
  });

  test("rejects a self-consistent result artifact for a different requested task", async () => {
    const content = Buffer.from("bound content\n", "utf8");
    const changed = [{
      type: "file" as const,
      path: "src/bound.ts",
      mode: 0o644,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    }];
    const identity = {
      version: 1 as const,
      kind: "result" as const,
      baseArtifactId: "sha256:" + "b".repeat(64),
      taskId: "task-artifact-payload",
      changed,
      deleted: [] as string[],
    };
    const digest = meshArtifactSha256(identity);
    const manifest = { ...identity, artifactId: "sha256:" + digest, sha256: digest };
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "mesh-artifact",
      requestId: "artifact-request-boundary",
      targetNodeId: "node-kmac",
      taskId: identity.taskId,
      manifest,
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_get_result_artifact",
        arguments: { taskId: "task-artifact-requested" },
      });
      const text = textContent(result);
      expect(result.isError).toBe(true);
      expect(text).not.toContain(content.toString("base64"));
      expect(text).not.toContain("bound content");
      expect(text).not.toContain(manifest.artifactId);
    } finally {
      await mcp.close();
    }
  });

  test("routes bounded remote Codex thread, input, and approval calls", async () => {
    const captured: Request[] = [];
    const fetchImpl: ControlFetch = async (input, init) => {
      const request = new Request(input, init);
      captured.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/codex/threads") {
        return Response.json({
          kind: "codex-thread-list",
          threads: [{
            id: "thread-1",
            name: "Mac work",
            preview: "Authorization: Bearer private-token",
            cwd: "/Users/test/project",
            status: "idle",
            canAcceptDirectInput: true,
          }],
        });
      }
      if (path === "/api/codex/input") {
        return Response.json({
          kind: "input-ack",
          sessionId: "thread-1",
          status: "running",
          note: "已发送到 Codex 会话",
        }, { status: 202 });
      }
      return Response.json({
        kind: "permission-response-ack",
        requestId: "codex-approval-1",
        status: "answered",
      }, { status: 202 });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const listed = await mcp.client.callTool({
        name: "remote_codex_list_threads",
        arguments: { targetNodeId: "mac-node" },
      });
      const listedText = textContent(listed);
      expect(new URL(captured[0].url).searchParams.get("targetNodeId")).toBe("mac-node");
      expect(listedText).toContain("thread-1");
      expect(listedText).not.toContain("private-token");

      await mcp.client.callTool({
        name: "remote_codex_send_message",
        arguments: {
          targetNodeId: "mac-node",
          sessionId: "thread-1",
          text: "continue",
        },
      });
      expect(await captured[1].clone().json()).toEqual({
        targetNodeId: "mac-node",
        sessionId: "thread-1",
        text: "continue",
        deadlineMs: 30_000,
      });

      const approval = await mcp.client.callTool({
        name: "remote_codex_respond_approval",
        arguments: {
          targetNodeId: "mac-node",
          requestId: "codex-approval-1",
          optionId: "deny",
        },
      });
      expect(approval.isError).not.toBe(true);
      expect(await captured[2].clone().json()).toEqual({
        targetNodeId: "mac-node",
        requestId: "codex-approval-1",
        optionId: "deny",
      });
    } finally {
      await mcp.close();
    }
  });

  test("accepts a bounded oversized Codex thread list and truncates its rows", async () => {
    const threads = Array.from({ length: 41 }, (_, index) => ({
      id: `thread-${index}`,
      name: `Thread ${index}`,
      preview: "p".repeat(1_600),
      cwd: "/Users/test/project",
      status: "idle",
      canAcceptDirectInput: true,
    }));
    const responseBody = JSON.stringify({ kind: "codex-thread-list", threads });
    const responseBytes = Buffer.byteLength(responseBody, "utf8");
    expect(responseBytes).toBeGreaterThan(64 * 1024);
    expect(responseBytes).toBeLessThan(2 * 1024 * 1024);

    const fetchImpl: ControlFetch = async () => new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "remote_codex_list_threads",
        arguments: { targetNodeId: "mac-node" },
      });
      expect(result.isError).not.toBe(true);

      const summary = JSON.parse(textContent(result)) as {
        threads: Array<{ preview?: unknown }>;
        truncatedThreads: number;
      };
      expect(summary.threads).toHaveLength(40);
      expect(summary.truncatedThreads).toBe(1);
      expect(summary.threads.every((thread) => (
        typeof thread.preview === "string" && thread.preview.length <= 1_024
      ))).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  test("keeps a large Mesh job response concise and truthful", async () => {
    const responseBody = JSON.stringify({
      taskId: "task-large-job",
      targetNodeId: "node-kmac",
      resourceId: "repo:workspace",
      groupId: "group-alpha",
      operation: "run",
      status: "completed",
      result: { output: "o".repeat(160_000) },
    });
    expect(Buffer.byteLength(responseBody, "utf8")).toBeGreaterThan(64 * 1024);
    const fetchImpl: ControlFetch = async () => new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_get_job",
        arguments: { taskId: "task-large-job" },
      });
      expect(result.isError).not.toBe(true);
      const summary = JSON.parse(textContent(result)) as Record<string, unknown>;
      expect(summary.resultTruncated).toBe(true);
      expect((summary.result as { output: string }).output.length).toBeLessThanOrEqual(1_024);
      expect(Buffer.byteLength(textContent(result), "utf8")).toBeLessThan(48 * 1024);
    } finally {
      await mcp.close();
    }
  });

  test("pages oversized Codex events without losing sequence continuity", async () => {
    const events = Array.from({ length: 120 }, (_, index) => ({
      seq: index + 1,
      receivedAt: index + 1,
      payload: {
        kind: "codex-event",
        type: "text",
        sessionId: "thread-events",
        text: "e".repeat(1_500),
      },
    }));
    const base = { kind: "codex-events", totalEvents: events.length, oldestSeq: 1, latestSeq: events.length, events };
    const responseBody = JSON.stringify(base);
    expect(Buffer.byteLength(responseBody, "utf8")).toBeGreaterThan(64 * 1024);
    const fetchImpl: ControlFetch = async (input) => {
      const afterSeq = Number(new URL(input instanceof Request ? input.url : String(input)).searchParams.get("afterSeq"));
      return Response.json({
        ...base,
        nextSeq: Math.min(afterSeq + 50, events.length),
        hasMore: afterSeq + 50 < events.length,
        truncated: false,
      });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const first = await mcp.client.callTool({
        name: "remote_codex_get_events",
        arguments: { targetNodeId: "node-kmac", afterSeq: 0, limit: 50 },
      });
      expect(first.isError).not.toBe(true);
      const firstPage = JSON.parse(textContent(first)) as {
        events: Array<{ seq: number }>;
        totalEvents: number;
        nextSeq: number;
        nextCursor: number | null;
        hasMore: boolean;
        truncated: boolean;
      };
      expect(firstPage.events.map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(firstPage).toMatchObject({ totalEvents: 120, nextSeq: 50, nextCursor: 50, hasMore: true, truncated: true });

      const second = await mcp.client.callTool({
        name: "remote_codex_get_events",
        arguments: { targetNodeId: "node-kmac", afterSeq: firstPage.nextCursor, limit: 50 },
      });
      expect(second.isError).not.toBe(true);
      const secondPage = JSON.parse(textContent(second)) as { events: Array<{ seq: number }>; nextSeq: number };
      expect(secondPage.events.map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
      expect(secondPage.nextSeq).toBe(100);
    } finally {
      await mcp.close();
    }
  });

  test("trusts an explicit false cursor gap for a sparse filtered first event", async () => {
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "codex-events",
      totalEvents: 1,
      oldestSeq: 1,
      latestSeq: 42,
      events: [{
        seq: 42,
        receivedAt: 42,
        payload: { kind: "codex-event", sessionId: "thread-filtered", type: "text", text: "event" },
      }],
      nextSeq: 42,
      hasMore: false,
      cursorGap: false,
      truncated: false,
      truncatedEvents: 0,
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "remote_codex_get_events",
        arguments: { targetNodeId: "node-kmac", sessionId: "thread-filtered", afterSeq: 0, limit: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({
        events: [{ seq: 42 }],
        nextSeq: 42,
        nextCursor: null,
        hasMore: false,
        cursorGap: false,
        truncated: false,
        truncatedEvents: 0,
      });
    } finally {
      await mcp.close();
    }
  });

  test("does not count consumed history as Codex event truncation", async () => {
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "codex-events",
      totalEvents: 2,
      oldestSeq: 1,
      latestSeq: 42,
      events: [{
        seq: 42,
        receivedAt: 42,
        payload: { kind: "codex-event", sessionId: "thread-filtered", type: "text", text: "terminal" },
      }],
      nextSeq: 42,
      hasMore: false,
      cursorGap: false,
      truncated: false,
      truncatedEvents: 0,
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "remote_codex_get_events",
        arguments: { targetNodeId: "node-kmac", sessionId: "thread-filtered", afterSeq: 5, limit: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({
        nextSeq: 42,
        nextCursor: null,
        hasMore: false,
        cursorGap: false,
        truncated: false,
        truncatedEvents: 0,
      });
    } finally {
      await mcp.close();
    }
  });

  test("does not let terminal upstream metadata hide gateway-local event pages", async () => {
    const events = Array.from({ length: 3 }, (_, index) => ({
      seq: index + 1,
      receivedAt: index + 1,
      payload: { kind: "codex-event", sessionId: "thread-local-page", type: "text", text: `event-${index + 1}` },
    }));
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "codex-events",
      totalEvents: events.length,
      oldestSeq: 1,
      latestSeq: 3,
      events,
      nextSeq: 3,
      hasMore: false,
      cursorGap: false,
      cursorGapEvents: 0,
      truncated: false,
      truncatedEvents: 0,
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "remote_codex_get_events",
        arguments: { targetNodeId: "node-kmac", afterSeq: 0, limit: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({
        events: [{ seq: 1 }],
        nextSeq: 1,
        nextCursor: 1,
        hasMore: true,
        cursorGap: false,
        cursorGapEvents: 0,
        truncated: true,
        truncatedEvents: 2,
      });
    } finally {
      await mcp.close();
    }
  });

  test("preserves retained-buffer cursor gaps when no forward page remains", async () => {
    const fetchImpl: ControlFetch = async () => Response.json({
      kind: "codex-events",
      totalEvents: 1,
      oldestSeq: 5,
      latestSeq: 5,
      events: [{
        seq: 5,
        receivedAt: 5,
        payload: { kind: "codex-event", sessionId: "thread-gap", type: "text", text: "retained" },
      }],
      nextSeq: 5,
      hasMore: false,
      cursorGap: true,
      cursorGapEvents: 4,
      truncated: true,
      truncatedEvents: 4,
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "remote_codex_get_events",
        arguments: { targetNodeId: "node-kmac", afterSeq: 0, limit: 10 },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({
        events: [{ seq: 5 }],
        nextSeq: 5,
        nextCursor: null,
        hasMore: false,
        cursorGap: true,
        cursorGapEvents: 4,
        truncated: true,
        truncatedEvents: 4,
      });
    } finally {
      await mcp.close();
    }
  });

  test("pages oversized Codex history and keeps raw payload opt-in", async () => {
    const events = Array.from({ length: 120 }, (_, index) => ({
      kind: "codex-event",
      type: "text",
      sessionId: "thread-history",
      text: "h".repeat(1_500),
    }));
    const responseBody = JSON.stringify({
      kind: "codex-resumed",
      sessionId: "thread-history",
      cwd: "/workspace",
      canAcceptDirectInput: true,
      events,
    });
    expect(Buffer.byteLength(responseBody, "utf8")).toBeGreaterThan(64 * 1024);
    const fetchImpl: ControlFetch = async () => new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const first = await mcp.client.callTool({
        name: "remote_codex_read_thread",
        arguments: { targetNodeId: "node-kmac", sessionId: "thread-history", limit: 50 },
      });
      expect(first.isError).not.toBe(true);
      const firstPage = JSON.parse(textContent(first)) as {
        events: Array<{ text?: string }>;
        totalEvents: number;
        nextSeq: number;
        nextCursor: number | null;
        hasMore: boolean;
        raw: boolean;
      };
      expect(firstPage.events).toHaveLength(50);
      expect(firstPage).toMatchObject({ totalEvents: 120, nextSeq: 50, nextCursor: 50, hasMore: true, raw: false });
      expect(firstPage.events[0]?.text?.length).toBeLessThanOrEqual(2_000);

      const raw = await mcp.client.callTool({
        name: "remote_codex_read_thread",
        arguments: { targetNodeId: "node-kmac", sessionId: "thread-history", limit: 1, raw: true },
      });
      expect(raw.isError).not.toBe(true);
      expect(JSON.parse(textContent(raw))).toMatchObject({ raw: true, events: [{ kind: "codex-event" }] });
    } finally {
      await mcp.close();
    }
  });

  test("returns verified artifact metadata when optional file bodies do not fit", async () => {
    const content = Buffer.alloc(200_000, 7);
    const file = {
      type: "file" as const,
      path: "src/large.bin",
      mode: 0o644,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    };
    const identity = {
      version: 1 as const,
      kind: "result" as const,
      baseArtifactId: `sha256:${"b".repeat(64)}`,
      taskId: "task-large-artifact",
      changed: [file],
      deleted: ["old.txt"],
    };
    const sha256 = meshArtifactSha256(identity);
    const manifest = { ...identity, artifactId: `sha256:${sha256}`, sha256 };
    const responseBody = JSON.stringify({
      kind: "mesh-artifact",
      requestId: "artifact-request-large",
      targetNodeId: "node-kmac",
      taskId: identity.taskId,
      manifest,
    });
    expect(Buffer.byteLength(responseBody, "utf8")).toBeGreaterThan(64 * 1024);
    const fetchImpl: ControlFetch = async () => new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const mcp = await connectMcp(fetchImpl);
    try {
      const result = await mcp.client.callTool({
        name: "mesh_get_result_artifact",
        arguments: { taskId: identity.taskId },
      });
      expect(result.isError).not.toBe(true);
      const text = textContent(result);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(240 * 1024);
      const envelope = JSON.parse(text) as {
        manifest: { changed: Array<Record<string, unknown>>; deleted: string[]; sha256: string };
        integrity: { verified: boolean; complete: boolean; truncated: boolean; bodies: { omittedFiles: number } };
      };
      expect(envelope.manifest).toMatchObject({ sha256, deleted: ["old.txt"] });
      expect(envelope.manifest.changed[0]).toMatchObject({ path: file.path, size: file.size, sha256: file.sha256 });
      expect(envelope.manifest.changed[0]).not.toHaveProperty("contentBase64");
      expect(envelope.integrity).toMatchObject({ verified: true, complete: false, truncated: true });
      expect(envelope.integrity.bodies.omittedFiles).toBe(1);
      expect(text).not.toContain(file.contentBase64);
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

  test("preserves authoritative token-shaped IDs but redacts them in free-form runner output", async () => {
    const controllerNodeId = `sk-proj-${"c".repeat(24)}`;
    const nodeId = `ghp_${"n".repeat(24)}`;
    const requesterNodeId = `github_pat_${"q".repeat(24)}`;
    const ownerNodeId = `xoxb-${"o".repeat(24)}`;
    const taskId = `sk-${"a".repeat(24)}`;
    const resourceId = `sk-proj-${"r".repeat(24)}`;
    const groupId = `ghp_${"g".repeat(24)}`;
    const runnerId = `github_pat_${"u".repeat(24)}`;
    const threadId = "eyJaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc";
    const parentThreadId = `xoxa-${"p".repeat(24)}`;
    const requestId = `AIza${"i".repeat(24)}`;
    const operationId = `AKIA${"z".repeat(24)}`;
    const idempotencyKey = `xoxr-${"d".repeat(24)}`;
    const artifactSha256 = "a".repeat(64);
    const artifactId = `sha256:${artifactSha256}`;
    const baseArtifactId = `sha256:${"b".repeat(64)}`;
    const fetchImpl: ControlFetch = async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/discovery") {
        return Response.json({
          controllerNodeId,
          generatedAt: 1,
          peers: [{
            fingerprint: nodeId,
            deviceName: "KMac",
            platform: "darwin",
            status: "online",
            resourceCount: 0,
          }],
          resources: [{
            id: resourceId,
            nodeId,
            deviceName: "KMac",
            kind: "directory",
            displayName: "workspace",
            capabilities: ["run"],
            allowedOperations: ["run"],
            allowedGroupIds: [groupId],
            defaultGroupId: groupId,
            runnerIds: [runnerId],
            statusRunnerId: runnerId,
            runners: [{ runnerId, title: "runner", purpose: "task", approvalRequired: true }],
          }],
          taskCount: 0,
          taskStatusCounts: {},
          totalPeerCount: 1,
          totalResourceCount: 1,
          onlinePeerCount: 1,
          truncated: { peers: 0, resources: 0 },
        });
      }
      if (path.startsWith("/api/tasks/")) {
        return Response.json({
          taskId,
          targetNodeId: nodeId,
          resourceId,
          groupId,
          status: "completed",
          idempotencyKey,
          baseArtifactId,
          resultArtifactId: artifactId,
          resultArtifactSha256: artifactSha256,
          result: {
            authorization: "Bearer header-secret",
            cookie: "session=cookie-secret",
            apiKey: "api-key-secret-value",
            jwt: threadId,
            identifiers: {
              taskId,
              nodeId,
              requesterNodeId,
              ownerNodeId,
              resourceId,
              groupId,
              runnerId,
              threadId,
              sessionId: threadId,
              parentThreadId,
              requestId,
              operationId,
              artifactId,
              baseArtifactId,
              resultArtifactId: artifactId,
              idempotencyKey,
            },
          },
        });
      }
      if (path.startsWith("/api/codex/operations/")) {
        return Response.json({
          operationId,
          targetNodeId: nodeId,
          idempotencyKey,
          status: "completed",
          retryable: false,
          sessionId: threadId,
        });
      }
      if (path === "/api/codex/approvals") {
        return Response.json({
          approvals: [{ requestId, sessionId: threadId, toolName: "shell", summary: "safe" }],
        });
      }
      return Response.json({
        kind: "codex-thread-list",
        threads: [{ id: threadId, parentThreadId, preview: "Cookie: secret-cookie" }],
      });
    };
    const mcp = await connectMcp(fetchImpl);
    try {
      const devices = JSON.parse(textContent(await mcp.client.callTool({
        name: "mesh_list_devices",
        arguments: {},
      })));
      const job = JSON.parse(textContent(await mcp.client.callTool({ name: "mesh_get_job", arguments: { taskId } })));
      expect(job).toMatchObject({ resultArtifactSha256: artifactSha256 });
      const operation = JSON.parse(textContent(await mcp.client.callTool({
        name: "remote_codex_get_operation",
        arguments: { operationId },
      })));
      const threads = JSON.parse(textContent(await mcp.client.callTool({
        name: "remote_codex_list_threads",
        arguments: { targetNodeId: nodeId },
      })));
      const approvals = JSON.parse(textContent(await mcp.client.callTool({
        name: "remote_codex_list_approvals",
        arguments: { targetNodeId: nodeId },
      })));
      const output = JSON.stringify({ devices, job, operation, threads, approvals });
      for (const id of [
        controllerNodeId, nodeId, taskId, resourceId, groupId,
        runnerId, threadId, parentThreadId, requestId, operationId, idempotencyKey,
        artifactId, baseArtifactId, artifactSha256,
      ]) {
        expect(output).toContain(id);
      }
      expect(devices.controllerNodeId).toBe(controllerNodeId);
      expect(devices.peers[0].nodeId).toBe(nodeId);
      expect(devices.resources[0]).toMatchObject({
        resourceId,
        nodeId,
        allowedGroupIds: [groupId],
        defaultGroupId: groupId,
        runnerIds: [runnerId],
        statusRunnerId: runnerId,
      });
      expect(job).toMatchObject({
        taskId,
        groupId,
        targetNodeId: nodeId,
        resourceId,
        idempotencyKey,
        baseArtifactId,
        resultArtifactId: artifactId,
        resultArtifactSha256: artifactSha256,
      });
      expect(operation).toMatchObject({ operationId, targetNodeId: nodeId, idempotencyKey, sessionId: threadId });
      expect(threads).toMatchObject({
        targetNodeId: nodeId,
        threads: [{ sessionId: threadId, parentThreadId }],
      });
      expect(approvals).toMatchObject({
        targetNodeId: nodeId,
        approvals: [{ requestId, sessionId: threadId }],
      });
      const nestedIdentifiers = job.result.identifiers as Record<string, string>;
      for (const [key, value] of Object.entries({
        taskId,
        nodeId,
        requesterNodeId,
        ownerNodeId,
        resourceId,
        groupId,
        runnerId,
        threadId,
        sessionId: threadId,
        parentThreadId,
        requestId,
        operationId,
        artifactId,
        baseArtifactId,
        resultArtifactId: artifactId,
        idempotencyKey,
      })) {
        expect(nestedIdentifiers[key]).not.toBe(value);
        expect(nestedIdentifiers[key]).toContain("<redacted-token>");
      }
      expect(job.result.jwt).toBe("<redacted-token>");
      expect(job.result.authorization).toBe("<redacted>");
      expect(job.result.cookie).toBe("<redacted>");
      expect(job.result.apiKey).toBe("<redacted>");
      for (const secret of [
        "header-secret",
        "cookie-secret",
        "api-key-secret-value",
        "secret-cookie",
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain("<redacted>");
    } finally {
      await mcp.close();
    }
  });
});
