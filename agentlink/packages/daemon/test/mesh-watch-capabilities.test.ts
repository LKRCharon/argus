import { describe, expect, test } from "bun:test";
import { parseMeshConfig } from "../src/mesh/config";
import { isBoundedRemoteCodexCommand, meshWatchCapabilities } from "../src/mesh/watch-capabilities";

const config = (legacyControl?: boolean, remoteCodexControl?: boolean) => parseMeshConfig({
  version: 1,
  groups: [{ id: "group-alpha", members: ["node-a"] }],
  resources: [],
  ...(legacyControl === undefined ? {} : { legacyControl }),
  ...(remoteCodexControl === undefined ? {} : { remoteCodexControl }),
});

describe("strict Mesh watch capabilities", () => {
  test("defaults both independent capabilities off and preserves every combination", () => {
    expect(config()).toMatchObject({ legacyControl: false, remoteCodexControl: false });
    for (const [legacy, codex] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const parsed = config(legacy, codex);
      expect(parsed).toMatchObject({ legacyControl: legacy, remoteCodexControl: codex });
      expect(meshWatchCapabilities(true, parsed.legacyControl, parsed.remoteCodexControl)).toEqual({
        legacyAgentBridge: legacy,
        remoteCodexControl: legacy || codex,
      });
    }
  });

  test("remote Codex capability accepts only bounded Codex commands and approvals", () => {
    const bounded = { controlRequestId: "codex:request-1", deadlineAt: Date.now() + 1_000 };
    for (const kind of ["codex-threads", "codex-resume", "codex-history-cancel", "codex-input", "codex-interrupt"]) {
      expect(isBoundedRemoteCodexCommand({ ...bounded, kind })).toBe(true);
    }
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "new-session", agent: "codex" })).toBe(true);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "permission-response", requestId: "codex-approval-1" })).toBe(true);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "new-session", agent: "qoder" })).toBe(false);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "permission-response", requestId: "acp-approval-1" })).toBe(false);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "list-sessions" })).toBe(false);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "remote-control" })).toBe(false);
    expect(isBoundedRemoteCodexCommand({ kind: "codex-input" })).toBe(false);
  });
});
