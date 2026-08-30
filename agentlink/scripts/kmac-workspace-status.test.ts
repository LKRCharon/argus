import { describe, expect, test } from "bun:test";
import {
  countActiveJobs,
  deriveWorkspaceStatus,
} from "../deploy/kmac-workspace-status";

const checkedAt = "2026-08-30T03:00:00.000Z";

describe("KMac workspace status", () => {
  test("emits the exact ready workspace contract", () => {
    const status = deriveWorkspaceStatus({
      watcherAvailable: true,
      relayAvailable: true,
      codexAppServerAvailable: true,
      activeJobs: 2,
      taskJournalValid: true,
      workspaceRevision: "a".repeat(40),
      checkedAt,
    });

    expect(status).toEqual({
      connectionStatus: "online",
      watcherAvailable: true,
      codexAppServerAvailable: true,
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
      "watcherAvailable",
      "workspaceRevision",
    ]);
  });

  test("reports bounded failure stages without diagnostic text", () => {
    const status = deriveWorkspaceStatus({
      watcherAvailable: true,
      relayAvailable: false,
      codexAppServerAvailable: false,
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
});
