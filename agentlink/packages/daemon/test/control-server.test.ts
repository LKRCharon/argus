import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  meshArtifactSha256,
  type MeshArtifactFile,
  type MeshResultArtifactManifest,
  type MeshTaskRequest,
} from "@agentlink/wire";
import { ControlTaskJournal, type ControlTaskRecord } from "../src/control/journal";
import { ControlTaskOutbox } from "../src/control/outbox";
import { CodexOperationStore, type CodexOperationRecord } from "../src/control/codex-operations";
import { MeshController } from "../src/control/controller";
import {
  createControlRequestHandler,
  startControlServer,
  type ControlController,
} from "../src/control/server";

function fakeController(root = mkdtempSync(join(tmpdir(), "argus-control-"))): {
  controller: ControlController;
  submitted: MeshTaskRequest[];
  cancelled: string[];
  codexCalls: Array<{ method: string; args: unknown[] }>;
} {
  const journal = new ControlTaskJournal(join(root, "tasks.json"));
  const submitted: MeshTaskRequest[] = [];
  const cancelled: string[] = [];
  const codexCalls: Array<{ method: string; args: unknown[] }> = [];
  const operations = new Map<string, CodexOperationRecord>();
  const controller: ControlController = {
    nodeId: "node-seoul",
    journal,
    overview: () => ({
      controllerNodeId: "node-seoul",
      relayUrl: "ws://127.0.0.1:8787/ws",
      generatedAt: Date.now(),
      peers: [],
      resources: [{
        id: "repo:gpu",
        ownerNodeId: "node-l40",
        nodeId: "node-l40",
        deviceName: "L40",
        kind: "repo",
        displayName: "GPU repo",
        rootHint: "GPU repo",
        capabilities: ["inspect", "run"],
        allowedOperations: ["inspect", "run"],
        allowedGroupIds: ["group-alpha"],
        defaultGroupId: "group-alpha",
        runners: [{
          runnerId: "repo:runner",
          title: "Repository runner",
          purpose: "task",
          approvalRequired: true,
          maxRuntimeMs: 60_000,
          workspaceCapabilities: ["read-only-status"],
          inputSchema: { type: "object" },
          resultSchema: { type: "object" },
        }],
      }],
      tasks: journal.list(),
    }),
    refreshResources: async () => undefined,
    submitTask: async (task, _grant, _approval, submission) => {
      if (submission) {
        const existing = journal.findByIdempotencyKey(task.requesterNodeId, submission.idempotencyKey);
        if (existing) {
          if (existing.idempotencyDigest !== submission.idempotencyDigest) {
            throw new Error("idempotencyKey 已绑定不同任务");
          }
          return existing;
        }
      }
      submitted.push(task);
      const now = Date.now();
      const record: ControlTaskRecord = {
        taskId: task.taskId,
        requesterNodeId: task.requesterNodeId,
        groupId: task.groupId,
        targetNodeId: task.targetNodeId,
        resourceId: task.resourceId,
        operation: task.operation,
        idempotencyKey: submission?.idempotencyKey,
        idempotencyDigest: submission?.idempotencyDigest,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      return journal.create(record);
    },
    requestResultArtifact: async () => {
      throw new Error("no artifact in fake controller");
    },
    cancelTask: async (taskId) => {
      cancelled.push(taskId);
      const record = journal.get(taskId);
      if (!record) throw new Error("未找到任务");
      return journal.update(taskId, { status: "cancelled", message: "任务已取消" })!;
    },
    listCodexThreads: async (targetNodeId, deadlineMs) => {
      codexCalls.push({ method: "list", args: [targetNodeId, deadlineMs] });
      return { kind: "codex-thread-list", threads: [{ id: "thread-1" }] };
    },
    readCodexThread: async (targetNodeId, sessionId, deadlineMs) => {
      codexCalls.push({ method: "read", args: [targetNodeId, sessionId, deadlineMs] });
      return { kind: "codex-resumed", sessionId, events: [] };
    },
    startCodexThreadOperation: (
      targetNodeId,
      _text,
      idempotencyKey,
      _cwd,
      deadlineMs,
      forkFromSessionId,
    ) => {
      codexCalls.push({
        method: "start",
        args: [targetNodeId, idempotencyKey, deadlineMs, forkFromSessionId],
      });
      const existing = [...operations.values()].find((operation) => operation.idempotencyKey === idempotencyKey);
      if (existing) return existing;
      const now = Date.now();
      const operation = {
        version: 1,
        operationId: `op-test-${operations.size + 1}`,
        requesterNodeId: "node-seoul",
        targetNodeId,
        kind: "start-thread",
        idempotencyKey,
        requestDigest: "a".repeat(64),
        status: "queued",
        deadlineAt: now + (deadlineMs ?? 120_000),
        retryable: false,
        createdAt: now,
        updatedAt: now,
      } satisfies CodexOperationRecord;
      operations.set(operation.operationId, operation);
      return operation;
    },
    getCodexOperation: (operationId) => operations.get(operationId),
    listCodexOperations: (query) => ({
      operations: [...operations.values()].filter((operation) => (
        !query.targetNodeId || operation.targetNodeId === query.targetNodeId
      )),
    }),
    sendCodexInput: async (targetNodeId, sessionId, text, deadlineMs) => {
      codexCalls.push({ method: "input", args: [targetNodeId, sessionId, text, deadlineMs] });
      return { kind: "input-ack", sessionId, status: "running" };
    },
    interruptCodexThread: async (targetNodeId, sessionId, deadlineMs) => {
      codexCalls.push({ method: "interrupt", args: [targetNodeId, sessionId, deadlineMs] });
      return { kind: "input-ack", sessionId, status: "done" };
    },
    listCodexEvents: (targetNodeId, afterSeq, limit, sessionId) => {
      codexCalls.push({ method: "events", args: [targetNodeId, afterSeq, limit, sessionId] });
      return { targetNodeId, events: [], nextSeq: afterSeq ?? 0 };
    },
    listCodexApprovals: (targetNodeId) => {
      codexCalls.push({ method: "approvals", args: [targetNodeId] });
      return [];
    },
    respondCodexApproval: async (targetNodeId, requestId, optionId) => {
      codexCalls.push({ method: "approval", args: [targetNodeId, requestId, optionId] });
      return { kind: "permission-response-ack", requestId, status: "answered" };
    },
  };
  return { controller, submitted, cancelled, codexCalls };
}

describe("Seoul control API", () => {
  test("listens before initial remote reconciliation and reports explicit readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-control-startup-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = new MeshController({
      nodeId: "node-seoul",
      loadPeers: () => ({}),
      journal: new ControlTaskJournal(join(root, "tasks.json")),
      outbox: new ControlTaskOutbox(join(root, "outbox.json")),
      codexOperationStore: new CodexOperationStore(join(root, "codex-operations.json")),
    });
    controller.connectAll = () => blocked;

    let handler: ((request: Request) => Promise<Response>) | undefined;
    let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
    const starting = startControlServer(controller, {
      port: 18_790,
      distDir: join(root, "missing-dist"),
      serve: (options) => {
        handler = options.fetch;
        return { port: options.port, stop: () => {} };
      },
    });
    try {
      server = await Promise.race([
        starting,
        Bun.sleep(100).then(() => undefined),
      ]);
      expect(server).toBeDefined();
      expect(handler).toBeDefined();
      const response = await handler!(new Request("http://localhost/health"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        ready: false,
        readiness: {
          state: "starting",
          reconciliationInProgress: true,
          lastReconciliationCompletedAt: null,
          lastReconciliationError: null,
        },
      });

      release();
      for (let attempt = 0; attempt < 40 && controller.readiness().state !== "ready"; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(controller.readiness()).toMatchObject({
        state: "ready",
        reconciliationInProgress: false,
        lastReconciliationError: null,
      });
    } finally {
      release();
      (server ?? await starting).stop();
    }
  });

  test("surfaces background reconciliation failure without exposing its raw diagnostic", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-control-degraded-"));
    const controller = new MeshController({
      nodeId: "node-seoul",
      loadPeers: () => ({}),
      journal: new ControlTaskJournal(join(root, "tasks.json")),
      outbox: new ControlTaskOutbox(join(root, "outbox.json")),
      codexOperationStore: new CodexOperationStore(join(root, "codex-operations.json")),
    });
    controller.connectAll = async () => {
      throw new Error("private relay diagnostic /sensitive/local/state");
    };
    await controller.start();
    for (let attempt = 0; attempt < 40 && controller.readiness().state === "starting"; attempt += 1) {
      await Bun.sleep(5);
    }

    const handler = createControlRequestHandler({ controller });
    const body = await (await handler(new Request("http://localhost/health"))).json();
    expect(body).toMatchObject({
      ok: true,
      ready: false,
      readiness: {
        state: "degraded",
        reconciliationInProgress: false,
        lastReconciliationError: "controller reconciliation failed",
      },
    });
    expect(JSON.stringify(body)).not.toContain("/sensitive/local/state");
    controller.stop();
  });

  test("returns a safe health snapshot without task secrets", async () => {
    const { controller } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const response = await handler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "argus-mesh-control",
      controllerNodeId: "node-seoul",
      peers: 0,
      onlinePeers: 0,
    });
  });

  test("projects overview tasks and bounds the sensitive discovery response", async () => {
    const { controller } = fakeController();
    controller.journal.create({
      taskId: "task-large-overview",
      requesterNodeId: "node-seoul",
      groupId: "group-alpha",
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "run",
      status: "completed",
      decision: "allow",
      requestDigest: "a".repeat(64),
      idempotencyKey: "idempotency-secret",
      idempotencyDigest: "b".repeat(64),
      message: "internal message",
      result: {
        prompt: "P".repeat(200_000),
        result: "R".repeat(200_000),
        debugOutput: "D".repeat(200_000),
        credentials: { token: "credential-secret" },
        relayUrl: "wss://relay-secret.example",
      },
      createdAt: 1,
      updatedAt: 2,
    });
    const handler = createControlRequestHandler({ controller });
    const overviewResponse = await handler(new Request("http://localhost/api/overview"));
    const overview = await overviewResponse.json() as Record<string, unknown>;
    const task = (overview.tasks as Array<Record<string, unknown>>)[0];
    expect(task).toEqual({
      taskId: "task-large-overview",
      groupId: "group-alpha",
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "run",
      status: "completed",
      decision: "allow",
      createdAt: 1,
      updatedAt: 2,
    });
    expect(JSON.stringify(overview)).not.toContain("credential-secret");
    expect(JSON.stringify(overview)).not.toContain("P".repeat(100));
    expect(JSON.stringify(overview)).not.toContain("aaaaaaaa");

    const discoveryResponse = await handler(new Request("http://localhost/api/discovery"));
    const discovery = await discoveryResponse.json() as Record<string, unknown>;
    expect(discovery).toMatchObject({ taskCount: 1, taskStatusCounts: { completed: 1 } });
    expect(discovery).not.toHaveProperty("tasks");
    expect(JSON.stringify(discovery)).not.toContain("credential-secret");
    expect(JSON.stringify(discovery)).not.toContain("relay-secret");
    expect(JSON.stringify(discovery)).not.toContain("aaaaaaaa");
    expect(discovery).toMatchObject({ totalPeerCount: 0, totalResourceCount: 1, truncated: { peers: 0, resources: 0 } });
    expect(discovery).toMatchObject({ resources: [{ runners: [{
      runnerId: "repo:runner",
      title: "Repository runner",
      purpose: "task",
      approvalRequired: true,
      maxRuntimeMs: 60_000,
      workspaceCapabilities: ["read-only-status"],
      inputSchema: { type: "object" },
      resultSchema: { type: "object" },
    }] }] });

    const refreshResponse = await handler(new Request("http://localhost/api/refresh", { method: "POST" }));
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    expect((refreshed.tasks as Array<Record<string, unknown>>)[0]).toEqual(task);
    expect(JSON.stringify(refreshed)).not.toContain("credential-secret");
    expect(JSON.stringify(refreshed)).not.toContain("P".repeat(100));

    const baseOverview = controller.overview();
    controller.overview = () => ({
      ...baseOverview,
      peers: Array.from({ length: 35 }, (_, index) => ({
        fingerprint: `node-${index}`,
        deviceName: `device-${index}`,
        platform: "linux",
        pairedAt: 1,
        status: "online" as const,
        lastSeen: 2,
        error: null,
        resources: Array.from({ length: 2 }, (_, resourceIndex) => ({
          ...baseOverview.resources[0],
          id: `resource:${index}:${resourceIndex}`,
        })),
        resourceStatuses: {},
      })),
      resources: Array.from({ length: 70 }, (_, index) => ({
        ...baseOverview.resources[0],
        id: `repo:gpu-${index}`,
      })),
    });
    const boundedResponse = await handler(new Request("http://localhost/api/discovery"));
    const bounded = await boundedResponse.json() as Record<string, unknown>;
    expect(bounded).toMatchObject({
      totalPeerCount: 35,
      totalResourceCount: 70,
      truncated: { peers: 3, resources: 6 },
    });
    expect((bounded.peers as unknown[]).length).toBe(32);
    expect((bounded.resources as unknown[]).length).toBe(64);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(64 * 1024);
  });

  test("rejects non-loopback hosts and cross-origin mutations", async () => {
    const { controller, cancelled } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const externalHost = await handler(new Request("http://control.example/health"));
    expect(externalHost.status).toBe(403);

    const crossOrigin = await handler(new Request("http://127.0.0.1:8790/api/tasks/task-1/cancel", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }));
    expect(crossOrigin.status).toBe(403);
    expect(cancelled).toEqual([]);
  });

  test("accepts a typed inspect task and binds the requester to Seoul", async () => {
    const { controller, submitted } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const response = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        groupId: "group-alpha",
        operation: "inspect",
      }),
    }));
    expect(response.status).toBe(202);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      requesterNodeId: "node-seoul",
      targetNodeId: "node-l40",
      operation: "inspect",
    });
  });

  test("submits run as an unsigned proposal for target-local approval", async () => {
    const { controller, submitted } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const response = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        groupId: "group-alpha",
        operation: "run",
        scope: { runnerId: "gpu-v1", args: [] },
      }),
    }));
    expect(response.status).toBe(202);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      requesterNodeId: "node-seoul",
      operation: "run",
      scope: { runnerId: "gpu-v1", args: [] },
    });
  });

  test("infers a sole trusted group and returns structured errors for ambiguous or illegal groups", async () => {
    const { controller, submitted } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const inferred = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        operation: "inspect",
      }),
    }));
    expect(inferred.status).toBe(202);
    expect(submitted[0].groupId).toBe("group-alpha");

    const originalOverview = controller.overview;
    controller.overview = () => {
      const overview = originalOverview();
      return {
        ...overview,
        resources: overview.resources.map((resource) => ({
          ...resource,
          defaultGroupId: undefined,
          allowedGroupIds: ["group-alpha", "group-beta"],
        })),
      };
    };
    const ambiguous = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetNodeId: "node-l40", resourceId: "repo:gpu", operation: "inspect" }),
    }));
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error: { code: "GROUP_REQUIRED" } });

    const illegal = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        groupId: "group-gamma",
        operation: "inspect",
      }),
    }));
    expect(illegal.status).toBe(403);
    expect(await illegal.json()).toMatchObject({ error: { code: "GROUP_NOT_ALLOWED" } });

    controller.overview = () => {
      const overview = originalOverview();
      return {
        ...overview,
        resources: overview.resources.map((resource) => ({
          ...resource,
          defaultGroupId: undefined,
          allowedGroupIds: undefined,
        })),
      };
    };
    const missingMetadata = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        groupId: "group-alpha",
        operation: "inspect",
      }),
    }));
    expect(missingMetadata.status).toBe(409);
    expect(await missingMetadata.json()).toMatchObject({ error: { code: "GROUP_METADATA_UNAVAILABLE" } });
  });

  test("deduplicates job submission by idempotencyKey without re-executing", async () => {
    const { controller, submitted } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const body = {
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "inspect",
      idempotencyKey: "windows-canary-1",
    };
    const first = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const second = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json() as Record<string, unknown>;
    const secondBody = await second.json() as Record<string, unknown>;
    expect(secondBody.taskId).toBe(firstBody.taskId);
    expect(secondBody.idempotencyKey).toBe("windows-canary-1");
    expect(secondBody.pollAfterMs).toBe(1_000);
    expect(submitted).toHaveLength(1);

    const conflict = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        operation: "run",
        scope: { runnerId: "gpu-v1", args: [] },
      }),
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  test("lists only caller-visible jobs with filters and a bounded cursor", async () => {
    const { controller } = fakeController();
    for (const [index, requesterNodeId] of ["node-seoul", "node-other", "node-seoul"].entries()) {
      controller.journal.create({
        taskId: `task-page-${index}`,
        requesterNodeId,
        groupId: "group-alpha",
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        operation: "inspect",
        status: index === 2 ? "completed" : "running",
        result: index === 2 ? { resultSummary: "ok", prompt: "must-not-return", env: { TOKEN: "secret" } } : undefined,
        createdAt: 100 + index,
        updatedAt: 100 + index,
      });
    }
    const handler = createControlRequestHandler({ controller });
    const first = await handler(new Request("http://localhost/api/tasks?targetNodeId=node-l40&limit=1"));
    const firstBody = await first.json() as { jobs: Array<Record<string, unknown>>; nextCursor: string };
    expect(firstBody.jobs).toHaveLength(1);
    expect(firstBody.jobs[0].taskId).toBe("task-page-2");
    expect(JSON.stringify(firstBody)).not.toContain("must-not-return");
    expect(JSON.stringify(firstBody)).not.toContain("TOKEN");

    const second = await handler(new Request(
      `http://localhost/api/tasks?targetNodeId=node-l40&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    ));
    const secondBody = await second.json() as { jobs: Array<Record<string, unknown>> };
    expect(secondBody.jobs.map((job) => job.taskId)).toEqual(["task-page-0"]);

    const filtered = await handler(new Request("http://localhost/api/tasks?status=completed&createdAfter=100&limit=100"));
    expect(await filtered.json()).toMatchObject({ jobs: [{ taskId: "task-page-2" }] });
  });

  test("requires JSON and bounds task request bodies", async () => {
    const { controller } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const wrongType = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      body: "{}",
    }));
    expect(wrongType.status).toBe(415);

    const oversized = await handler(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(12 * 1024 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
  });

  test("returns one task and routes cancellation through the controller", async () => {
    const { controller, cancelled } = fakeController();
    const now = Date.now();
    controller.journal.create({
      taskId: "task-cancel-1",
      groupId: "group-alpha",
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "inspect",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    const handler = createControlRequestHandler({ controller });
    const detail = await handler(new Request("http://localhost/api/tasks/task-cancel-1"));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ taskId: "task-cancel-1", status: "running" });

    const cancelledResponse = await handler(new Request("http://localhost/api/tasks/task-cancel-1/cancel", {
      method: "POST",
    }));
    expect(cancelledResponse.status).toBe(202);
    expect(cancelled).toEqual(["task-cancel-1"]);
    expect(await cancelledResponse.json()).toMatchObject({ status: "cancelled" });
  });

  test("renders approval waiting only while approval is genuinely pending", async () => {
    const { controller } = fakeController();
    controller.journal.create({
      taskId: "task-status-rendering",
      groupId: "group-alpha",
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "run",
      status: "running",
      message: "等待目标资源所有者批准",
      createdAt: 1,
      updatedAt: 2,
    });
    const handler = createControlRequestHandler({ controller });
    const running = await handler(new Request("http://localhost/api/tasks/task-status-rendering"));
    expect(await running.json()).toMatchObject({
      status: "running",
      phase: "running",
      approvalStatus: "not-required",
      message: "任务正在目标设备执行",
    });

    controller.journal.update("task-status-rendering", {
      status: "approval-required",
      message: "等待目标资源所有者批准",
    });
    const pending = await handler(new Request("http://localhost/api/tasks/task-status-rendering"));
    expect(await pending.json()).toMatchObject({
      status: "approval-required",
      approvalStatus: "pending",
      message: "等待目标资源所有者批准",
    });
  });

  test("wraps a task-bound result manifest in the MCP-compatible artifact envelope", async () => {
    const { controller } = fakeController();
    const content = Buffer.from("patched\n", "utf8");
    const identity = {
      version: 1 as const,
      kind: "result" as const,
      baseArtifactId: `sha256:${"b".repeat(64)}`,
      taskId: "task-artifact-http",
      changed: [{
        type: "file" as const,
        path: "src/main.ts",
        mode: 0o644,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        contentBase64: content.toString("base64"),
      }],
      deleted: [],
    };
    const sha256 = meshArtifactSha256(identity);
    const manifest: MeshResultArtifactManifest = {
      ...identity,
      artifactId: `sha256:${sha256}`,
      sha256,
    };
    const now = Date.now();
    controller.journal.create({
      taskId: identity.taskId,
      requesterNodeId: controller.nodeId,
      groupId: "group-alpha",
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "run",
      status: "completed",
      result: { resultArtifactId: manifest.artifactId },
      createdAt: now,
      updatedAt: now,
    });
    controller.requestResultArtifact = async () => manifest;

    const handler = createControlRequestHandler({ controller });
    const response = await handler(new Request(
      `http://localhost/api/tasks/${identity.taskId}/artifact`,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "mesh-artifact",
      targetNodeId: "node-l40",
      taskId: identity.taskId,
      manifest: {
        artifactId: manifest.artifactId,
        sha256,
        taskId: identity.taskId,
      },
    });
  });

  test("routes bounded remote Codex reads and mutations through the controller", async () => {
    const { controller, codexCalls } = fakeController();
    const handler = createControlRequestHandler({ controller });

    const threads = await handler(new Request(
      "http://localhost/api/codex/threads?targetNodeId=mac-node",
    ));
    expect(threads.status).toBe(200);
    expect(await threads.json()).toMatchObject({ kind: "codex-thread-list" });

    const input = await handler(new Request("http://localhost/api/codex/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "mac-node",
        sessionId: "thread-1",
        text: "continue",
        ignored: "must be stripped",
      }),
    }));
    expect(input.status).toBe(202);
    expect(codexCalls).toEqual([
      { method: "list", args: ["mac-node", 30_000] },
      { method: "input", args: ["mac-node", "thread-1", "continue", 30_000] },
    ]);
  });

  test("starts Codex asynchronously and exposes bounded persistent operation queries", async () => {
    const { controller, codexCalls } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const startedAt = Date.now();
    const response = await handler(new Request("http://localhost/api/codex/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "mac-node",
        text: "private prompt that must not be journalled",
        idempotencyKey: "codex-http-1",
        forkFromSessionId: "thread-source-1",
        deadlineMs: 90_000,
      }),
    }));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.status).toBe(202);
    const operation = await response.json() as Record<string, unknown>;
    expect(operation).toMatchObject({
      operationId: "op-test-1",
      idempotencyKey: "codex-http-1",
      status: "queued",
      pollAfterMs: 1_000,
    });
    expect(JSON.stringify(operation)).not.toContain("private prompt");

    const detail = await handler(new Request("http://localhost/api/codex/operations/op-test-1"));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ operationId: "op-test-1", status: "queued" });
    const listed = await handler(new Request("http://localhost/api/codex/operations?targetNodeId=mac-node&limit=1"));
    expect(await listed.json()).toMatchObject({ operations: [{ operationId: "op-test-1" }] });
    expect(codexCalls).toContainEqual({
      method: "start",
      args: ["mac-node", "codex-http-1", 90_000, "thread-source-1"],
    });
  });

  test("rejects malformed or misplaced Codex fork sources", async () => {
    const { controller, codexCalls } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const malformed = await handler(new Request("http://localhost/api/codex/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "mac-node",
        text: "fork",
        forkFromSessionId: "bad thread id",
      }),
    }));
    expect(malformed.status).toBe(400);

    const misplaced = await handler(new Request("http://localhost/api/codex/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "mac-node",
        sessionId: "thread-1",
        text: "continue",
        forkFromSessionId: "thread-source-1",
      }),
    }));
    expect(misplaced.status).toBe(400);
    expect(codexCalls).toEqual([]);
  });

  test("requires JSON and an explicit allow or deny for remote Codex approvals", async () => {
    const { controller, codexCalls } = fakeController();
    const handler = createControlRequestHandler({ controller });
    const invalid = await handler(new Request("http://localhost/api/codex/approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "mac-node",
        requestId: "approval-1",
        optionId: "always",
      }),
    }));
    expect(invalid.status).toBe(400);
    expect(codexCalls).toEqual([]);

    const allowed = await handler(new Request("http://localhost/api/codex/approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetNodeId: "mac-node",
        requestId: "approval-1",
        optionId: "deny",
      }),
    }));
    expect(allowed.status).toBe(202);
    expect(codexCalls).toEqual([
      { method: "approval", args: ["mac-node", "approval-1", "deny"] },
    ]);
  });

  test("serves the built console and keeps traversal outside the dist root", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-control-dist-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "mesh-console");
    const { controller } = fakeController();
    const handler = createControlRequestHandler({ controller, distDir: root });
    const home = await handler(new Request("http://localhost/mesh"));
    expect(home.status).toBe(200);
    expect(await home.text()).toBe("mesh-console");
    const traversal = await handler(new Request("http://localhost/../tasks.json"));
    expect(traversal.status).toBe(404);
  });
});

