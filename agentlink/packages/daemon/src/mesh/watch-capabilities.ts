import { MeshRequestIdSchema, MeshThreadIdSchema } from "@agentlink/wire";

export interface MeshWatchCapabilities {
  legacyAgentBridge: boolean;
  remoteCodexControl: boolean;
}

export const MAX_REMOTE_CODEX_DEADLINE_MS = 2 * 60_000;
export const REMOTE_CODEX_POLICY_DISABLED_MESSAGE = "remote Codex control is disabled by Mesh policy";

interface RemoteCodexCommandPayload {
  kind?: string;
  agent?: string;
  requestId?: string;
  controlRequestId?: string;
  deadlineAt?: number;
  forkFromSessionId?: string;
}

export interface NormalizedRemoteCodexCommand extends RemoteCodexCommandPayload {
  kind: string;
  controlRequestId: string;
  deadlineAt: number;
}

export type RemoteCodexCommandValidation =
  | { status: "valid"; command: NormalizedRemoteCodexCommand }
  | { status: "expired"; command: NormalizedRemoteCodexCommand }
  | { status: "invalid" };

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

export function validateBoundedRemoteCodexCommand(
  payload: RemoteCodexCommandPayload,
  now = Date.now(),
): RemoteCodexCommandValidation {
  const controlRequestId = MeshRequestIdSchema.safeParse(payload.controlRequestId);
  if (!controlRequestId.success || !Number.isSafeInteger(payload.deadlineAt)) return { status: "invalid" };

  const kind = payload.kind ?? "";
  let requestId: string | undefined;
  let forkFromSessionId: string | undefined;
  const isDirectCodex = [
    "codex-threads",
    "codex-resume",
    "codex-history-cancel",
    "codex-input",
    "codex-interrupt",
  ].includes(kind);
  if (!isDirectCodex && kind === "new-session" && payload.agent !== "codex") return { status: "invalid" };
  if (Object.hasOwn(payload, "forkFromSessionId")) {
    if (kind !== "new-session" || payload.agent !== "codex") return { status: "invalid" };
    const parsedForkSource = MeshThreadIdSchema.safeParse(payload.forkFromSessionId);
    if (!parsedForkSource.success) return { status: "invalid" };
    forkFromSessionId = parsedForkSource.data;
  }
  if (!isDirectCodex && kind === "permission-response") {
    const parsedRequestId = MeshRequestIdSchema.safeParse(payload.requestId);
    if (!parsedRequestId.success || !parsedRequestId.data.startsWith("codex-")) return { status: "invalid" };
    requestId = parsedRequestId.data;
  } else if (!isDirectCodex && kind !== "new-session") {
    return { status: "invalid" };
  }

  const deadlineAt = payload.deadlineAt as number;
  if (deadlineAt > now + MAX_REMOTE_CODEX_DEADLINE_MS) return { status: "invalid" };
  const command: NormalizedRemoteCodexCommand = {
    ...payload,
    kind,
    controlRequestId: controlRequestId.data,
    deadlineAt,
    ...(requestId ? { requestId } : {}),
    ...(forkFromSessionId ? { forkFromSessionId } : {}),
  };
  return deadlineAt <= now ? { status: "expired", command } : { status: "valid", command };
}

export function isBoundedRemoteCodexCommand(payload: RemoteCodexCommandPayload, now = Date.now()): boolean {
  return validateBoundedRemoteCodexCommand(payload, now).status === "valid";
}

/**
 * Correlated, fail-closed response for a valid command refused by local policy.
 * Keep this separate from the legacy Mesh error so controllers can finish the
 * exact Codex operation instead of waiting for its watcher deadline.
 */
export function remoteCodexPolicyDisabledReply(
  command: Pick<NormalizedRemoteCodexCommand, "controlRequestId">,
): Record<string, unknown> {
  return {
    kind: "codex-error",
    code: "remote-codex-control-disabled",
    note: REMOTE_CODEX_POLICY_DISABLED_MESSAGE,
    timedOut: false,
    timedOutStage: "watcher",
    retryable: false,
    controlRequestId: command.controlRequestId,
  };
}
