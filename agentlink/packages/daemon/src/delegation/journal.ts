import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stableStringify } from "@agentlink/wire";
import { configDir } from "../store";
import { atomicWritePrivateJson, readPrivateJson } from "./private-json";
import {
  DELEGATION_JOB_VERSION,
  DelegationIdempotencyKeySchema,
  DelegationJobPhaseSchema,
  DelegationJobRequestSchema,
  DelegationJobStatusSchema,
  DelegationProgressSchema,
  DelegationReportSchema,
  DelegationSafeIdSchema,
  type DelegationJobRequest,
  type DelegationJobStatus,
} from "./schemas";

export const MAX_DELEGATION_JOBS = 500;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const TimestampSchema = z.string().datetime({ offset: true });

export const DelegationJobRecordSchema = z.object({
  version: z.literal(DELEGATION_JOB_VERSION),
  jobId: DelegationSafeIdSchema,
  principalId: DelegationSafeIdSchema,
  projectId: DelegationSafeIdSchema,
  idempotencyKey: DelegationIdempotencyKeySchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  request: DelegationJobRequestSchema,
  phase: DelegationJobPhaseSchema,
  status: DelegationJobStatusSchema,
  progress: DelegationProgressSchema,
  report: DelegationReportSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (record.projectId !== record.request.projectId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectId"],
      message: "must match request.projectId",
    });
  }
  if (delegationRequestDigest(record.request) !== record.requestDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestDigest"],
      message: "does not match the request",
    });
  }
});

export type DelegationJobRecord = z.infer<typeof DelegationJobRecordSchema>;

const DelegationJournalFileSchema = z.object({
  version: z.literal(DELEGATION_JOB_VERSION),
  jobs: z.array(DelegationJobRecordSchema).max(MAX_DELEGATION_JOBS),
}).strict().superRefine((journal, context) => {
  const jobIds = new Set<string>();
  const idempotency = new Set<string>();
  journal.jobs.forEach((job, index) => {
    if (jobIds.has(job.jobId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jobs", index, "jobId"],
        message: "duplicate job id",
      });
    }
    jobIds.add(job.jobId);

    const idempotencyIdentity = idempotencyIdentityFor(job.principalId, job.idempotencyKey);
    if (idempotency.has(idempotencyIdentity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jobs", index, "idempotencyKey"],
        message: "duplicate principal idempotency key",
      });
    }
    idempotency.add(idempotencyIdentity);
  });
});

export const DelegationJobUpdateSchema = z.object({
  phase: DelegationJobPhaseSchema.optional(),
  status: DelegationJobStatusSchema.optional(),
  progress: DelegationProgressSchema.optional(),
  report: DelegationReportSchema.nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "job update must not be empty");

export type DelegationJobUpdate = z.infer<typeof DelegationJobUpdateSchema>;

export interface BeginDelegationJobInput {
  principalId: string;
  idempotencyKey: string;
  request: unknown;
  jobId?: string;
}

export interface BeginDelegationJobResult {
  record: DelegationJobRecord;
  created: boolean;
}

export class DelegationIdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different request");
    this.name = "DelegationIdempotencyConflictError";
  }
}

export function delegationJournalPath(): string {
  return process.env.AGENTLINK_DELEGATION_JOURNAL?.trim()
    || join(configDir(), "delegation", "jobs.json");
}

export function delegationRequestDigest(request: DelegationJobRequest): string {
  const parsed = DelegationJobRequestSchema.parse(request);
  return createHash("sha256").update(stableStringify(parsed), "utf8").digest("hex");
}

/** Durable identity, idempotency, lifecycle, progress, and bounded report data. */
export class DelegationJobJournal {
  private readonly records = new Map<string, DelegationJobRecord>();
  private readonly idempotency = new Map<string, string>();

