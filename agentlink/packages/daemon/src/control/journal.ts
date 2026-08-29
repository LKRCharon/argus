import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../store";

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
  groupId: string;
  targetNodeId: string;
  resourceId: string;
  operation: string;
  /** Stable digest of the complete typed request envelope for idempotency. */
  requestDigest?: string;
  status: ControlTaskStatus;
  decision?: string;
  message?: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
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
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  get(taskId: string): ControlTaskRecord | undefined {
    return this.records.find((record) => record.taskId === taskId);
  }

  create(record: ControlTaskRecord): ControlTaskRecord {
    this.records = [record, ...this.records.filter((item) => item.taskId !== record.taskId)].slice(0, 500);
    this.write();
    return record;
  }

  update(taskId: string, patch: Partial<Omit<ControlTaskRecord, "taskId" | "createdAt">>): ControlTaskRecord | undefined {
    const index = this.records.findIndex((record) => record.taskId === taskId);
    if (index < 0) return undefined;
    this.records[index] = { ...this.records[index], ...patch, updatedAt: Date.now() };
    this.write();
    return this.records[index];
  }

  private read(): ControlTaskRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(value) ? value.filter(isTaskRecord).slice(0, 500) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.records, null, 2) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}

function isTaskRecord(value: unknown): value is ControlTaskRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ControlTaskRecord>;
  return typeof record.taskId === "string"
    && typeof record.groupId === "string"
    && typeof record.targetNodeId === "string"
    && typeof record.resourceId === "string"
    && typeof record.operation === "string"
    && typeof record.status === "string"
    && typeof record.createdAt === "number"
    && typeof record.updatedAt === "number";
}
