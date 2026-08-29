import { randomUUID } from "node:crypto";
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
  MeshDeadlineStageSchema,
  MeshIdempotencyKeySchema,
  MeshNodeIdSchema,
  MeshOperationIdSchema,
  MeshThreadIdSchema,
  type MeshDeadlineStage,
} from "@agentlink/wire";
import { configDir } from "../store";

const FILE_VERSION = 1;
const MAX_RECORDS = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const CodexOperationStatusSchema = z.enum([
  "queued",
  "sent",
  "acknowledged",
  "running",
  "completed",
  "failed",
  "timed_out",
]);
export type CodexOperationStatus = z.infer<typeof CodexOperationStatusSchema>;

const CodexOperationRecordSchema = z.object({
  version: z.literal(FILE_VERSION),
  operationId: MeshOperationIdSchema,
  requesterNodeId: MeshNodeIdSchema,
  targetNodeId: MeshNodeIdSchema,
  kind: z.literal("start-thread"),
  idempotencyKey: MeshIdempotencyKeySchema,
  requestDigest: z.string().length(64),
  status: CodexOperationStatusSchema,
  deadlineAt: z.number().int().positive(),
  timedOutStage: MeshDeadlineStageSchema.optional(),
  retryable: z.boolean(),
  sessionId: MeshThreadIdSchema.optional(),
  message: z.string().max(512).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  sentAt: z.number().int().nonnegative().optional(),
  acknowledgedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).strict();

const CodexOperationFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  operations: z.array(CodexOperationRecordSchema).max(MAX_RECORDS),
}).strict();

export type CodexOperationRecord = z.infer<typeof CodexOperationRecordSchema>;

export interface CodexOperationListQuery {
  targetNodeId?: string;
  status?: CodexOperationStatus;
  createdAfter?: number;
  limit?: number;
  cursor?: string;
}

export interface CodexOperationPage {
  operations: CodexOperationRecord[];
  nextCursor?: string;
}

export class CodexOperationStore {
  private readonly records = new Map<string, CodexOperationRecord>();

  constructor(
    private readonly file = process.env.ARGUS_CONTROL_CODEX_OPERATIONS?.trim()
      || join(configDir(), "control-codex-operations.json"),
  ) {
    this.load();
    this.recoverInterrupted();
  }

  begin(input: {
    requesterNodeId: string;
    targetNodeId: string;
    idempotencyKey: string;
    requestDigest: string;
    deadlineAt: number;
  }): { record: CodexOperationRecord; created: boolean; conflict: boolean } {
    const existing = [...this.records.values()].find((record) => (
      record.requesterNodeId === input.requesterNodeId
      && record.idempotencyKey === input.idempotencyKey
    ));
    if (existing) {
      return {
        record: structuredClone(existing),
        created: false,
        conflict: existing.requestDigest !== input.requestDigest,
      };
    }
    if (this.records.size >= MAX_RECORDS) throw new Error("Codex operation journal reached its limit");
    const now = Date.now();
    const record = CodexOperationRecordSchema.parse({
      version: FILE_VERSION,
      operationId: `op-${randomUUID()}`,
      requesterNodeId: input.requesterNodeId,
      targetNodeId: input.targetNodeId,
      kind: "start-thread",
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      status: "queued",
      deadlineAt: input.deadlineAt,
      retryable: false,
      createdAt: now,
      updatedAt: now,
    });
    this.records.set(record.operationId, record);
    this.persistOrRollback(record.operationId, undefined);
    return { record: structuredClone(record), created: true, conflict: false };
  }

  get(operationId: string, requesterNodeId: string): CodexOperationRecord | undefined {
    const record = this.records.get(operationId);
    return record?.requesterNodeId === requesterNodeId ? structuredClone(record) : undefined;
  }

