import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexGatewayError } from "../src/control/codex";
import { CodexOperationStore } from "../src/control/codex-operations";
import { MeshController } from "../src/control/controller";
import { ControlTaskJournal } from "../src/control/journal";
import { ControlTaskOutbox } from "../src/control/outbox";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "argus-codex-operations-"));
  roots.push(root);
  return root;
}

function controllerFixture(): { controller: MeshController; operationFile: string } {
  const root = tempRoot();
  const operationFile = join(root, "operations.json");
  return {
    operationFile,
    controller: new MeshController({
      nodeId: "node-seoul",
      loadPeers: () => ({}),
      journal: new ControlTaskJournal(join(root, "tasks.json")),
      outbox: new ControlTaskOutbox(join(root, "outbox.json")),
      codexOperationStore: new CodexOperationStore(operationFile),
    }),
  };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("durable remote Codex operations", () => {
  test("returns immediately, persists completion, and deduplicates by idempotencyKey", async () => {
    const { controller, operationFile } = controllerFixture();
    let starts = 0;
    controller.codex.startThread = async () => {
      starts += 1;
      return { kind: "input-ack", sessionId: "thread-created-1", status: "running" };
    };

    const startedAt = Date.now();
    const queued = controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-idempotency-1",
      "/workspace",
      60_000,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(queued.status).toBe("queued");
    expect(typeof queued.operationId).toBe("string");
    await nextTurn();

    const completed = controller.getCodexOperation(queued.operationId);
    expect(completed?.status).toBe("completed");
    expect(completed?.sessionId).toBe("thread-created-1");
    expect(completed?.retryable).toBe(false);
    expect(typeof completed?.sentAt).toBe("number");
    expect(typeof completed?.acknowledgedAt).toBe("number");
    expect(typeof completed?.completedAt).toBe("number");
    expect(new CodexOperationStore(operationFile).get(queued.operationId, "node-seoul"))
      .toMatchObject({ status: "completed", sessionId: "thread-created-1" });

    const duplicate = controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-idempotency-1",
      "/workspace",
      60_000,
    );
    expect(duplicate.operationId).toBe(queued.operationId);
    expect(starts).toBe(1);
    expect(() => controller.startCodexThreadOperation(
      "node-kmac",
      "different task",
      "codex-idempotency-1",
      "/workspace",
      60_000,
    )).toThrow("idempotencyKey");
  });

  test("dispatches the fork source and conflicts when only that durable input changes", async () => {
    const { controller } = controllerFixture();
    const forkSources: Array<string | undefined> = [];
    controller.codex.startThread = async (_targetNodeId, _text, _cwd, options) => {
      forkSources.push(options?.forkFromSessionId);
      return { kind: "input-ack", sessionId: "thread-forked", status: "running" };
    };

    const first = controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-fork-idempotency",
      "/workspace",
      60_000,
      "thread-source-a",
    );
    await nextTurn();
    expect(controller.getCodexOperation(first.operationId)).toMatchObject({
      status: "completed",
      sessionId: "thread-forked",
    });
    expect(forkSources).toEqual(["thread-source-a"]);

    const duplicate = controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-fork-idempotency",
      "/workspace",
      60_000,
      "thread-source-a",
    );
    expect(duplicate.operationId).toBe(first.operationId);
    expect(() => controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-fork-idempotency",
      "/workspace",
      60_000,
      "thread-source-b",
    )).toThrow("idempotencyKey");
    expect(forkSources).toEqual(["thread-source-a"]);
  });

  test("marks a policy-disabled remote start failed without a watcher timeout", async () => {
    const { controller } = controllerFixture();
    controller.codex.startThread = async () => {
      throw new CodexGatewayError(
        "remote Codex control is disabled by Mesh policy",
        "watcher",
        false,
        false,
      );
    };
    const operation = controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-policy-disabled",
    );
    await nextTurn();
    const failed = controller.getCodexOperation(operation.operationId);
    expect(failed).toMatchObject({
      status: "failed",
      retryable: false,
      message: "remote Codex control is disabled by Mesh policy",
    });
    expect(failed?.timedOutStage).toBeUndefined();
  });

  test("reconciles a timed_out operation through the documented late-success path", async () => {
    const { controller } = controllerFixture();
    controller.codex.startThread = async () => {
      throw new CodexGatewayError(
        "turn/start timed out after thread creation",
        "app-server",
        true,
        true,
      );
    };
    const operation = controller.startCodexThreadOperation(
      "node-kmac",
      "perform task",
      "codex-timeout-1",
      undefined,
      10_000,
    );
    await nextTurn();
    expect(controller.getCodexOperation(operation.operationId)).toMatchObject({
      status: "timed_out",
      timedOutStage: "app-server",
      retryable: true,
    });

    expect(controller.codex.handlePayload("node-kmac", {
      kind: "input-ack",
      controlRequestId: `codex-op:${operation.operationId}`,
      sessionId: "thread-late-1",
      status: "running",
    })).toBe(true);
    expect(controller.getCodexOperation(operation.operationId)).toMatchObject({
      status: "completed",
      sessionId: "thread-late-1",
    });
  });

  test("ignores duplicate late success after completion", async () => {
    const { controller } = controllerFixture();
    controller.codex.startThread = async () => ({ kind: "input-ack", sessionId: "thread-completed", status: "running" });
    const operation = controller.startCodexThreadOperation("node-kmac", "task", "codex-duplicate-success");
    await nextTurn();
    for (let index = 0; index < 2; index += 1) {
      expect(controller.codex.handlePayload("node-kmac", {
        kind: "input-ack",
        controlRequestId: `codex-op:${operation.operationId}`,
        sessionId: "thread-completed",
        status: "running",
      })).toBe(true);
    }
    expect(controller.getCodexOperation(operation.operationId)).toMatchObject({
      status: "completed",
      sessionId: "thread-completed",
      message: "thread and initial turn accepted",
    });
  });

  test("ignores a late failure after completion", async () => {
    const { controller } = controllerFixture();
    controller.codex.startThread = async () => ({ kind: "input-ack", sessionId: "thread-success", status: "running" });
    const operation = controller.startCodexThreadOperation("node-kmac", "task", "codex-failure-after-completed");
    await nextTurn();
    controller.codex.handlePayload("node-kmac", {
      kind: "codex-error",
      controlRequestId: `codex-op:${operation.operationId}`,
      sessionId: "thread-success",
      note: "late failure",
      retryable: true,
    });
    expect(controller.getCodexOperation(operation.operationId)).toMatchObject({ status: "completed", sessionId: "thread-success" });
  });

  test("ignores a late success after failure", async () => {
    const { controller } = controllerFixture();
    controller.codex.startThread = async () => {
      throw new CodexGatewayError("failed", "peer", false, false, "thread-failed");
    };
    const operation = controller.startCodexThreadOperation("node-kmac", "task", "codex-success-after-failed");
    await nextTurn();
    controller.codex.handlePayload("node-kmac", {
      kind: "input-ack",
      controlRequestId: `codex-op:${operation.operationId}`,
      sessionId: "thread-failed",
      status: "running",
    });
    expect(controller.getCodexOperation(operation.operationId)).toMatchObject({ status: "failed", sessionId: "thread-failed" });
  });

  test("keeps a bound session immutable during timed_out reconciliation", async () => {
    const { controller } = controllerFixture();
    controller.codex.startThread = async () => {
      throw new CodexGatewayError("timed out", "app-server", true, true, "thread-bound");
    };
    const operation = controller.startCodexThreadOperation("node-kmac", "task", "codex-conflicting-session");
    await nextTurn();
    controller.codex.handlePayload("node-kmac", {
      kind: "input-ack",
      controlRequestId: `codex-op:${operation.operationId}`,
      sessionId: "thread-conflicting",
      status: "running",
    });
    expect(controller.getCodexOperation(operation.operationId)).toMatchObject({
      status: "timed_out",
      sessionId: "thread-bound",
    });
  });

  test("marks nonterminal records timed_out at controller restart without replaying", () => {
    const root = tempRoot();
    const file = join(root, "operations.json");
    const store = new CodexOperationStore(file);
    const operation = store.begin({
      requesterNodeId: "node-seoul",
      targetNodeId: "node-kmac",
      idempotencyKey: "codex-restart-1",
      requestDigest: "a".repeat(64),
      deadlineAt: Date.now() + 60_000,
    }).record;
    const recovered = new CodexOperationStore(file).get(operation.operationId, "node-seoul");
    expect(recovered).toMatchObject({
      status: "timed_out",
      timedOutStage: "controller",
      retryable: true,
    });
  });

  test("fails closed when the operation journal contains duplicate identities", () => {
    const root = tempRoot();
    const file = join(root, "operations.json");
    const store = new CodexOperationStore(file);
    store.begin({
      requesterNodeId: "node-seoul",
      targetNodeId: "node-kmac",
      idempotencyKey: "codex-duplicate-1",
      requestDigest: "b".repeat(64),
      deadlineAt: Date.now() + 60_000,
    });
    const journal = JSON.parse(readFileSync(file, "utf8")) as { operations: unknown[] };
    journal.operations.push(journal.operations[0]);
    writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
    expect(() => new CodexOperationStore(file)).toThrow("duplicate identities");
  });
});
