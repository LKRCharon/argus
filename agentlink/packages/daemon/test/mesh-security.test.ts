import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshAuditEvent, MeshTaskRequest } from "@agentlink/wire";
import { appendMeshAuditEvent } from "../src/mesh/audit";
import { trustedMeshRequestersForPeer } from "../src/mesh/config";
import { MeshTaskStore } from "../src/mesh/task-store";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function task(taskId: string): MeshTaskRequest {
  return {
    groupId: "group-alpha",
    taskId,
    requesterNodeId: "node-controller",
    targetNodeId: "node-target",
    resourceId: "repo:fixture",
    operation: "inspect",
  };
}

describe("Mesh security invariants", () => {
  test("binds an allowlisted requester to the authenticated transport peer", () => {
    expect([...trustedMeshRequestersForPeer("node-controller")]).toEqual(["node-controller"]);
    expect([...trustedMeshRequestersForPeer("node-controller", ["node-controller", "node-other"])])
      .toEqual(["node-controller"]);
    expect([...trustedMeshRequestersForPeer("node-controller", ["node-other"])])
      .toEqual([]);
  });

  test("appends more than one audit event on every supported platform", () => {
    const file = join(tempRoot("argus-mesh-audit-"), "audit.jsonl");
    const event: MeshAuditEvent = {
      groupId: "group-alpha",
      eventId: "event-1",
      taskId: "task-1",
      actorNodeId: "node-controller",
      targetNodeId: "node-target",
      operation: "inspect",
      decision: "allow",
      reason: "test",
      createdAt: new Date().toISOString(),
    };
    appendMeshAuditEvent(event, file);
    appendMeshAuditEvent({ ...event, eventId: "event-2" }, file);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("fails closed instead of evicting replay records at capacity", () => {
    const file = join(tempRoot("argus-mesh-tasks-"), "tasks.json");
    const store = new MeshTaskStore(file, 1);
    store.begin(task("task-1"));
    expect(() => store.begin(task("task-2"))).toThrow("记录上限");
    expect(new MeshTaskStore(file, 1).get("task-1")?.taskId).toBe("task-1");
  });

  test("fails closed when the target replay journal contains duplicate task ids", () => {
    const file = join(tempRoot("argus-mesh-tasks-duplicate-"), "tasks.json");
    const store = new MeshTaskStore(file, 2);
    store.begin(task("task-duplicate"));
    const journal = JSON.parse(readFileSync(file, "utf8")) as { tasks: unknown[] };
    journal.tasks.push(journal.tasks[0]);
    writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
    expect(() => new MeshTaskStore(file, 2)).toThrow("重复 taskId");
  });

  test("sanitizes runner outputs before KMac task-store persistence and preserves typed ids", () => {
    const file = join(tempRoot("argus-mesh-tasks-redaction-"), "tasks.json");
    const store = new MeshTaskStore(file, 2);
    const request = task("task-redaction-preserved");
    store.begin(request);
    const artifactId = `sha256:${"a".repeat(64)}`;
    const requestId = "request-redaction-preserved";
    const operationId = "operation-redaction-preserved";
    const result = store.update(request.taskId, {
      status: "completed",
      result: {
        kind: "mesh-task-result",
        groupId: request.groupId,
        taskId: request.taskId,
        targetNodeId: request.targetNodeId,
        operation: request.operation,
        status: "completed",
        decision: "allow",
        message: "done",
        result: {
          taskId: request.taskId,
          artifactId,
          requestId,
          operationId,
          resultSummary: "OPENAI_API_KEY=SENTINEL_KMAC_OPENAI_123456 AWS_SECRET_ACCESS_KEY:'SENTINEL_KMAC_AWS_123456' /Users/sentinel/private/repo/file.ts",
          debugOutput: 'FOO_TOKEN="SENTINEL_KMAC_TOKEN_123456" FOO_SECRET:SENTINEL_KMAC_SECRET_123456',
        },
      },
    });
    const bytes = readFileSync(file, "utf8");
    expect(bytes).not.toContain("SENTINEL_KMAC");
    expect(bytes).not.toContain("/Users/sentinel/private/repo");
    for (const id of [request.taskId, artifactId, requestId, operationId]) {
      expect(bytes).toContain(id);
      expect(JSON.stringify(result)).toContain(id);
    }
  });
});