describe("ControlTaskJournal", () => {
  test("recovers its atomic task list across process restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-journal-"));
    const file = join(root, "tasks.json");
    const journal = new ControlTaskJournal(file);
    journal.create({
      taskId: "task-1",
      groupId: "group-alpha",
      targetNodeId: "node-l40",
      resourceId: "repo:gpu",
      operation: "inspect",
      status: "queued",
      createdAt: 1,
      updatedAt: 1,
    });
    journal.update("task-1", { status: "completed", message: "ok" });
    const recovered = new ControlTaskJournal(file);
    expect(recovered.get("task-1")).toMatchObject({ status: "completed", message: "ok" });
  });

  test("fails closed when its replay journal is unreadable or structurally invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-journal-invalid-"));
    const unreadable = join(root, "unreadable.json");
    writeFileSync(unreadable, "not json", { mode: 0o600 });
    chmodSync(unreadable, 0o600);
    expect(() => new ControlTaskJournal(unreadable)).toThrow("unreadable");

    const invalid = join(root, "invalid.json");
    writeFileSync(invalid, JSON.stringify([{ taskId: "task-only" }]), { mode: 0o600 });
    chmodSync(invalid, 0o600);
    expect(() => new ControlTaskJournal(invalid)).toThrow("invalid");
  });

  test("sanitizes outputs before Seoul journal persistence and preserves typed ids", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-journal-redaction-"));
    const file = join(root, "tasks.json");
    const taskId = "task-seoul-redaction-preserved";
    const artifactId = `sha256:${"b".repeat(64)}`;
    const requestId = "request-seoul-redaction-preserved";
    const operationId = "operation-seoul-redaction-preserved";
    const journal = new ControlTaskJournal(file);
    const record = journal.create({
      taskId,
      groupId: "group-alpha",
      targetNodeId: "node-kmac",
      resourceId: "repo:fixture",
      operation: "run",
      status: "completed",
      result: {
        taskId,
        artifactId,
        requestId,
        operationId,
        resultSummary: "OPENAI_API_KEY=SENTINEL_SEOUL_OPENAI_123456 AWS_SECRET_ACCESS_KEY:'SENTINEL_SEOUL_AWS_123456' /home/sentinel/private/repo/file.ts",
        debugOutput: 'FOO_TOKEN="SENTINEL_SEOUL_TOKEN_123456" FOO_SECRET:SENTINEL_SEOUL_SECRET_123456',
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const bytes = readFileSync(file, "utf8");
    expect(bytes).not.toContain("SENTINEL_SEOUL");
    expect(bytes).not.toContain("/home/sentinel/private/repo");
    for (const id of [taskId, artifactId, requestId, operationId]) {
      expect(bytes).toContain(id);
      expect(JSON.stringify(record)).toContain(id);
    }
  });
});

