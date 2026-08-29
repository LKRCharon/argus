import { appendFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MeshAuditEvent } from "@agentlink/wire";
import { configDir } from "../store";

const MAX_AUDIT_BYTES = 10 * 1024 * 1024;

export function meshAuditPath(): string {
  return join(configDir(), "mesh-audit.jsonl");
}

/** Append only redacted policy events; never write grants, approvals, paths, or secrets. */
export function appendMeshAuditEvent(event: MeshAuditEvent, file = meshAuditPath()): void {
  if (process.platform !== "win32" && existsSync(file) && (statSync(file).mode & 0o077) !== 0) {
    throw new Error("Mesh 审计文件权限过宽，请设置为 0600");
  }
  const line = JSON.stringify(event) + "\n";
  const currentBytes = existsSync(file) ? statSync(file).size : 0;
  if (currentBytes + Buffer.byteLength(line, "utf8") > MAX_AUDIT_BYTES) {
    throw new Error("Mesh 审计文件已达到大小上限");
  }
  appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}
