import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTaskStatusPayload } from "@agentlink/wire";
import { MeshController } from "../src/control/controller";
import { ControlTaskJournal, type ControlTaskStatus } from "../src/control/journal";
import { ControlTaskOutbox } from "../src/control/outbox";

interface ReconciliationHarness {
  sessions: Map<string, unknown>;
  requestTaskStatus: (peerId: string, taskId: string) => Promise<MeshTaskStatusPayload>;
  reconcilePeer: (peerId: string) => Promise<void>;
}

describe("Mesh controller reconciliation", () => {
  test("terminal target status overwrites stale controller states and removes their outbox entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-reconcile-"));
    const journal = new ControlTaskJournal(join(root, "tasks.json"));
    const outbox = new ControlTaskOutbox(join(root, "outbox.json"));
    const peerId = "node-kmac";
    const staleStatuses: ControlTaskStatus[] = ["queued", "running", "approval-required"];

    for (const status of staleStatuses) {
      const taskId = `task-reconcile-${status}`;
      const payload = {
        kind: "mesh-task-request" as const,
        task: {
          taskId,
          groupId: "group-alpha",
          requesterNodeId: "node-seoul",
          targetNodeId: peerId,
          resourceId: "workspace:kmac-m4",
          operation: "inspect" as const,
        },
      };
      journal.create({
        taskId,
        groupId: payload.task.groupId,
        targetNodeId: peerId,
        resourceId: payload.task.resourceId,
        operation: payload.task.operation,
        status,
        message: `stale ${status}`,
        createdAt: 1,
        updatedAt: 1,
      });
      outbox.put(payload);
    }

    const controller = new MeshController({
      nodeId: "node-seoul",
      journal,
      outbox,
      loadPeers: () => ({}),
    });
    const harness = controller as unknown as ReconciliationHarness;
    harness.sessions.set(peerId, { closed: false });
    harness.requestTaskStatus = async (_targetNodeId, taskId) => ({
      kind: "mesh-task-status",
      requestId: `status-${taskId}`,
      targetNodeId: peerId,
      taskId,
      known: true,
      status: "completed",
      message: "terminal status from target",
      updatedAt: new Date().toISOString(),
    });

    await harness.reconcilePeer(peerId);

    for (const staleStatus of staleStatuses) {
      const taskId = `task-reconcile-${staleStatus}`;
      expect(journal.get(taskId)).toMatchObject({
        status: "completed",
        message: "terminal status from target",
      });
      expect(outbox.get(taskId)).toBeUndefined();
    }
    expect(outbox.list()).toEqual([]);
  });
});
