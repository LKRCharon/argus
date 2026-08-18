import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMeshSigningKeyPair } from "@agentlink/wire";
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
  });

  test("handles read-only inspect without exposing local paths", async () => {
    const { value } = service();
    const result = await value.handle({ kind: "mesh-task-request", task: task("inspect") });
    expect(result).toMatchObject({ kind: "mesh-task-result", status: "completed", operation: "inspect" });
    expect(JSON.stringify(result)).not.toContain("/repo");
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
