import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshArtifactSha256, type MeshTaskRequest } from "@agentlink/wire";
import { MeshApprovalInbox } from "../src/mesh/approval-inbox";
import { createHostApprovalRequestHandler } from "../src/mesh/approval-server";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function request(taskId = "task-owner-approval"): MeshTaskRequest {
  return {
    taskId,
    groupId: "group-alpha",
    requesterNodeId: "node-seoul",
    targetNodeId: "node-l40",
    resourceId: "gpu:l40",
    operation: "run",
    scope: { runnerId: "gpu:train", args: ["config-a"], timeoutMs: 60_000 },
  };
}

describe("target-local owner approval", () => {
  test("persists typed proposals without signing material and claims once", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-approval-inbox-"));
    roots.push(root);
    const file = join(root, "approvals.json");
    const inbox = new MeshApprovalInbox(file);
    inbox.put(request());

    const recovered = new MeshApprovalInbox(file);
    expect(recovered.listPending()).toEqual([expect.objectContaining({
      taskId: "task-owner-approval",
      runnerId: "gpu:train",
      args: ["config-a"],
      status: "pending",
    })]);
    expect(JSON.stringify(recovered.get("task-owner-approval"))).not.toContain("signature");
    expect(recovered.claim("task-owner-approval")?.status).toBe("processing");
    expect(recovered.claim("task-owner-approval")).toBeUndefined();
    expect(recovered.listPending()).toEqual([]);
  });

  test("preserves a validated base artifact across the local approval handoff", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-approval-artifact-"));
    roots.push(root);
    const identity = { version: 1 as const, kind: "base" as const, files: [] };
    const sha256 = meshArtifactSha256(identity);
    const baseArtifact = { ...identity, artifactId: `sha256:${sha256}`, sha256 };
    const task = {
      ...request("task-owner-artifact"),
      scope: { runnerId: "gpu:train", args: [], baseArtifactId: baseArtifact.artifactId },
    };
    const file = join(root, "approvals.json");
    new MeshApprovalInbox(file).put({ kind: "mesh-task-request", task, baseArtifact });
    expect(new MeshApprovalInbox(file).claim(task.taskId)).toMatchObject({
      task: { taskId: task.taskId },
      baseArtifact: { artifactId: baseArtifact.artifactId },
    });
  });

  test("serves the local UI and rejects cross-origin approval decisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "argus-approval-server-"));
    roots.push(root);
    const dist = join(root, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<html>host approval</html>");
    const inbox = new MeshApprovalInbox(join(root, "approvals.json"));
    inbox.put(request());
    const decisions: string[] = [];
    const handler = createHostApprovalRequestHandler({
      nodeId: "node-l40",
      inbox,
      distDir: dist,
      onDecision: (taskId, decision) => { decisions.push(`${taskId}:${decision}`); },
    });

    const page = await handler(new Request("http://127.0.0.1:8791/host"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("host approval");
    const list = await handler(new Request("http://127.0.0.1:8791/api/approvals"));
    expect(await list.json()).toMatchObject({ nodeId: "node-l40", approvals: [{ taskId: "task-owner-approval" }] });

    const rebound = await handler(new Request("http://approval.evil.example/api/approvals"));
    expect(rebound.status).toBe(403);

    const rejected = await handler(new Request("http://127.0.0.1:8791/api/approvals/task-owner-approval/decision", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ decision: "allow-once" }),
    }));
    expect(rejected.status).toBe(403);
    expect(decisions).toEqual([]);

    const accepted = await handler(new Request("http://127.0.0.1:8791/api/approvals/task-owner-approval/decision", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8791" },
      body: JSON.stringify({ decision: "allow-once" }),
    }));
    expect(accepted.status).toBe(202);
    expect(decisions).toEqual(["task-owner-approval:allow-once"]);

    const oversized = await handler(new Request("http://127.0.0.1:8791/api/approvals/another/decision", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8791" },
      body: JSON.stringify({ decision: "deny", padding: "x".repeat(16 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
  });
});
