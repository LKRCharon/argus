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
  MeshTaskRequestPayloadSchema,
  MeshNodeIdSchema,
  MeshTaskIdSchema,
  MeshTimestampSchema,
  stableStringify,
  type MeshTaskRequestPayload,
} from "@agentlink/wire";
import { configDir } from "../store";

const FILE_VERSION = 1;
const MAX_RECORDS = 500;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const ControlOutboxRecordSchema = z.object({
  version: z.literal(FILE_VERSION),
  taskId: MeshTaskIdSchema,
  targetNodeId: MeshNodeIdSchema,
  requestDigest: z.string().length(64),
  payload: MeshTaskRequestPayloadSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: MeshTimestampSchema,
  updatedAt: MeshTimestampSchema,
  lastAttemptAt: MeshTimestampSchema.optional(),
});

const ControlOutboxFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  tasks: z.array(ControlOutboxRecordSchema).max(MAX_RECORDS),
});

export type ControlOutboxRecord = z.infer<typeof ControlOutboxRecordSchema>;

/**
 * Durable controller-side delivery queue.
 *
 * The relay may restart at any time, so an accepted task remains here until
 * the target returns a terminal result or a status reconciliation proves that
 * it already finished. Replays reuse the same task id and signed envelope; the
 * target journal therefore treats them idempotently instead of executing twice.
 */
export class ControlTaskOutbox {
  private readonly records = new Map<string, ControlOutboxRecord>();

  constructor(
    private readonly file = process.env.ARGUS_CONTROL_OUTBOX?.trim()
      || join(configDir(), "control-outbox.json"),
  ) {
    this.load();
  }

  get(taskId: string): ControlOutboxRecord | undefined {
    const record = this.records.get(taskId);
    return record ? clone(record) : undefined;
  }

  list(targetNodeId?: string): ControlOutboxRecord[] {
    return [...this.records.values()]
      .filter((record) => !targetNodeId || record.targetNodeId === targetNodeId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(clone);
  }

  put(payload: MeshTaskRequestPayload): ControlOutboxRecord {
    const parsed = MeshTaskRequestPayloadSchema.parse(payload);
    const taskId = parsed.task.taskId;
    const requestDigest = digestControlTaskPayload(parsed);
    const existing = this.records.get(taskId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("outbox task id conflict");
      return clone(existing);
    }
    if (this.records.size >= MAX_RECORDS) throw new Error("control outbox reached its task limit");
    const now = new Date().toISOString();
    const record: ControlOutboxRecord = {
      version: FILE_VERSION,
      taskId,
      targetNodeId: parsed.task.targetNodeId,
      requestDigest,
      payload: parsed,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(taskId, record);
    this.persistOrRollback(taskId, undefined);
    return clone(record);
  }

  markAttempt(taskId: string): ControlOutboxRecord | undefined {
    const current = this.records.get(taskId);
    if (!current) return undefined;
    const previous = clone(current);
    const now = new Date().toISOString();
    const next: ControlOutboxRecord = {
      ...current,
      attempts: current.attempts + 1,
      lastAttemptAt: now,
      updatedAt: now,
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
      throw new Error("control outbox permissions are too broad");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("control outbox is unreadable; task delivery stopped to avoid replay");
    }
    const parsed = ControlOutboxFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("control outbox is invalid; task delivery stopped to avoid replay");
    }
    for (const record of parsed.data.tasks) {
      if (this.records.has(record.taskId)) {
        throw new Error("control outbox has duplicate task ids; task delivery stopped to avoid replay");
      }
      this.records.set(record.taskId, record);
    }
  }

  private persistOrRollback(taskId: string, previous: ControlOutboxRecord | undefined): void {
    try {
      this.persist();
    } catch (error) {
      if (previous) this.records.set(taskId, previous);
      else this.records.delete(taskId);
      throw error;
    }
  }

  private persist(): void {
    const tasks = [...this.records.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, MAX_RECORDS);
    const content = JSON.stringify({ version: FILE_VERSION, tasks }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("control outbox reached its size limit");
    }
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {}
      throw error;
    }
  }
}

export function digestControlTaskPayload(payload: MeshTaskRequestPayload): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

function clone(record: ControlOutboxRecord): ControlOutboxRecord {
  return structuredClone(record);
}
