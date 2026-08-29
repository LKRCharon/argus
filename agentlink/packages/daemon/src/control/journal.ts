import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../store";
import {
  MeshGroupIdSchema,
  MeshIdempotencyKeySchema,
  MeshNodeIdSchema,
  MeshOperationSchema,
  MeshResourceIdSchema,
  MeshTaskIdSchema,
} from "@agentlink/wire";
import { sanitizeTaskResultOutputs } from "../mesh/output-sanitizer";

const MAX_RECORDS = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CONTROL_TASK_STATUSES = new Set<ControlTaskStatus>([
  "queued",
  "running",
  "completed",
  "denied",
  "approval-required",
  "failed",
  "cancelled",
]);

export type ControlTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "denied"
  | "approval-required"
  | "failed"
  | "cancelled";

export interface ControlTaskRecord {
  taskId: string;
  requesterNodeId?: string;
  groupId: string;
  targetNodeId: string;
  resourceId: string;
  operation: string;
  /** Stable digest of the complete typed request envelope for idempotency. */
  requestDigest?: string;
  idempotencyKey?: string;
  idempotencyDigest?: string;
  status: ControlTaskStatus;
  decision?: string;
  message?: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ControlTaskListQuery {
  targetNodeId?: string;
  resourceId?: string;
  groupId?: string;
  status?: ControlTaskStatus;
  createdAfter?: number;
  limit?: number;
  cursor?: string;
}

export interface ControlTaskPage {
  tasks: ControlTaskRecord[];
  nextCursor?: string;
}

/**
 * Seoul's dashboard journal contains task metadata and results, never node
 * private keys or raw relay frames. Writes are atomic so a stopped dashboard
 * cannot leave a half-written task list behind.
 */
export class ControlTaskJournal {
  private readonly file: string;
  private records: ControlTaskRecord[];

  constructor(file = process.env.ARGUS_CONTROL_TASKS?.trim() || join(configDir(), "control-tasks.json")) {
    this.file = file;
    this.records = this.read();
  }

