import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseMeshConfig } from "../src/mesh/config";

function config(unattendedRuns?: unknown): unknown {
  return {
    version: 1,
    groups: [{ id: "group-alpha", members: ["node-a", "node-b"] }],
    requesters: ["node-a"],
    resources: [{
      id: "workspace:fixture",
      ownerNodeId: "node-b",
      kind: "directory",
      displayName: "fixture",
      root: resolve("workspace"),
    }],
    runners: [{
      id: "fixture:runner",
      resourceId: "workspace:fixture",
      purpose: "task",
      executable: process.execPath,
    }],
    ...(unattendedRuns === undefined ? {} : { unattendedRuns }),
  };
}

describe("Mesh unattended run config", () => {
  test("accepts only the four exact non-empty typed allowlists", () => {
    const policy = {
      groupIds: ["group-alpha"],
      requesterNodeIds: ["node-a"],
      resourceIds: ["workspace:fixture"],
      runnerIds: ["fixture:runner"],
    };
    expect(parseMeshConfig(config(policy)).unattendedRuns).toEqual(policy);
    expect(() => parseMeshConfig(config({ ...policy, extra: ["wildcard"] }))).toThrow("Mesh 配置格式无效");

    for (const key of Object.keys(policy)) {
      expect(() => parseMeshConfig(config({ ...policy, [key]: [] }))).toThrow("Mesh 配置格式无效");
      expect(() => parseMeshConfig(config({ ...policy, [key]: Array(65).fill("bounded-id") })))
        .toThrow("Mesh 配置格式无效");
    }
  });
});
