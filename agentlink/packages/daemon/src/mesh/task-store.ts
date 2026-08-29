/**
 * Small durable Mesh task journal.
 *
 * It stores task identity, lifecycle, and the already-redacted result only;
 * grants, approvals, scopes, executable paths, and secrets never enter this
 * file. A restart can therefore return a completed result idempotently instead
 * of executing the same task a second time.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  MeshIdSchema,
  MeshOperationSchema,
  MeshTaskResultPayloadSchema,
  MeshTimestampSchema,
  stableStringify,
  type MeshTaskRequest,
  type MeshTaskResultPayload,
} from "@agentlink/wire";
import { configDir } from "../store";

const FILE_VERSION = 1;
const MAX_RECORDS = 1_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const MeshTaskLifecycleStatusSchema = z.enum([
  "received", "approval-required", "queued", "running", "completed", "denied", "failed", "cancelled",
]);
export type MeshTaskLifecycleStatus = z.infer<typeof MeshTaskLifecycleStatusSchema>;

const MeshTaskRecordSchema = z.object({
  version: z.literal(FILE_VERSION),
  taskId: MeshIdSchema,
  groupId: MeshIdSchema,
  requesterNodeId: MeshIdSchema,
  targetNodeId: MeshIdSchema,
  resourceId: MeshIdSchema,
  operation: MeshOperationSchema,
  requestDigest: z.string().length(64),
  status: MeshTaskLifecycleStatusSchema,
  message: z.string().optional(),
  result: MeshTaskResultPayloadSchema.optional(),
  createdAt: MeshTimestampSchema,
  updatedAt: MeshTimestampSchema,
});

const MeshTaskJournalSchema = z.object({
  version: z.literal(FILE_VERSION),
  tasks: z.array(MeshTaskRecordSchema).max(MAX_RECORDS),
});

export type MeshTaskRecord = z.infer<typeof MeshTaskRecordSchema>;

export function meshTaskStorePath(): string {
  return join(configDir(), "mesh-tasks.json");
}

export function meshTaskDigest(task: MeshTaskRequest): string {
  return createHash("sha256").update(stableStringify(task), "utf8").digest("hex");
}

export interface MeshTaskBeginResult {
  record: MeshTaskRecord;
  created: boolean;
  conflict: boolean;
}

export class MeshTaskStore {
  private readonly records = new Map<string, MeshTaskRecord>();

  constructor(private readonly file = meshTaskStorePath()) {
    this.load();
  }

  get(taskId: string): MeshTaskRecord | undefined {
    const record = this.records.get(taskId);
    return record ? { ...record } : undefined;
  }

  list(limit = 100): MeshTaskRecord[] {
    return [...this.records.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, MAX_RECORDS)))
      .map((record) => ({ ...record }));
  }

  begin(task: MeshTaskRequest): MeshTaskBeginResult {
    const digest = meshTaskDigest(task);
    const existing = this.records.get(task.taskId);
    if (existing) {
      return { record: { ...existing }, created: false, conflict: existing.requestDigest !== digest };
    }
    const now = new Date().toISOString();
    const record: MeshTaskRecord = {
      version: FILE_VERSION,
      taskId: task.taskId,
      groupId: task.groupId,
      requesterNodeId: task.requesterNodeId,
      targetNodeId: task.targetNodeId,
      resourceId: task.resourceId,
      operation: task.operation,
      requestDigest: digest,
      status: "received",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(task.taskId, record);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(task.taskId);
      throw error;
    }
    return { record: { ...record }, created: true, conflict: false };
  }

  update(
    taskId: string,
    patch: Partial<Pick<MeshTaskRecord, "status" | "message" | "result">>,
  ): MeshTaskRecord {
    const current = this.records.get(taskId);
    if (!current) throw new Error("Mesh task 不存在");
    const next: MeshTaskRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(taskId, next);
    try {
      this.persist();
    } catch (error) {
      this.records.set(taskId, current);
      throw error;
    }
    return { ...next };
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    if (process.platform !== "win32" && (statSync(this.file).mode & 0o077) !== 0) {
      throw new Error("Mesh task journal 权限过宽，请设置为 0600");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("Mesh task journal 无法读取；为避免重复执行，已停止 Mesh");
    }
    const parsed = MeshTaskJournalSchema.safeParse(value);
    if (!parsed.success) throw new Error("Mesh task journal 格式无效；为避免重复执行，已停止 Mesh");
    for (const record of parsed.data.tasks) this.records.set(record.taskId, record);
  }

  private persist(): void {
    const tasks = [...this.records.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_RECORDS);
    const content = JSON.stringify({ version: FILE_VERSION, tasks }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("Mesh task journal 已达到大小上限");
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}