  list(limit = 100): ControlTaskRecord[] {
    return [...this.records]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, MAX_RECORDS)))
      .map((record) => structuredClone(record));
  }

  listVisible(requesterNodeId: string, query: ControlTaskListQuery = {}): ControlTaskPage {
    const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 50), 100));
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = this.records
      .filter((record) => !record.requesterNodeId || record.requesterNodeId === requesterNodeId)
      .filter((record) => !query.targetNodeId || record.targetNodeId === query.targetNodeId)
      .filter((record) => !query.resourceId || record.resourceId === query.resourceId)
      .filter((record) => !query.groupId || record.groupId === query.groupId)
      .filter((record) => !query.status || record.status === query.status)
      .filter((record) => query.createdAfter === undefined || record.createdAt > query.createdAfter!)
      .sort((left, right) => right.createdAt - left.createdAt || compareId(right.taskId, left.taskId))
      .filter((record) => !cursor
        || record.createdAt < cursor.createdAt
        || (record.createdAt === cursor.createdAt && compareId(record.taskId, cursor.taskId) < 0));
    const tasks = rows.slice(0, limit);
    const last = tasks.at(-1);
    return {
      tasks: tasks.map((record) => structuredClone(record)),
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({ createdAt: last.createdAt, taskId: last.taskId }) }
        : {}),
    };
  }

  get(taskId: string): ControlTaskRecord | undefined {
    const record = this.records.find((item) => item.taskId === taskId);
    return record ? structuredClone(record) : undefined;
  }

  findByIdempotencyKey(requesterNodeId: string, idempotencyKey: string): ControlTaskRecord | undefined {
    const record = this.records.find((item) => item.idempotencyKey === idempotencyKey
      && (!item.requesterNodeId || item.requesterNodeId === requesterNodeId));
    return record ? structuredClone(record) : undefined;
  }

  create(record: ControlTaskRecord): ControlTaskRecord {
    const safeRecord = record.result === undefined
      ? record
      : { ...record, result: sanitizeTaskResultOutputs(record.result) };
    if (!isTaskRecord(safeRecord)) throw new Error("control task journal record is invalid");
    const existing = this.records.find((item) => item.taskId === safeRecord.taskId);
    if (existing) {
      if (existing.requestDigest !== safeRecord.requestDigest) throw new Error("control task journal task id conflict");
      return structuredClone(existing);
    }
    if (this.records.length >= MAX_RECORDS) {
      throw new Error("control task journal reached its replay limit");
    }
    const previous = this.records;
    this.records = [structuredClone(safeRecord), ...this.records];
    try {
      this.write();
    } catch (error) {
      this.records = previous;
      throw error;
    }
    return structuredClone(safeRecord);
  }

  update(taskId: string, patch: Partial<Omit<ControlTaskRecord, "taskId" | "createdAt">>): ControlTaskRecord | undefined {
    const index = this.records.findIndex((record) => record.taskId === taskId);
    if (index < 0) return undefined;
    const previous = this.records[index];
    const safePatch = patch.result === undefined
      ? patch
      : { ...patch, result: sanitizeTaskResultOutputs(patch.result) };
    const next = { ...previous, ...safePatch, updatedAt: Date.now() };
    if (!isTaskRecord(next)) throw new Error("control task journal update is invalid");
    this.records[index] = next;
    try {
      this.write();
    } catch (error) {
      this.records[index] = previous;
      throw error;
    }
    return structuredClone(next);
  }

  private read(): ControlTaskRecord[] {
    if (!existsSync(this.file)) return [];
    const info = statSync(this.file);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("control task journal permissions are too broad");
    }
    if (info.size > MAX_FILE_BYTES) throw new Error("control task journal exceeds its size limit");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    } catch {
      throw new Error("control task journal is unreadable; submissions stopped to avoid replay");
    }
    if (!Array.isArray(value) || value.length > MAX_RECORDS || value.some((record) => !isTaskRecord(record))) {
      throw new Error("control task journal is invalid; submissions stopped to avoid replay");
    }
    const records = value as ControlTaskRecord[];
    const taskIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const record of records) {
      if (taskIds.has(record.taskId)) {
        throw new Error("control task journal has duplicate task ids; submissions stopped to avoid replay");
      }
      taskIds.add(record.taskId);
      if (record.idempotencyKey) {
        const identity = `${record.requesterNodeId ?? "legacy"}\u0000${record.idempotencyKey}`;
        if (idempotencyKeys.has(identity)) {
          throw new Error("control task journal has duplicate idempotency keys; submissions stopped to avoid replay");
        }
        idempotencyKeys.add(identity);
      }
    }
    return records.map((record) => structuredClone(record));
  }

  private write(): void {
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const content = JSON.stringify(this.records, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("control task journal reached its size limit");
    }
    try {
      writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}

function isTaskRecord(value: unknown): value is ControlTaskRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ControlTaskRecord>;
  return MeshTaskIdSchema.safeParse(record.taskId).success
    && MeshGroupIdSchema.safeParse(record.groupId).success
    && MeshNodeIdSchema.safeParse(record.targetNodeId).success
    && MeshResourceIdSchema.safeParse(record.resourceId).success
    && (record.requesterNodeId === undefined || MeshNodeIdSchema.safeParse(record.requesterNodeId).success)
    && (record.idempotencyKey === undefined || MeshIdempotencyKeySchema.safeParse(record.idempotencyKey).success)
    && (record.requestDigest === undefined || /^[a-f0-9]{64}$/.test(record.requestDigest))
    && (record.idempotencyDigest === undefined || /^[a-f0-9]{64}$/.test(record.idempotencyDigest))
    && (record.idempotencyKey === undefined) === (record.idempotencyDigest === undefined)
    && MeshOperationSchema.safeParse(record.operation).success
    && typeof record.status === "string"
    && CONTROL_TASK_STATUSES.has(record.status as ControlTaskStatus)
    && Number.isSafeInteger(record.createdAt)
    && Number.isSafeInteger(record.updatedAt)
    && (record.createdAt as number) >= 0
    && (record.updatedAt as number) >= 0;
}

function encodeCursor(value: { createdAt: number; taskId: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): { createdAt: number; taskId: string } {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("任务列表 cursor 无效");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("任务列表 cursor 无效");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("任务列表 cursor 无效");
  const cursor = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(cursor.createdAt) || !MeshTaskIdSchema.safeParse(cursor.taskId).success) {
    throw new Error("任务列表 cursor 无效");
  }
  return {
    createdAt: cursor.createdAt as number,
    taskId: MeshTaskIdSchema.parse(cursor.taskId),
  };
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
