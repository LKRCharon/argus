export interface MeshWatchCapabilities {
  legacyAgentBridge: boolean;
  remoteCodexControl: boolean;
}

export function meshWatchCapabilities(
  meshModeEnabled: boolean,
  legacyControl: boolean,
  remoteCodexControl: boolean,
): MeshWatchCapabilities {
  return {
    legacyAgentBridge: !meshModeEnabled || legacyControl,
    remoteCodexControl: !meshModeEnabled || legacyControl || remoteCodexControl,
  };
}

export function isBoundedRemoteCodexCommand(payload: {
  kind?: string;
  agent?: string;
  requestId?: string;
  controlRequestId?: string;
  deadlineAt?: number;
}): boolean {
  if (!payload.controlRequestId || !Number.isSafeInteger(payload.deadlineAt)) return false;
  if (["codex-threads", "codex-resume", "codex-history-cancel", "codex-input", "codex-interrupt"].includes(payload.kind ?? "")) {
    return true;
  }
  if (payload.kind === "new-session") return payload.agent === "codex";
  return payload.kind === "permission-response" && payload.requestId?.startsWith("codex-") === true;
}
