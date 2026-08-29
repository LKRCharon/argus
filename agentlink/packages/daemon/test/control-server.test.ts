import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTaskRequest } from "@agentlink/wire";
import { ControlTaskJournal, type ControlTaskRecord } from "../src/control/journal";
import { ControlTaskOutbox } from "../src/control/outbox";
import {
  createControlRequestHandler,
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
  const controller: ControlController = {
    nodeId: "node-seoul",
    journal,
    overview: () => ({
      controllerNodeId: "node-seoul",
      relayUrl: "ws://127.0.0.1:8787/ws",
      generatedAt: Date.now(),
      peers: [],
      resources: [],
      tasks: journal.list(),
    }),
    refreshResources: async () => undefined,
    submitTask: async (task) => {
      submitted.push(task);
      const now = Date.now();
      const record: ControlTaskRecord = {
        taskId: task.taskId,
        groupId: task.groupId,
        targetNodeId: task.targetNodeId,
        resourceId: task.resourceId,
        operation: task.operation,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      return journal.create(record);
    },
    cancelTask: async (taskId) => {
      cancelled.push(taskId);
      const record = journal.get(taskId);
      if (!record) throw new Error("未找到任务");
      return journal.update(taskId, { status: "cancelled", message: "任务已取消" })!;
    },
    listCodexThreads: async (targetNodeId) => {
      codexCalls.push({ method: "list", args: [targetNodeId] });
      return { kind: "codex-thread-list", threads: [{ id: "thread-1" }] };
    },
    readCodexThread: async (targetNodeId, sessionId) => {
      codexCalls.push({ method: "read", args: [targetNodeId, sessionId] });
      return { kind: "codex-resumed", sessionId, events: [] };
    },
    startCodexThread: async (targetNodeId, text, cwd) => {
      codexCalls.push({ method: "start", args: [targetNodeId, text, cwd] });
      return { kind: "input-ack", sessionId: "thread-new", status: "running" };
    },
    sendCodexInput: async (targetNodeId, sessionId, text) => {
      codexCalls.push({ method: "input", args: [targetNodeId, sessionId, text] });
      return { kind: "input-ack", sessionId, status: "running" };
    },
    interruptCodexThread: async (targetNodeId, sessionId) => {
      codexCalls.push({ method: "interrupt", args: [targetNodeId, sessionId] });
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
      body: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
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
      { method: "list", args: ["mac-node"] },
      { method: "input", args: ["mac-node", "thread-1", "continue"] },
    ]);
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
});
