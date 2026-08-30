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
      expect(captured ? new URL(captured.url).pathname : "").toBe("/api/overview");
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
          status: {
            workspace: {
              connectionStatus: "online",
              watcherAvailable: true,
              codexAppServerAvailable: true,
              remoteCodexControl: true,
              activeJobs: 0,
              workspaceRevision: "a".repeat(40),
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
      if (path === "/api/overview") {
        return Response.json({
          controllerNodeId,
          generatedAt: 1,
          peers: [{
            fingerprint: nodeId,
            deviceName: "KMac",
            platform: "darwin",
            status: "online",
            resources: [],
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
          tasks: [],
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
