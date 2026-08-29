import { describe, expect, test } from "bun:test";
import { parseMeshConfig } from "../src/mesh/config";
import {
  isBoundedRemoteCodexCommand,
  meshWatchCapabilities,
  validateBoundedRemoteCodexCommand,
} from "../src/mesh/watch-capabilities";

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
    const now = 1_000_000;
    const bounded = { controlRequestId: "codex:request-1", deadlineAt: now + 1_000 };
    for (const kind of ["codex-threads", "codex-resume", "codex-history-cancel", "codex-input", "codex-interrupt"]) {
      expect(isBoundedRemoteCodexCommand({ ...bounded, kind }, now)).toBe(true);
    }
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "new-session", agent: "codex" }, now)).toBe(true);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "permission-response", requestId: "codex-approval-1" }, now)).toBe(true);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "new-session", agent: "qoder" }, now)).toBe(false);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "permission-response", requestId: "acp-approval-1" }, now)).toBe(false);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "list-sessions" }, now)).toBe(false);
    expect(isBoundedRemoteCodexCommand({ ...bounded, kind: "remote-control" }, now)).toBe(false);
    expect(isBoundedRemoteCodexCommand({ kind: "codex-input" }, now)).toBe(false);
  });

  test("normalizes typed correlation ids and fails closed on every deadline boundary", () => {
    const now = 1_000_000;
    const valid = { kind: "codex-input", controlRequestId: "codex:request-1", deadlineAt: now + 1_000 };
    expect(validateBoundedRemoteCodexCommand(valid, now)).toEqual({ status: "valid", command: valid });
    expect(validateBoundedRemoteCodexCommand({ ...valid, controlRequestId: "bad id" }, now).status).toBe("invalid");
    expect(validateBoundedRemoteCodexCommand({ ...valid, deadlineAt: now }, now).status).toBe("expired");
    expect(validateBoundedRemoteCodexCommand({ ...valid, deadlineAt: now + 120_001 }, now).status).toBe("invalid");
    expect(validateBoundedRemoteCodexCommand({ ...valid, deadlineAt: undefined }, now).status).toBe("invalid");
    expect(validateBoundedRemoteCodexCommand({ ...valid, deadlineAt: Number.NaN }, now).status).toBe("invalid");
  });

  test("rejects malformed approval ids, non-Codex sessions, and unrelated legacy commands", () => {
    const now = 1_000_000;
    const bounded = { controlRequestId: "codex:request-1", deadlineAt: now + 1_000 };
    expect(validateBoundedRemoteCodexCommand({ ...bounded, kind: "permission-response", requestId: "codex bad" }, now).status).toBe("invalid");
    expect(validateBoundedRemoteCodexCommand({ ...bounded, kind: "permission-response", requestId: "acp-approval-1" }, now).status).toBe("invalid");
    expect(validateBoundedRemoteCodexCommand({ ...bounded, kind: "new-session", agent: "qoder" }, now).status).toBe("invalid");
    for (const kind of ["list-sessions", "user-input", "remote-control", "cloud-session"]) {
      expect(validateBoundedRemoteCodexCommand({ ...bounded, kind }, now).status).toBe("invalid");
    }
  });
});
