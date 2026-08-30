import { describe, expect, test } from "bun:test";
import { parseMeshConfig } from "../packages/daemon/src/mesh/config";
import { withKmacStatusRunner } from "../deploy/prepare-kmac-mesh-config";

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
  test("adds only a fixed read-only status capability", () => {
    const prepared = withKmacStatusRunner(base, options);
    expect(prepared.resources[0]?.statusRunnerId).toBe("kmac-status-v1");
    expect(prepared.runners).toHaveLength(1);
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
  });

  test("is idempotent and preserves existing policy", () => {
    const once = withKmacStatusRunner(base, options);
    const twice = withKmacStatusRunner(once, options);
    expect(twice).toEqual(once);
    expect(twice.groups).toEqual(base.groups);
    expect(twice.requesters).toEqual(base.requesters);
    expect(twice.remoteCodexControl).toBe(true);
  });
});
