import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMeshSigningKeyPair } from "@agentlink/wire";
import { MeshService } from "../src/mesh/service";

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
  test("handles read-only inspect without exposing local paths", () => {
    const { value } = service();
    const result = value.handle({ kind: "mesh-task-request", task: task("inspect") });
    expect(result).toMatchObject({ kind: "mesh-task-result", status: "completed", operation: "inspect" });
    expect(JSON.stringify(result)).not.toContain("/repo");
  });

  test("requires a grant and owner approval before quarantine, then moves safely", () => {
    const { value, root } = service();
    const request = task("quarantine");
    const grant = value.issueGrant(request);
    const pending = value.handle({ kind: "mesh-task-request", task: request, grant });
    expect(pending).toMatchObject({ status: "approval-required", decision: "approval-required" });

    const approval = value.issueApproval(grant, "quarantine the exact repo after review");
    const completed = value.handle({ kind: "mesh-task-request", task: request, grant, approval });
    expect(completed).toMatchObject({ status: "completed", decision: "allow" });
    expect(existsSync(root)).toBe(false);
  });

  test("does not accept arbitrary remote cwd/command payloads", () => {
    const { value } = service();
    expect(value.handle({
      kind: "mesh-task-request",
      task: { ...task("inspect"), scope: { cwd: "/etc", argv: ["rm", "-rf", "/"] } },
    })).toMatchObject({ status: "completed", operation: "inspect" });
    expect(value.handle({ kind: "not-a-mesh-command", cwd: "/etc", command: "rm -rf /" })).toBeUndefined();
  });
});