  list(requesterNodeId: string, query: CodexOperationListQuery = {}): CodexOperationPage {
    const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 50), 100));
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = [...this.records.values()]
      .filter((record) => record.requesterNodeId === requesterNodeId)
      .filter((record) => !query.targetNodeId || record.targetNodeId === query.targetNodeId)
      .filter((record) => !query.status || record.status === query.status)
      .filter((record) => query.createdAfter === undefined || record.createdAt > query.createdAfter!)
      .sort((left, right) => right.createdAt - left.createdAt || compareId(right.operationId, left.operationId))
      .filter((record) => !cursor
        || record.createdAt < cursor.createdAt
        || (record.createdAt === cursor.createdAt && compareId(record.operationId, cursor.operationId) < 0));
    const operations = rows.slice(0, limit).map((record) => structuredClone(record));
    const last = operations.at(-1);
    return {
      operations,
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({ createdAt: last.createdAt, operationId: last.operationId }) }
        : {}),
    };
  }

  update(
    operationId: string,
    status: CodexOperationStatus,
    patch: Partial<Pick<CodexOperationRecord,
      "timedOutStage" | "retryable" | "sessionId" | "message" | "sentAt" | "acknowledgedAt" | "completedAt">> = {},
  ): CodexOperationRecord {
    const current = this.records.get(operationId);
    if (!current) throw new Error("Codex operation not found");
    const next = CodexOperationRecordSchema.parse({
      ...current,
      ...patch,
      status,
      updatedAt: Date.now(),
    });
    this.records.set(operationId, next);
    this.persistOrRollback(operationId, current);
    return structuredClone(next);
  }

  private recoverInterrupted(): void {
    let changed = false;
    const now = Date.now();
    for (const [operationId, record] of this.records) {
      if (["completed", "failed", "timed_out"].includes(record.status)) continue;
      this.records.set(operationId, {
        ...record,
        status: "timed_out",
        timedOutStage: "controller",
        retryable: true,
        message: "controller restarted before the operation reached a terminal acknowledgement",
        completedAt: now,
        updatedAt: now,
      });
      changed = true;
    }
    if (changed) this.persist();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    if (process.platform !== "win32" && (statSync(this.file).mode & 0o077) !== 0) {
      throw new Error("Codex operation journal permissions are too broad");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    } catch {
      throw new Error("Codex operation journal is unreadable; remote starts stopped safely");
    }
    const parsed = CodexOperationFileSchema.safeParse(value);
    if (!parsed.success) throw new Error("Codex operation journal is invalid; remote starts stopped safely");
    const idempotencyKeys = new Set<string>();
    for (const record of parsed.data.operations) {
      const identity = `${record.requesterNodeId}\u0000${record.idempotencyKey}`;
      if (this.records.has(record.operationId) || idempotencyKeys.has(identity)) {
        throw new Error("Codex operation journal has duplicate identities; remote starts stopped safely");
      }
      this.records.set(record.operationId, record);
      idempotencyKeys.add(identity);
    }
  }

  private persistOrRollback(operationId: string, previous: CodexOperationRecord | undefined): void {
    try {
      this.persist();
    } catch (error) {
      if (previous) this.records.set(operationId, previous);
      else this.records.delete(operationId);
      throw error;
    }
  }

  private persist(): void {
    const operations = [...this.records.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_RECORDS);
    const content = JSON.stringify({ version: FILE_VERSION, operations }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("Codex operation journal reached its size limit");
    }
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
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

function encodeCursor(value: { createdAt: number; operationId: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): { createdAt: number; operationId: string } {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("operation cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("operation cursor is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("operation cursor is invalid");
  const cursor = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(cursor.createdAt) || !MeshOperationIdSchema.safeParse(cursor.operationId).success) {
    throw new Error("operation cursor is invalid");
  }
  return {
    createdAt: cursor.createdAt as number,
    operationId: MeshOperationIdSchema.parse(cursor.operationId),
  };
}

export function codexOperationTimeoutPatch(stage: MeshDeadlineStage, message: string): {
  timedOutStage: MeshDeadlineStage;
  retryable: boolean;
  message: string;
  completedAt: number;
} {
  return { timedOutStage: stage, retryable: true, message: message.slice(0, 512), completedAt: Date.now() };
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
