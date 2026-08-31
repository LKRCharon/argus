import { z } from "zod";
import {
  MeshDeadlineStageSchema,
  MeshIdempotencyKeySchema,
  MeshOperationIdSchema,
  MeshRequestIdSchema,
  MeshTaskIdSchema,
  type MeshDeadlineStage,
} from "./mesh";

export const MeshDiagnosticClassificationSchema = z.enum([
  "transport-closed",
  "timeout-deadline",
  "auth-authz",
  "sandbox-capability",
  "code-error",
]);
export type MeshDiagnosticClassification = z.infer<typeof MeshDiagnosticClassificationSchema>;

export const MeshDiagnosticSchema = z.object({
  classification: MeshDiagnosticClassificationSchema,
  code: z.string().min(1).max(128),
  message: z.string().max(512),
  retryable: z.boolean(),
  timedOut: z.boolean(),
  timedOutStage: MeshDeadlineStageSchema.optional(),
  operationId: MeshOperationIdSchema.optional(),
  requestId: MeshRequestIdSchema.optional(),
  controlRequestId: MeshRequestIdSchema.optional(),
  taskId: MeshTaskIdSchema.optional(),
  idempotencyKey: MeshIdempotencyKeySchema.optional(),
}).strict();
export type MeshDiagnostic = z.infer<typeof MeshDiagnosticSchema>;

export interface MeshDiagnosticContext {
  operationId?: string;
  requestId?: string;
  controlRequestId?: string;
  taskId?: string;
  idempotencyKey?: string;
  retryable?: boolean;
  timedOutStage?: MeshDeadlineStage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeCode(value: unknown): string {
  const code = boundedString(value, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(code) ? code : "";
}

function redactMessage(value: string): string {
  return value
    .slice(0, 512)
    .replace(/-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\r\n-]*PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bAuthorization\s*:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: [REDACTED]")
    .replace(/\b(token|secret|password|private[_ -]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .slice(0, 512);
}

function readId(
  value: unknown,
  schema: { safeParse(input: unknown): { success: boolean; data?: string } },
): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function readStage(value: unknown): MeshDeadlineStage | undefined {
  const parsed = MeshDeadlineStageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function classifyText(code: string, message: string, status: number | undefined, timedOut: boolean): MeshDiagnosticClassification {
  const text = `${code} ${message}`.toLowerCase();
  if (timedOut || /timeout|timed[ -]?out|deadline|超时/.test(text)) return "timeout-deadline";
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|bad credentials|not logged in|\bauthz(?:[_ -]?(?:failed|error|denied|required))?\b|\bauth(?:entication|orization)?[_ -]?(?:failed|error|denied|required)?\b|permission denied|access denied|operation[_ -]?not[_ -]?allowed|\b401\b|\b403\b/.test(text)) {
    return "auth-authz";
  }
  if (/sandbox|capability|policy.*(?:denied|disabled)|(?:denied|disabled).*policy|not permitted/.test(text)) {
    return "sandbox-capability";
  }
  if (/econnreset|econnrefused|epipe|socket.*closed|transport.*closed|channel.*closed|peer.*(?:closed|disconnect)|connection.*(?:closed|reset|lost)|not connected|未连接|连接(?:断开|关闭)|通道关闭|relay disconnected/.test(text)) {
    return "transport-closed";
  }
  return "code-error";
}

/** Normalize an unknown control failure into the bounded diagnostic vocabulary. */
export function classifyMeshDiagnostic(
  input: unknown,
  context: MeshDiagnosticContext = {},
): MeshDiagnostic {
  const source = isRecord(input) ? input : {};
  const nested = isRecord(source.error) ? source.error : {};
  const field = (name: string): unknown => source[name] ?? nested[name];
  const message = redactMessage(
    boundedString(field("message"), 512)
      || boundedString(field("note"), 512)
      || (input instanceof Error ? input.message.slice(0, 512) : "control operation failed"),
  );
  const inputCode = safeCode(field("code")) || safeCode(field("errorCode"));
  const status = readStatus(field("status"));
  const stage = readStage(field("timedOutStage"))
    ?? readStage(field("stage"))
    ?? context.timedOutStage;
  const timedOut = field("timedOut") === true;
  const explicit = MeshDiagnosticClassificationSchema.safeParse(field("classification") ?? field("category"));
  const classification = explicit.success
    ? explicit.data
    : classifyText(inputCode, message, status, timedOut);
  const retryable = typeof field("retryable") === "boolean"
    ? field("retryable") as boolean
    : context.retryable
      ?? (classification === "transport-closed" || classification === "timeout-deadline");
  const code = inputCode
    || (classification === "transport-closed" ? "transport-closed"
      : classification === "timeout-deadline" ? "deadline-exceeded"
        : classification === "auth-authz" ? "auth-failed"
          : classification === "sandbox-capability" ? "sandbox-capability-denied"
            : "code-error");

  const operationId = readId(field("operationId") ?? context.operationId, MeshOperationIdSchema);
  const requestId = readId(field("requestId") ?? context.requestId, MeshRequestIdSchema);
  const controlRequestId = readId(field("controlRequestId") ?? context.controlRequestId, MeshRequestIdSchema);
  const taskId = readId(field("taskId") ?? context.taskId, MeshTaskIdSchema);
  const idempotencyKey = readId(field("idempotencyKey") ?? context.idempotencyKey, MeshIdempotencyKeySchema);

  return MeshDiagnosticSchema.parse({
    classification,
    code,
    message,
    retryable,
    timedOut: timedOut || classification === "timeout-deadline",
    ...(stage ? { timedOutStage: stage } : {}),
    ...(operationId ? { operationId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(controlRequestId ? { controlRequestId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

export const classifyDiagnostic = classifyMeshDiagnostic;
