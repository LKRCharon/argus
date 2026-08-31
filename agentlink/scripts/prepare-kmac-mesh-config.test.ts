import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMeshSigningKeyPair,
  meshArtifactSha256,
  type MeshArtifactFile,
  type MeshBaseArtifactManifest,
} from "@agentlink/wire";
import { parseMeshConfig } from "../packages/daemon/src/mesh/config";
import { MeshService } from "../packages/daemon/src/mesh/service";
import { MeshTaskStore } from "../packages/daemon/src/mesh/task-store";
import {
  CODEX_TASK_FIXED_ARGS,
  CODEX_TASK_RUNNER_ID,
  CODEX_TASK_WORKSPACE_CAPABILITIES,
  withKmacRunners,
} from "../deploy/prepare-kmac-mesh-config";

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base = parseMeshConfig({
  version: 1,
  groups: [{ id: "group-alpha", members: ["node-a", "node-b"] }],
  requesters: ["node-a"],
  legacyControl: false,
  remoteCodexControl: true,
  allowedRoots: ["/tmp/kmac-workspace"],
  resources: [{
    id: "workspace:kmac-m4",
    ownerNodeId: "node-b",
    kind: "directory",
    displayName: "KMac",
    root: "/tmp/kmac-workspace",
  }],
  runners: [],
});

const options = {
  runtimeBun: "/opt/agentlink/runtime/bun",
  statusScript: "/opt/agentlink/releases/release/deploy/kmac-workspace-status.ts",
  stateDir: "/opt/agentlink/state",
  codexLauncher: "/Users/test/.local/bin/codex",
};

