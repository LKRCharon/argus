import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMeshSigningKeyPair,
  meshArtifactSha256,
  type MeshArtifactFile,
  type MeshBaseArtifactManifest,
  type MeshTaskProgressPayload,
} from "@agentlink/wire";
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

function baseArtifact(path: string, content: string): MeshBaseArtifactManifest {
  const bytes = Buffer.from(content, "utf8");
  const file: MeshArtifactFile = {
    type: "file",
    path,
    mode: 0o644,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
  const identity = { version: 1 as const, kind: "base" as const, files: [file] };
  const sha256 = meshArtifactSha256(identity);
  return { ...identity, artifactId: `sha256:${sha256}`, sha256 };
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

  test("publishes safe runner metadata and a fixed read-only workspace status contract", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-workspace-status-"));
    const root = join(base, "workspace");
    mkdirSync(root, { recursive: true });
    tempRoots.push(base);
    const checkedAt = new Date().toISOString();
    const status = {
      connectionStatus: "online",
      watcherAvailable: true,
      codexAppServerAvailable: true,
      activeJobs: 0,
      workspaceRevision: "revision-123",
      lastSuccess: checkedAt,
      lastErrorStage: null,
      checkedAt,
    };
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      auditSink: () => {},
      signingKey: generateMeshSigningKeyPair(),
      resources: [{
        id: "workspace:fixture",
        ownerNodeId: "node-b",
        kind: "directory",
        displayName: "workspace fixture",
        root,
        statusRunnerId: "workspace:status",
      }],
      runners: [{
        id: "workspace:status",
        resourceId: "workspace:fixture",
        purpose: "status",
        executable: process.execPath,
        fixedArgs: ["-e", `console.log(${JSON.stringify(JSON.stringify(status))})`],
        title: "Workspace status",
        inputSchema: { type: "object", additionalProperties: false },
        resultSchema: { type: "object", required: ["connectionStatus", "checkedAt"] },
      }],
    });

    expect(await value.resourceStatus("workspace-status-1", "workspace:fixture")).toMatchObject({
      status: { state: "ready", workspace: status },
    });
    const published = value.listResources()[0];
    expect(published).toMatchObject({
      allowedGroupIds: ["group-alpha"],
      defaultGroupId: "group-alpha",
      allowedOperations: ["inspect", "quarantine"],
      runners: [{
        runnerId: "workspace:status",
        title: "Workspace status",
        purpose: "status",
        approvalRequired: false,
        workspaceCapabilities: ["read-only-status"],
      }],
    });
    const text = JSON.stringify(published);
    expect(text).not.toContain(process.execPath);
    expect(text).not.toContain("fixedArgs");
    expect(text).not.toContain("env");
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

  test("runs an artifact job only in a task-scoped workspace and returns a content-addressed patch", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-artifact-service-"));
    const root = join(base, "existing-checkout");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "sentinel.txt"), "untouched\n");
    tempRoots.push(base);
    const artifact = baseArtifact("src/input.txt", "before\n");
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      groupMembers: new Map([["group-alpha", new Set(["node-a", "node-b"])]]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      artifactRoot: join(base, "task-workspaces"),
      auditSink: () => {},
      taskStore: new MeshTaskStore(join(base, "tasks.json")),
      signingKey: generateMeshSigningKeyPair(),
      resources: [{
        id: "workspace:fixture",
        ownerNodeId: "node-b",
        kind: "directory",
        displayName: "workspace fixture",
        root,
      }],
      runners: [{
        id: "workspace:codex",
        resourceId: "workspace:fixture",
        executable: process.execPath,
        fixedArgs: [
          "-e",
          "const fs=require('node:fs');fs.writeFileSync('src/input.txt','after\\n');fs.writeFileSync('solution.txt','done\\n');console.log(JSON.stringify({resultSummary:'changed two files'}));",
        ],
        maxRuntimeMs: 10_000,
        workspaceCapabilities: [
          "structured-artifact-input",
          "task-scoped-workspace",
          "changed-file-manifest",
        ],
      }],
    });
    const request = {
      groupId: "group-alpha",
      taskId: "task-artifact-service",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      resourceId: "workspace:fixture",
      operation: "run" as const,
      scope: { runnerId: "workspace:codex", args: [], baseArtifactId: artifact.artifactId },
    };
    expect(value.proposeTask({
      kind: "mesh-task-request",
      task: {
        ...request,
        taskId: "task-artifact-required",
        scope: { runnerId: "workspace:codex", args: [] },
      },
    })).toMatchObject({
      status: "denied",
      message: "策略拒绝: artifact-required-for-runner",
    });
    expect(() => value.issueGrant({
      ...request,
      taskId: "task-artifact-grant-required",
      scope: { runnerId: "workspace:codex", args: [] },
    })).toThrow("有效的本地 runnerId");
    expect(value.proposeTask({ kind: "mesh-task-request", task: request, baseArtifact: artifact }))
      .toMatchObject({ status: "approval-required" });
    const grant = value.issueGrant(request);
    const approval = value.issueApproval(grant, "approve isolated artifact task");
    const completed = await value.handleRequest({
      kind: "mesh-task-request",
      task: request,
      baseArtifact: artifact,
      grant,
      approval,
    });
    expect(completed.status).toBe("completed");
    const completedResult = completed.result as Record<string, unknown>;
    expect(completedResult.baseArtifactId).toBe(artifact.artifactId);
    expect(completedResult.resultArtifactId).toBeString();
    expect(completedResult.resultArtifactId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(completedResult.resultArtifactSha256).toBeString();
    expect(completedResult.resultArtifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completedResult.changedFiles).toBe(2);
    expect(completedResult.deletedFiles).toBe(0);
    expect(await Bun.file(join(root, "sentinel.txt")).text()).toBe("untouched\n");
    const resultArtifactId = String(completedResult.resultArtifactId);
    const delivered = value.resultArtifact({
      kind: "mesh-artifact-request",
      requestId: "artifact-read-1",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: request.taskId,
      artifactId: resultArtifactId,
    });
    expect(delivered.manifest.changed.map((file) => file.path)).toEqual(["solution.txt", "src/input.txt"]);
    expect(() => value.resultArtifact({
      kind: "mesh-artifact-request",
      requestId: "artifact-read-cross-requester",
      requesterNodeId: "node-other",
      targetNodeId: "node-b",
      taskId: request.taskId,
      artifactId: resultArtifactId,
    })).toThrow("不受信任");
  });

  test("separates resultSummary from debug output and composes runner and service truncation", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-runner-result-"));
    const root = join(base, "workspace");
    mkdirSync(root, { recursive: true });
    tempRoots.push(base);
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      auditSink: () => {},
      taskStore: new MeshTaskStore(join(base, "tasks.json")),
      signingKey: generateMeshSigningKeyPair(),
      resources: [{ id: "workspace:fixture", ownerNodeId: "node-b", kind: "directory", displayName: "fixture", root }],
      runners: [{
        id: "workspace:summary",
        resourceId: "workspace:fixture",
        executable: process.execPath,
        fixedArgs: ["-e", "console.log('x'.repeat(40000));console.error('debug-secret-output')"],
        maxOutputBytes: 64 * 1024,
      }],
    });
    const request = {
      groupId: "group-alpha",
      taskId: "task-summary-truncation",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      resourceId: "workspace:fixture",
      operation: "run" as const,
      scope: { runnerId: "workspace:summary", args: [] },
    };
    const grant = value.issueGrant(request);
    const approval = value.issueApproval(grant, "approve bounded summary");
    const completed = await value.handleRequest({ kind: "mesh-task-request", task: request, grant, approval });
    expect(completed).toMatchObject({
      status: "completed",
      result: {
        integrity: {
          complete: false,
          runner: { resultSummaryTruncated: true, debugOutputSuppressed: true },
          mesh: { resultSummaryTruncated: true },
        },
      },
    });
    const result = completed.result as Record<string, unknown>;
    expect(String(result.resultSummary).length).toBeLessThanOrEqual(16 * 1024);
    expect(result).not.toHaveProperty("debugOutput");
    expect(JSON.stringify(result)).not.toContain("debug-secret-output");
  });

  test("sanitizes runner output before transmission and KMac persistence", async () => {
    const base = mkdtempSync(join(tmpdir(), "argus-runner-redaction-"));
    const root = join(base, "workspace");
    const taskFile = join(base, "tasks.json");
    mkdirSync(root, { recursive: true });
    tempRoots.push(base);
    const value = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: [root],
      auditSink: () => {},
      taskStore: new MeshTaskStore(taskFile),
      signingKey: generateMeshSigningKeyPair(),
      resources: [{ id: "workspace:redaction", ownerNodeId: "node-b", kind: "directory", displayName: "redaction", root }],
      runners: [{
        id: "workspace:redaction-runner",
        resourceId: "workspace:redaction",
        executable: process.execPath,
        fixedArgs: [
          "-e",
          "console.log(JSON.stringify({resultSummary:'Authorization: Bearer SENTINEL_TRANSMIT_TOKEN_123456 '+process.cwd()+'/private.txt'}));console.error('secret=SENTINEL_TRANSMIT_SECRET_123456')",
        ],
        exposeDebugOutput: true,
      }],
    });
    const request = {
      groupId: "group-alpha",
      taskId: "task-transmission-redaction",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      resourceId: "workspace:redaction",
      operation: "run" as const,
      scope: { runnerId: "workspace:redaction-runner", args: [] },
    };
    const grant = value.issueGrant(request);
    const approval = value.issueApproval(grant, "run redaction fixture");
    const completed = await value.handleRequest({ kind: "mesh-task-request", task: request, grant, approval });
    const transmitted = JSON.stringify(completed);
    const persisted = readFileSync(taskFile, "utf8");
    for (const output of [transmitted, persisted]) {
      expect(output).not.toContain("SENTINEL_TRANSMIT");
      expect(output).not.toContain(root);
      expect(output).toContain(request.taskId);
    }
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
