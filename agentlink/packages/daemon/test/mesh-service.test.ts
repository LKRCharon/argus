import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMeshSigningKeyPair, type MeshTaskProgressPayload } from "@agentlink/wire";
import { MeshService } from "../src/mesh/service";
import { MeshTaskStore } from "../src/mesh/task-store";

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(): { value: MeshService; root: string } {
  const base = mkdtempSync(join(tmpdir(), "argus-mesh-service-"));
  const root = join(base, "repo");
  const quarantine = join(base, "quarantine");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "safe mesh\n");
  tempRoots.push(base);
  return {
    root,
    value: new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      quarantineRoot: quarantine,
      auditSink: () => {},
      taskStore: new MeshTaskStore(join(base, "tasks.json")),
      signingKey: generateMeshSigningKeyPair(),
      resources: [{
        id: "repo:fixture",
        ownerNodeId: "node-b",
        kind: "repo",
        displayName: "fixture",
        root,
      }],
    }),
  };
}

function task(operation: "inspect" | "quarantine" | "delete") {
  return {
    groupId: "group-alpha",
    taskId: `task-${operation}`,
    requesterNodeId: "node-a",
    targetNodeId: "node-b",
    resourceId: "repo:fixture",
    operation,
  } as const;
}

describe.serial("MeshService", () => {
  test("runs only the owner-configured GPU status probe", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-gpu-status-"));
    const root = join(base, "gpu");
    mkdirSync(root, { recursive: true });
    tempRoots.push(base);
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      quarantineRoot: join(base, "quarantine"),
      auditSink: () => {},
      signingKey: generateMeshSigningKeyPair(),
      resources: [{
        id: "gpu:fixture",
        ownerNodeId: "node-b",
        kind: "gpu",
        displayName: "GPU fixture",
        root,
        statusRunnerId: "gpu:status",
      }],
      runners: [{
        id: "gpu:status",
        resourceId: "gpu:fixture",
        purpose: "status",
        executable: process.execPath,
        fixedArgs: ["-e", "console.log('0, NVIDIA L40, 42, 1024, 46068, 12, 535.309.01')"],
        exposeOutput: true,
      }],
    });

    const result = await value.resourceStatus("status-1", "gpu:fixture");
    expect(result).toMatchObject({
      kind: "mesh-resource-status",
      resourceId: "gpu:fixture",
      status: {
        state: "ready",
        gpu: { devices: [{ name: "NVIDIA L40", utilizationGpuPercent: 12 }] },
      },
    });
    expect(value.listResources()[0]?.runnerIds).toEqual([]);
  });

  test("handles read-only inspect without exposing local paths", async () => {
    const { value } = service();
    const progress: MeshTaskProgressPayload[] = [];
    const result = await value.handle(
      { kind: "mesh-task-request", task: task("inspect") },
      (event) => { progress.push(event); },
    );
    expect(result).toMatchObject({ kind: "mesh-task-result", status: "completed", operation: "inspect" });
    expect(progress.map((event) => event.status)).toEqual(["queued", "running", "completed"]);
    expect(JSON.stringify(result)).not.toContain("/repo");

    expect(value.taskStatus({
      kind: "mesh-task-status-request",
      requestId: "status-task-inspect",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: "task-inspect",
    })).toMatchObject({ known: true, status: "completed", result: { status: "completed" } });
    expect(value.taskStatus({
      kind: "mesh-task-status-request",
      requestId: "status-task-missing",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: "task-missing",
    })).toMatchObject({ known: false, status: "unknown" });
  });

  test("queues an unsigned run for local approval, then accepts one owner-signed execution", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-mesh-approval-"));
    const root = join(base, "gpu");
    mkdirSync(root, { recursive: true });
    tempRoots.push(base);
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      groupMembers: new Map([["group-alpha", new Set(["node-a", "node-b"])]]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      quarantineRoot: join(base, "quarantine"),
      auditSink: () => {},
      taskStore: new MeshTaskStore(join(base, "tasks.json")),
      signingKey: generateMeshSigningKeyPair(),
      resources: [{
        id: "gpu:fixture",
        ownerNodeId: "node-b",
        kind: "gpu",
        displayName: "GPU fixture",
        root,
      }],
      runners: [{
        id: "gpu:train",
        resourceId: "gpu:fixture",
        purpose: "task",
        executable: process.execPath,
        fixedArgs: ["-e", "console.log('approved')"],
        maxRuntimeMs: 10_000,
      }],
    });
    const request = {
      groupId: "group-alpha",
      taskId: "task-local-approval",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      resourceId: "gpu:fixture",
      operation: "run" as const,
      scope: { runnerId: "gpu:train", args: [] },
    };

    expect(value.proposeTask({ kind: "mesh-task-request", task: request })).toMatchObject({
      kind: "mesh-task-progress",
      status: "approval-required",
    });
    const grant = value.issueGrant(request);
    const approval = value.issueApproval(grant, "allow once on target");
    expect(await value.handleRequest({ kind: "mesh-task-request", task: request, grant, approval })).toMatchObject({
      status: "completed",
      decision: "allow",
    });

    const deniedRequest = { ...request, taskId: "task-local-deny" };
    expect(value.proposeTask({ kind: "mesh-task-request", task: deniedRequest })).toMatchObject({
      status: "approval-required",
    });
    expect(value.denyProposal(deniedRequest.taskId)).toMatchObject({ status: "denied", decision: "deny" });

    const dynamicArgsRequest = {
      ...request,
      taskId: "task-dynamic-args-denied",
      scope: { runnerId: "gpu:train", args: ["--remote-value"] },
    };
    expect(value.proposeTask({ kind: "mesh-task-request", task: dynamicArgsRequest })).toMatchObject({
      status: "denied",
      message: "策略拒绝: invalid-runner-scope",
    });
    expect(() => value.issueGrant(dynamicArgsRequest)).toThrow();

    const stdinRequest = {
      ...request,
      taskId: "task-stdin-denied",
      scope: { runnerId: "gpu:train", args: [], input: "unreviewed payload" },
    };
    expect(value.proposeTask({ kind: "mesh-task-request", task: stdinRequest })).toMatchObject({ status: "denied" });
    expect(() => value.issueGrant(stdinRequest)).toThrow();
  });

  test("cancels an active named runner and persists the terminal result", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-mesh-cancel-"));
    const root = join(base, "gpu");
    mkdirSync(root, { recursive: true });
    tempRoots.push(base);
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      quarantineRoot: join(base, "quarantine"),
      auditSink: () => {},
      taskStore: new MeshTaskStore(join(base, "tasks.json")),
      signingKey: generateMeshSigningKeyPair(),
      resources: [{
        id: "gpu:fixture",
        ownerNodeId: "node-b",
        kind: "gpu",
        displayName: "GPU fixture",
        root,
      }],
      runners: [{
        id: "gpu:slow",
        resourceId: "gpu:fixture",
        executable: process.execPath,
        fixedArgs: ["-e", "setTimeout(() => {}, 30_000)"],
        maxRuntimeMs: 10_000,
      }],
    });
    const request = {
      groupId: "group-alpha",
      taskId: "task-cancel-runner",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      resourceId: "gpu:fixture",
      operation: "run" as const,
      scope: { runnerId: "gpu:slow", args: [] },
    };
    const grant = value.issueGrant(request);
    const approval = value.issueApproval(grant, "run the bounded fixture");
    let running!: () => void;
    const didStart = new Promise<void>((resolve) => { running = resolve; });
    const execution = value.handleRequest(
      { kind: "mesh-task-request", task: request, grant, approval },
      (event) => { if (event.status === "running") running(); },
    );
    await didStart;

    expect(value.cancelTask({
      kind: "mesh-task-cancel-request",
      requestId: "cancel-1",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: request.taskId,
    })).toMatchObject({ accepted: true, status: "running" });
    expect(await execution).toMatchObject({ status: "cancelled" });
    expect(value.taskStatus({
      kind: "mesh-task-status-request",
      requestId: "status-after-cancel",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: request.taskId,
    })).toMatchObject({ known: true, status: "cancelled", result: { status: "cancelled" } });
  });

  test("requires a grant and owner approval before quarantine, then moves safely", async () => {
    const { value, root } = service();
    const request = task("quarantine");
    const grant = value.issueGrant(request);
    const pending = await value.handle({ kind: "mesh-task-request", task: request, grant });
    expect(pending).toMatchObject({ status: "approval-required", decision: "approval-required" });

    const approval = value.issueApproval(grant, "quarantine the exact repo after review");
    const completed = await value.handle({ kind: "mesh-task-request", task: request, grant, approval });
    expect(completed).toMatchObject({ status: "completed", decision: "allow" });
    expect(existsSync(root)).toBe(false);
  });

  test("does not accept arbitrary remote cwd/command payloads", async () => {
    const { value } = service();
    expect(await value.handle({
      kind: "mesh-task-request",
      task: { ...task("inspect"), scope: { cwd: "/etc", argv: ["rm", "-rf", "/"] } },
    })).toMatchObject({ status: "completed", operation: "inspect" });
    expect(await value.handle({ kind: "not-a-mesh-command", cwd: "/etc", command: "rm -rf /" })).toBeUndefined();
  });
});
