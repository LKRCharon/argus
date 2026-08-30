import { describe, expect, test } from "bun:test";
import {
  countActiveJobs,
  deriveWorkspaceStatus,
  launchctlStateIsRunning,
  readRemoteCodexControl,
} from "../deploy/kmac-workspace-status";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checkedAt = "2026-08-30T03:00:00.000Z";

describe("KMac workspace status", () => {
  test("does not treat a loaded but stopped launchd job as running", () => {
    expect(launchctlStateIsRunning([
      "gui/501/com.kairong.agentlink-watch = {",
      "\tpath = /Users/kairong/Library/LaunchAgents/com.kairong.agentlink-watch.plist",
      "\tstate = exited",
      "}",
    ].join("\n"))).toBe(false);
    expect(launchctlStateIsRunning("state = running\n")).toBe(true);
    expect(launchctlStateIsRunning(`${"x".repeat(16 * 1024)}\nstate = running\n`)).toBe(false);
  });

  test("emits the exact ready workspace contract", () => {
    const status = deriveWorkspaceStatus({
      watcherAvailable: true,
      relayAvailable: true,
      codexAppServerAvailable: true,
      remoteCodexControl: true,
      activeJobs: 2,
      taskJournalValid: true,
      workspaceRevision: "a".repeat(40),
      checkedAt,
    });

    expect(status).toEqual({
      connectionStatus: "online",
      watcherAvailable: true,
      codexAppServerAvailable: true,
      remoteCodexControl: true,
      activeJobs: 2,
      workspaceRevision: "a".repeat(40),
      lastSuccess: checkedAt,
      lastErrorStage: null,
      checkedAt,
    });
    expect(Object.keys(status).sort()).toEqual([
      "activeJobs",
      "checkedAt",
      "codexAppServerAvailable",
      "connectionStatus",
      "lastErrorStage",
      "lastSuccess",
      "remoteCodexControl",
      "watcherAvailable",
      "workspaceRevision",
    ]);
  });

  test("reports bounded failure stages without diagnostic text", () => {
    const status = deriveWorkspaceStatus({
      watcherAvailable: true,
      relayAvailable: false,
      codexAppServerAvailable: false,
      remoteCodexControl: false,
      activeJobs: 0,
      taskJournalValid: false,
      workspaceRevision: null,
      checkedAt,
    });

    expect(status).toMatchObject({
      connectionStatus: "degraded",
      lastSuccess: null,
      lastErrorStage: "relay",
    });
    expect(JSON.stringify(status)).not.toContain("path");
    expect(JSON.stringify(status)).not.toContain("error");
  });

  test("counts only non-terminal durable task states", () => {
    expect(countActiveJobs({
      version: 1,
      tasks: [
        { status: "received" },
        { status: "approval-required" },
        { status: "queued" },
        { status: "running" },
        { status: "completed" },
        { status: "denied" },
        { status: "failed" },
        { status: "cancelled" },
      ],
    })).toBe(4);
    expect(() => countActiveJobs({ version: 1, tasks: [{ status: "unknown" }] })).toThrow();
  });

  test("reads remote Codex policy from the typed Mesh config and fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-kmac-policy-"));
    try {
      writeFileSync(join(root, "mesh.json"), JSON.stringify({
        version: 1,
        groups: [{ id: "group-alpha", members: ["node-a"] }],
        resources: [],
        remoteCodexControl: true,
      }));
      expect(readRemoteCodexControl(root)).toBe(true);
      writeFileSync(join(root, "mesh.json"), "{invalid");
      expect(readRemoteCodexControl(root)).toBe(false);
      rmSync(join(root, "mesh.json"));
      expect(readRemoteCodexControl(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