describe("KMac Mesh config preparation", () => {
  test("adds fixed status runners and the isolated Codex artifact runner", () => {
    const prepared = withKmacRunners(base, options);
    expect(prepared.resources[0]?.statusRunnerId).toBe("kmac-status-v1");
    expect(prepared.resources[0]?.githubStatusRunnerId).toBe("kmac-github-status-v1");
    expect(prepared.artifactRoot).toBe("/opt/agentlink/state/mesh-workspaces");
    expect(prepared.runners).toHaveLength(3);
    expect(prepared.runners?.[0]).toMatchObject({
      id: "kmac-status-v1",
      resourceId: "workspace:kmac-m4",
      purpose: "status",
      approvalRequired: false,
      allowDynamicArgs: false,
      allowInput: false,
      workspaceCapabilities: ["read-only-status"],
    });
    expect(prepared.runners?.[0]?.fixedArgs).toEqual([options.statusScript]);
    expect(prepared.runners?.[0]?.resultSchema).toMatchObject({
      required: expect.arrayContaining(["remoteCodexControl"]),
    });
    expect(prepared.runners?.[1]).toMatchObject({
      id: "kmac-github-status-v1",
      resourceId: "workspace:kmac-m4",
      purpose: "status",
      approvalRequired: false,
      allowDynamicArgs: false,
      allowInput: false,
      fixedArgs: ["/opt/agentlink/releases/release/deploy/kmac-github-status.ts"],
      env: {
        HOME: expect.any(String),
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
      resultSchema: {
        additionalProperties: false,
        required: ["status", "login", "source", "checkedAt"],
      },
      workspaceCapabilities: ["read-only-status"],
    });
    expect(JSON.stringify(prepared.runners?.[1])).not.toContain("GH_TOKEN");
    expect(JSON.stringify(prepared.runners?.[1])).not.toContain("GITHUB_TOKEN");
    expect(prepared.runners?.[2]).toMatchObject({
      id: CODEX_TASK_RUNNER_ID,
      resourceId: "workspace:kmac-m4",
      purpose: "task",
      executable: options.codexLauncher,
      fixedArgs: [...CODEX_TASK_FIXED_ARGS],
      workdir: ".",
      maxRuntimeMs: 900_000,
      maxOutputBytes: 262_144,
      approvalRequired: true,
      allowDynamicArgs: false,
      allowInput: true,
      workspaceCapabilities: [...CODEX_TASK_WORKSPACE_CAPABILITIES],
      exposeDebugOutput: false,
    });
  });

  test("is idempotent and preserves existing policy", () => {
    const once = withKmacRunners(base, options);
    const twice = withKmacRunners(once, options);
    expect(twice).toEqual(once);
    expect(twice.groups).toEqual(base.groups);
    expect(twice.requesters).toEqual(base.requesters);
    expect(twice.remoteCodexControl).toBe(true);
  });

  test("preserves a disabled Codex policy in the generated candidate", () => {
    const disabled = parseMeshConfig({ ...base, remoteCodexControl: false });
    const prepared = withKmacRunners(disabled, options);
    expect(prepared.remoteCodexControl).toBe(false);

    const optedIn = withKmacRunners(disabled, {
      ...options,
      enableRemoteCodexControl: true,
    });
    expect(optedIn.remoteCodexControl).toBe(true);
  });

  test("rejects an artifact workspace that overlaps the registered checkout", () => {
    expect(() => withKmacRunners(base, {
      ...options,
      stateDir: "/tmp/kmac-workspace/state",
    })).toThrow("must be isolated");
  });

  test("removes its temporary candidate when atomic publication fails", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "argus-kmac-config-publish-"));
    tempRoots.push(testRoot);
    const input = join(testRoot, "input.json");
    const output = join(testRoot, "mesh.json");
    writeFileSync(input, `${JSON.stringify(base)}\n`, { mode: 0o600 });
    mkdirSync(output);

    const result = spawnSync(process.execPath, [
      join(import.meta.dir, "../deploy/prepare-kmac-mesh-config.ts"),
      "--input", input,
      "--output", output,
      "--runtime-bun", options.runtimeBun,
      "--status-script", options.statusScript,
      "--state-dir", join(testRoot, "state"),
      "--codex-launcher", options.codexLauncher,
    ], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
    expect(readdirSync(testRoot).sort()).toEqual(["input.json", "mesh.json"]);
    expect(readdirSync(output)).toEqual([]);
  });

  test("executes the configured Codex runner only in its artifact workspace and captures changed/deleted files", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "argus-kmac-codex-runner-"));
    tempRoots.push(testRoot);
    const checkout = join(testRoot, "checkout");
    const stateDir = join(testRoot, "state");
    const artifactRoot = join(stateDir, "mesh-workspaces");
    const codexStub = join(testRoot, "codex-stub.ts");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "sentinel.txt"), "existing checkout\n");
    writeFileSync(codexStub, `#!${process.execPath}\n`
      + `import { readFileSync, rmSync, writeFileSync } from "node:fs";\n`
      + `const expected = ${JSON.stringify([...CODEX_TASK_FIXED_ARGS])};\n`
      + `if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(21);\n`
      + `const prompt = await Bun.stdin.text();\n`
      + `if (prompt !== "update the artifact") process.exit(22);\n`
      + `if (readFileSync("src/input.txt", "utf8") !== "before\\n") process.exit(23);\n`
      + `writeFileSync("src/input.txt", "after\\n");\n`
      + `rmSync("remove.txt");\n`
      + `writeFileSync("created.txt", "created\\n");\n`
      + `console.log(JSON.stringify({ resultSummary: "updated artifact" }));\n`);
    chmodSync(codexStub, 0o700);

    const localBase = parseMeshConfig({
      ...base,
      allowedRoots: [checkout],
      artifactRoot,
      resources: [{ ...base.resources[0]!, root: checkout }],
    });
    const prepared = withKmacRunners(localBase, {
      ...options,
      runtimeBun: process.execPath,
      codexLauncher: codexStub,
      githubHome: testRoot,
      stateDir,
    });
    const service = new MeshService({
      nodeId: "node-b",
      trustedGroups: new Set(["group-alpha"]),
      groupMembers: new Map([["group-alpha", new Set(["node-a", "node-b"])]]),
      trustedRequesters: new Set(["node-a"]),
      allowedRoots: prepared.allowedRoots,
      artifactRoot: prepared.artifactRoot,
      quarantineRoot: join(testRoot, "quarantine"),
      resources: prepared.resources,
      runners: prepared.runners,
      taskStore: new MeshTaskStore(join(testRoot, "tasks.json")),
      signingKey: generateMeshSigningKeyPair(),
      auditSink: () => {},
    });
    const baseArtifact = artifact([
      artifactFile("src/input.txt", "before\n"),
      artifactFile("remove.txt", "remove\n"),
    ]);
    const task = {
      groupId: "group-alpha",
      taskId: "task-kmac-codex-artifact",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      resourceId: "workspace:kmac-m4",
      operation: "run" as const,
      scope: {
        runnerId: CODEX_TASK_RUNNER_ID,
        args: [],
        input: "update the artifact",
        baseArtifactId: baseArtifact.artifactId,
      },
    };
    const proposal = service.proposeTask({ kind: "mesh-task-request", task, baseArtifact });
    expect(proposal.status).toBe("approval-required");
    const grant = service.issueGrant(task);
    const approval = service.issueApproval(grant, "approve isolated KMac Codex task");
    const completed = await service.handleRequest({
      kind: "mesh-task-request",
      task,
      baseArtifact,
      grant,
      approval,
    });
    expect(completed).toMatchObject({
      status: "completed",
      result: {
        runnerId: CODEX_TASK_RUNNER_ID,
        resultSummary: "updated artifact",
        baseArtifactId: baseArtifact.artifactId,
        changedFiles: 2,
        deletedFiles: 1,
      },
    });
    const codexMetadata = service.listResources()[0]?.runners
      ?.find((runner) => runner.runnerId === CODEX_TASK_RUNNER_ID);
    const requiredResultKeys = (codexMetadata?.resultSchema as { required?: string[] }).required ?? [];
    expect(requiredResultKeys.slice().sort()).toEqual(Object.keys(completed.result ?? {}).sort());
    expect(await Bun.file(join(checkout, "sentinel.txt")).text()).toBe("existing checkout\n");
    expect(await Bun.file(join(checkout, "src", "input.txt")).exists()).toBe(false);

    const result = completed.result as {
      baseArtifactId: string;
      resultArtifactId: string;
      resultArtifactSha256: string;
    };
    expect(result.resultArtifactId).toBe(`sha256:${result.resultArtifactSha256}`);
    const delivered = service.resultArtifact({
      kind: "mesh-artifact-request",
      requestId: "artifact-kmac-codex-result",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: task.taskId,
      artifactId: result.resultArtifactId,
    });
    expect(delivered.manifest).toMatchObject({
      artifactId: result.resultArtifactId,
      sha256: result.resultArtifactSha256,
      baseArtifactId: baseArtifact.artifactId,
      taskId: task.taskId,
    });
    expect(delivered.manifest.changed.map((file) => file.path)).toEqual(["created.txt", "src/input.txt"]);
    expect(delivered.manifest.deleted).toEqual(["remove.txt"]);
    const taskArtifactRoot = join(artifactRoot, task.taskId);
    expect(existsSync(join(taskArtifactRoot, "workspace"))).toBe(false);
    expect(readdirSync(taskArtifactRoot).sort()).toEqual(["base.json", "result.json"]);
    expect(() => service.resultArtifact({
      kind: "mesh-artifact-request",
      requestId: "artifact-kmac-codex-cross-task",
      requesterNodeId: "node-a",
      targetNodeId: "node-b",
      taskId: "task-kmac-codex-other",
      artifactId: result.resultArtifactId,
    })).toThrow("目标设备没有该任务的 result artifact");
  });
});

function artifactFile(path: string, content: string): MeshArtifactFile {
  const bytes = Buffer.from(content, "utf8");
  return {
    type: "file",
    path,
    mode: 0o644,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

function artifact(files: MeshArtifactFile[]): MeshBaseArtifactManifest {
  const identity = { version: 1 as const, kind: "base" as const, files };
  const sha256 = meshArtifactSha256(identity);
  return { ...identity, artifactId: `sha256:${sha256}`, sha256 };
}
