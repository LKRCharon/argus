import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MeshTaskRequest } from "@agentlink/wire";
import { ControlTaskJournal, type ControlTaskRecord } from "../src/control/journal";
import {
  createControlRequestHandler,
  type ControlController,
} from "../src/control/server";

function fakeController(root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "argus-control-"))): {
  controller: ControlController;
  submitted: MeshTaskRequest[];
} {
  const journal = new ControlTaskJournal(join(root, "tasks.json"));
  const submitted: MeshTaskRequest[] = [];
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
  };
  return { controller, submitted };
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

  test("does not let the web API bypass grant and approval requirements", async () => {
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
    expect(response.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  test("serves the built console and keeps traversal outside the dist root", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "argus-control-dist-"));
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
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "argus-journal-"));
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
