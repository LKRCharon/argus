import {
  MeshWorkspaceStatusSchema,
  type MeshResourceStatus,
} from "@agentlink/wire";

export function parseWorkspaceStatus(stdout: string, observedAt: string): MeshResourceStatus {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return failedWorkspaceStatus("workspace status runner returned invalid JSON", observedAt);
  }
  const parsed = MeshWorkspaceStatusSchema.safeParse(value);
  if (!parsed.success) {
    return failedWorkspaceStatus("workspace status runner returned an invalid shape", observedAt);
  }
  const status = parsed.data;
  const ready = status.connectionStatus === "online"
    && status.watcherAvailable
    && status.codexAppServerAvailable;
  return {
    state: ready ? "ready" : status.connectionStatus === "offline" ? "error" : "degraded",
    summary: ready ? "workspace ready" : "workspace control path degraded",
    observedAt,
    workspace: status,
    ...(!ready ? { error: "workspace status is not fully ready" } : {}),
  };
}

export function failedWorkspaceStatus(message: string, observedAt: string): MeshResourceStatus {
  return {
    state: "error",
    summary: "workspace status unavailable",
    observedAt,
    error: message.slice(0, 512),
  };
}
