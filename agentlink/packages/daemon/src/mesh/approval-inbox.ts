import { createHash, randomUUID } from "node:crypto";
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
import { z } from "zod";
import {
  MeshRunScopeSchema,
  MeshTaskRequestSchema,
  MeshTimestampSchema,
  stableStringify,
  type MeshTaskRequest,
} from "@agentlink/wire";
import { configDir } from "../store";

const FILE_VERSION = 1;
const MAX_RECORDS = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ApprovalRecordSchema = z.object({
  version: z.literal(FILE_VERSION),
  task: MeshTaskRequestSchema,
  requestDigest: z.string().length(64),
  status: z.enum(["pending", "processing"]),
  createdAt: MeshTimestampSchema,
  updatedAt: MeshTimestampSchema,
}).strict();

const ApprovalInboxFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  approvals: z.array(ApprovalRecordSchema).max(MAX_RECORDS),
}).strict();

export type MeshApprovalInboxRecord = z.infer<typeof ApprovalRecordSchema>;

export interface HostApprovalSummary {
  taskId: string;
  groupId: string;
  requesterNodeId: string;
  resourceId: string;
  operation: string;
  status: "pending" | "processing";
  summary: string;
  runnerId?: string;
  args?: string[];
  createdAt: string;
}

/**
 * Target-local, durable queue of requests that still need a human decision.
 * It stores typed task data only. Owner signing keys, grants, approvals, relay
 * keys, environment variables, and runner executable paths never enter it.
 */
export class MeshApprovalInbox {
  private readonly records = new Map<string, MeshApprovalInboxRecord>();

  constructor(
    private readonly file = process.env.ARGUS_HOST_APPROVALS?.trim()
      || join(configDir(), "mesh-approvals.json"),
  ) {
    this.load();
  }

  get(taskId: string): MeshApprovalInboxRecord | undefined {
    const record = this.records.get(taskId);
    return record ? clone(record) : undefined;
  }

  listPending(): HostApprovalSummary[] {
    return [...this.records.values()]
      .filter((record) => record.status === "pending")
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(toSummary);
  }

  put(task: MeshTaskRequest): MeshApprovalInboxRecord {
    const parsed = MeshTaskRequestSchema.parse(task);
    const requestDigest = digestTask(parsed);
    const existing = this.records.get(parsed.taskId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("approval task id conflict");
      return clone(existing);
    }
    if (this.records.size >= MAX_RECORDS) throw new Error("approval inbox reached its task limit");
    const now = new Date().toISOString();
    const record: MeshApprovalInboxRecord = {
      version: FILE_VERSION,
      task: parsed,
      requestDigest,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(parsed.taskId, record);
    this.persistOrRollback(parsed.taskId, undefined);
    return clone(record);
  }

  claim(taskId: string): MeshApprovalInboxRecord | undefined {
    const current = this.records.get(taskId);
    if (!current || current.status !== "pending") return undefined;
    const previous = clone(current);
    const next: MeshApprovalInboxRecord = {
      ...current,
      status: "processing",
      updatedAt: new Date().toISOString(),
    };
    this.records.set(taskId, next);
    this.persistOrRollback(taskId, previous);
    return clone(next);
  }

  release(taskId: string): MeshApprovalInboxRecord | undefined {
    const current = this.records.get(taskId);
    if (!current || current.status !== "processing") return undefined;
    const previous = clone(current);
    const next: MeshApprovalInboxRecord = {
      ...current,
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    this.records.set(taskId, next);
    this.persistOrRollback(taskId, previous);
    return clone(next);
  }

  remove(taskId: string): boolean {
    const previous = this.records.get(taskId);
    if (!previous) return false;
    this.records.delete(taskId);
    this.persistOrRollback(taskId, previous);
    return true;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    if (process.platform !== "win32" && (statSync(this.file).mode & 0o077) !== 0) {
      throw new Error("approval inbox permissions are too broad");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("approval inbox is unreadable; owner approval stopped safely");
    }
    const parsed = ApprovalInboxFileSchema.safeParse(value);
    if (!parsed.success) throw new Error("approval inbox is invalid; owner approval stopped safely");
    for (const record of parsed.data.approvals) this.records.set(record.task.taskId, record);
  }

  private persistOrRollback(taskId: string, previous: MeshApprovalInboxRecord | undefined): void {
    try {
      this.persist();
    } catch (error) {
      if (previous) this.records.set(taskId, previous);
      else this.records.delete(taskId);
      throw error;
    }
  }

  private persist(): void {
    const approvals = [...this.records.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, MAX_RECORDS);
    const content = JSON.stringify({ version: FILE_VERSION, approvals }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("approval inbox reached its size limit");
    }
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
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

function digestTask(task: MeshTaskRequest): string {
  return createHash("sha256").update(stableStringify(task), "utf8").digest("hex");
}

function toSummary(record: MeshApprovalInboxRecord): HostApprovalSummary {
  const scope = record.task.operation === "run"
    ? MeshRunScopeSchema.safeParse(record.task.scope ?? {})
    : undefined;
  const runnerId = scope?.success ? scope.data.runnerId : undefined;
  const args = scope?.success ? scope.data.args : undefined;
  return {
    taskId: record.task.taskId,
    groupId: record.task.groupId,
    requesterNodeId: record.task.requesterNodeId,
    resourceId: record.task.resourceId,
    operation: record.task.operation,
    status: record.status,
    summary: runnerId
      ? `允许 ${record.task.requesterNodeId} 在 ${record.task.resourceId} 运行 ${runnerId}`
      : `允许 ${record.task.requesterNodeId} 对 ${record.task.resourceId} 执行 ${record.task.operation}`,
    ...(runnerId ? { runnerId } : {}),
    ...(args ? { args } : {}),
    createdAt: record.createdAt,
  };
}

function clone(record: MeshApprovalInboxRecord): MeshApprovalInboxRecord {
  return structuredClone(record);
}
