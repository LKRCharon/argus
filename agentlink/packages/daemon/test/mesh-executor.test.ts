import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshExecutor, type MeshTaskLike } from "../src/mesh/executor";

const cleanup: string[] = [];

afterAll(() => {
  // The test runner owns these temporary trees. Keep cleanup intentionally
  // narrow and recoverable; never use a broad recursive shell command here.
  for (const path of cleanup.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort only; the OS temp directory will reap leftovers.
    }
  }
});

function fixture(): { root: string; quarantine: string } {
  const base = mkdtempSync(join(tmpdir(), "argus-mesh-"));
  const root = join(base, "repo");
  const quarantine = join(base, "quarantine");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "mesh fixture\n");
  cleanup.push(base);
  return { root, quarantine };
}

function task(operation: MeshTaskLike["operation"], resourceId = "repo:fixture"): MeshTaskLike {
  return {
    taskId: "task-1",
    requesterNodeId: "node-a",
    targetNodeId: "node-b",
    resourceId,
    operation,
  };
}

describe.serial("MeshExecutor", () => {
  test("requires registered resources to live under allowed roots", () => {
    const { root, quarantine } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "argus-mesh-outside-"));
    cleanup.push(outside);
    const executor = new MeshExecutor({ allowedRoots: [root], quarantineRoot: quarantine });
    expect(() => executor.registerResource({
      id: "repo:outside",
      ownerNodeId: "node-b",
      kind: "repo",
      displayName: "outside",
      root: outside,
    })).toThrow(/允许的资源根目录/);
  });

  test("does not follow symlinks while previewing", () => {
    const { root, quarantine } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "argus-mesh-link-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "secret.txt"), "not part of the repo\n");
    symlinkSync(outside, join(root, "linked-outside"));
    const executor = new MeshExecutor({ allowedRoots: [root], quarantineRoot: quarantine });
    executor.registerResource({ id: "repo:fixture", ownerNodeId: "node-b", kind: "repo", displayName: "fixture", root });
    const preview = executor.preview("repo:fixture");
    expect(preview.entryCount).toBe(2);
    expect(preview.bytes).toBeGreaterThan(0);
  });

  test("hard delete and arbitrary shell are not executable", () => {
    const { root, quarantine } = fixture();
    const executor = new MeshExecutor({ allowedRoots: [root], quarantineRoot: quarantine });
    executor.registerResource({ id: "repo:fixture", ownerNodeId: "node-b", kind: "repo", displayName: "fixture", root });
    for (const operation of ["delete", "arbitrary-shell", "sudo", "secret-read"] as const) {
      expect(() => executor.execute(task(operation), {
        allowed: true,
        resourceId: "repo:fixture",
        operation,
        taskId: "task-1",
      })).toThrow();
    }
    expect(existsSync(root)).toBe(true);
  });

  test("quarantine moves the resource and writes a recovery manifest", () => {
    const { root, quarantine } = fixture();
    const executor = new MeshExecutor({ allowedRoots: [root], quarantineRoot: quarantine });
    executor.registerResource({ id: "repo:fixture", ownerNodeId: "node-b", kind: "repo", displayName: "fixture", root });
    const result = executor.execute(task("quarantine"), {
      allowed: true,
      resourceId: "repo:fixture",
      operation: "quarantine",
      taskId: "task-1",
      grantId: "grant-1",
    });
    if (!("quarantinePath" in result)) throw new Error("expected quarantine result");
    const quarantinePath = result.quarantinePath;
    const manifestPath = result.manifestPath;
    expect(result).toMatchObject({ resourceId: "repo:fixture", quarantinePath: expect.any(String) });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ resourceId: "repo:fixture", taskId: "task-1", version: 1 });
  });

  test("permit must match the typed task", () => {
    const { root, quarantine } = fixture();
    const executor = new MeshExecutor({ allowedRoots: [root], quarantineRoot: quarantine });
    executor.registerResource({ id: "repo:fixture", ownerNodeId: "node-b", kind: "repo", displayName: "fixture", root });
    expect(() => executor.execute(task("inspect"), {
      allowed: true,
      resourceId: "repo:fixture",
      operation: "quarantine",
      taskId: "task-1",
    })).toThrow(/不匹配/);
  });
});