  constructor(
    private readonly file = delegationJournalPath(),
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get(jobIdInput: string): DelegationJobRecord | undefined {
    const jobId = DelegationSafeIdSchema.parse(jobIdInput);
    const record = this.records.get(jobId);
    return record ? structuredClone(record) : undefined;
  }

  list(limit = 100): DelegationJobRecord[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_DELEGATION_JOBS));
    return [...this.records.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, boundedLimit)
      .map((record) => structuredClone(record));
  }

  findByIdempotency(principalIdInput: string, idempotencyKeyInput: string): DelegationJobRecord | undefined {
    const principalId = DelegationSafeIdSchema.parse(principalIdInput);
    const idempotencyKey = DelegationIdempotencyKeySchema.parse(idempotencyKeyInput);
    const jobId = this.idempotency.get(idempotencyIdentityFor(principalId, idempotencyKey));
    return jobId ? this.get(jobId) : undefined;
  }

  begin(input: BeginDelegationJobInput): BeginDelegationJobResult {
    const principalId = DelegationSafeIdSchema.parse(input.principalId);
    const idempotencyKey = DelegationIdempotencyKeySchema.parse(input.idempotencyKey);
    const request = DelegationJobRequestSchema.parse(input.request);
    const requestDigest = delegationRequestDigest(request);
    const identity = idempotencyIdentityFor(principalId, idempotencyKey);
    const existingJobId = this.idempotency.get(identity);
    if (existingJobId) {
      const existing = this.records.get(existingJobId)!;
      if (existing.requestDigest !== requestDigest) throw new DelegationIdempotencyConflictError();
      return { record: structuredClone(existing), created: false };
    }

    if (this.records.size >= MAX_DELEGATION_JOBS) {
      throw new Error("delegation journal reached its 500 job limit");
    }
    const jobId = DelegationSafeIdSchema.parse(input.jobId ?? `job-${randomUUID()}`);
    if (this.records.has(jobId)) throw new Error("delegation job id already exists");
    const timestamp = this.timestamp();
    const record = DelegationJobRecordSchema.parse({
      version: DELEGATION_JOB_VERSION,
      jobId,
      principalId,
      projectId: request.projectId,
      idempotencyKey,
      requestDigest,
      request,
      phase: "accepted",
      status: "queued",
      progress: { percent: 0, step: "accepted" },
      report: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
    });

    this.records.set(jobId, record);
    this.idempotency.set(identity, jobId);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(jobId);
      this.idempotency.delete(identity);
      throw error;
    }
    return { record: structuredClone(record), created: true };
  }

  update(jobIdInput: string, patchInput: DelegationJobUpdate): DelegationJobRecord {
    const jobId = DelegationSafeIdSchema.parse(jobIdInput);
    const patch = DelegationJobUpdateSchema.parse(patchInput);
    const current = this.records.get(jobId);
    if (!current) throw new Error("delegation job does not exist");
    const timestamp = this.timestamp();
    const status = patch.status ?? current.status;
    const next = DelegationJobRecordSchema.parse({
      ...current,
      ...patch,
      phase: patch.phase ?? inferredPhase(status, current.phase),
      status,
      updatedAt: timestamp,
      startedAt: current.startedAt ?? (status === "running" ? timestamp : null),
      finishedAt: isTerminal(status) ? (current.finishedAt ?? timestamp) : current.finishedAt,
    });

    this.records.set(jobId, next);
    try {
      this.persist();
    } catch (error) {
      this.records.set(jobId, current);
      throw error;
    }
    return structuredClone(next);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = readPrivateJson(this.file, "delegation journal", MAX_JOURNAL_BYTES);
    const parsed = DelegationJournalFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("delegation journal is invalid; execution stopped to preserve idempotency");
    }
    for (const record of parsed.data.jobs) {
      this.records.set(record.jobId, record);
      this.idempotency.set(idempotencyIdentityFor(record.principalId, record.idempotencyKey), record.jobId);
    }
  }

  private persist(): void {
    const jobs = [...this.records.values()]
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    atomicWritePrivateJson(
      this.file,
      { version: DELEGATION_JOB_VERSION, jobs },
      "delegation journal",
      MAX_JOURNAL_BYTES,
    );
  }

  private timestamp(): string {
    const timestamp = new Date(this.now());
    if (Number.isNaN(timestamp.getTime())) throw new Error("delegation journal clock is invalid");
    return timestamp.toISOString();
  }
}

function idempotencyIdentityFor(principalId: string, idempotencyKey: string): string {
  return `${principalId}\0${idempotencyKey}`;
}

function isTerminal(status: DelegationJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "denied" || status === "cancelled";
}

function inferredPhase(
  status: DelegationJobStatus,
  current: z.infer<typeof DelegationJobPhaseSchema>,
): z.infer<typeof DelegationJobPhaseSchema> {
  if (isTerminal(status)) return "finished";
  if (status === "approval-required") return "awaiting-approval";
  if (status === "running" && current === "accepted") return "running";
  return current;
}