describe("ControlTaskOutbox", () => {
  test("recovers an idempotent pending delivery across controller restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-outbox-"));
    const file = join(root, "outbox.json");
    const outbox = new ControlTaskOutbox(file);
    const payload = {
      kind: "mesh-task-request" as const,
      task: {
        taskId: "task-durable-1",
        groupId: "group-alpha",
        requesterNodeId: "node-seoul",
        targetNodeId: "node-l40",
        resourceId: "repo:gpu",
        operation: "inspect" as const,
      },
    };
    outbox.put(payload);
    outbox.markAttempt(payload.task.taskId);

    const recovered = new ControlTaskOutbox(file);
    expect(recovered.get(payload.task.taskId)).toMatchObject({ attempts: 1, payload });
    expect(recovered.remove(payload.task.taskId)).toBe(true);
    expect(new ControlTaskOutbox(file).list()).toEqual([]);
  });

  test("persists a maximum-size structured base artifact for reliable delivery", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-outbox-artifact-"));
    const file = join(root, "outbox.json");
    const oneMiB = Buffer.alloc(1024 * 1024, 7);
    const files: MeshArtifactFile[] = Array.from({ length: 8 }, (_, index) => ({
      type: "file",
      path: `chunk-${index}.bin`,
      mode: 0o600,
      size: oneMiB.byteLength,
      sha256: createHash("sha256").update(oneMiB).digest("hex"),
      contentBase64: oneMiB.toString("base64"),
    }));
    const identity = { version: 1 as const, kind: "base" as const, files };
    const sha256 = meshArtifactSha256(identity);
    const baseArtifact = { ...identity, artifactId: `sha256:${sha256}`, sha256 };
    const payload = {
      kind: "mesh-task-request" as const,
      task: {
        taskId: "task-max-artifact",
        groupId: "group-alpha",
        requesterNodeId: "node-seoul",
        targetNodeId: "node-kmac",
        resourceId: "workspace:kmac-m4",
        operation: "run" as const,
        scope: {
          runnerId: "kmac-codex-v1",
          args: [],
          baseArtifactId: baseArtifact.artifactId,
        },
      },
      baseArtifact,
    };
    const outbox = new ControlTaskOutbox(file);
    expect(outbox.put(payload).payload.baseArtifact?.artifactId).toBe(baseArtifact.artifactId);
    expect(new ControlTaskOutbox(file).get(payload.task.taskId)?.payload.baseArtifact?.sha256).toBe(sha256);
  });
});
