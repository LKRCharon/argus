import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const DELEGATION_CONFIG_VERSION = 1 as const;
export const DELEGATION_JOB_VERSION = 1 as const;

const SAFE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const SAFE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,127}$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const DelegationSafeIdSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(SAFE_ID_PATTERN, "must be a safe lowercase identifier");

export const DelegationIdempotencyKeySchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(SAFE_KEY_PATTERN, "must be a safe idempotency key");

export const DelegationModeSchema = z.enum(["inspect", "change", "publish"]);
export type DelegationMode = z.infer<typeof DelegationModeSchema>;

export const DelegationBaseRevisionSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(SAFE_REVISION_PATTERN, "must be a safe Git revision")
  .refine((value) => !value.includes(".."), "must not contain '..'")
  .refine((value) => !value.includes("@{"), "must not contain '@{'")
  .refine((value) => !value.includes("//"), "must not contain repeated separators")
  .refine((value) => !value.endsWith("/") && !value.endsWith("."), "must have a safe ending")
  .refine((value) => !value.toLowerCase().endsWith(".lock"), "must not name a lock ref");

export const DelegationHostnameSchema = z.string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .refine(isHostname, "must be a hostname without a scheme, port, or path");

export const DelegationJobRequestSchema = z.object({
  projectId: DelegationSafeIdSchema,
  mode: DelegationModeSchema,
  goal: z.string().trim().min(1).max(12_000),
  acceptance: z.array(z.string().trim().min(1).max(512)).max(12),
  baseRevision: DelegationBaseRevisionSchema.optional(),
  domain: DelegationHostnameSchema.optional(),
}).strict();

export type DelegationJobRequest = z.infer<typeof DelegationJobRequestSchema>;

const AbsolutePathSchema = z.string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "must be an absolute path");

const CopyExcludeSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !isAbsolute(value), "must be relative")
  .refine((value) => !hasParentSegment(value), "must not contain a parent segment")
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");

const ArgvEntrySchema = z.string()
  .max(4096)
  .refine((value) => !value.includes("\0"), "must not contain NUL");

export const DelegationVerificationCommandSchema = z.object({
  id: DelegationSafeIdSchema,
  label: z.string().trim().min(1).max(128),
  argv: z.array(ArgvEntrySchema).min(1).max(32)
    .refine((argv) => argv[0]!.trim().length > 0, "argv[0] must name an executable"),
  timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
}).strict();

export const DelegationProjectPolicySchema = z.object({
  id: DelegationSafeIdSchema,
  displayName: z.string().trim().min(1).max(128),
  sourceRoot: AbsolutePathSchema,
  workRoot: AbsolutePathSchema,
  defaultRef: DelegationBaseRevisionSchema,
  allowedDomains: uniqueArray(DelegationHostnameSchema, 32, "domain"),
  allowedModes: uniqueArray(DelegationModeSchema, 3, "mode", { min: 1 }),
  codexExecutable: AbsolutePathSchema,
  maxRuntimeMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
  maxChangedFiles: z.number().int().min(1).max(10_000),
  maxDiffBytes: z.number().int().min(1_024).max(1024 * 1024 * 1024),
  copyExcludes: uniqueArray(CopyExcludeSchema, 128, "copy exclude"),
  verificationCommands: uniqueArray(DelegationVerificationCommandSchema, 16, "verification command", {
    key: (item) => item.id,
  })
    .optional(),
}).strict().superRefine((project, context) => {
  if (pathsOverlap(project.sourceRoot, project.workRoot)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workRoot"],
      message: "sourceRoot and workRoot must not overlap",
    });
  }
});

export type DelegationProjectPolicy = z.infer<typeof DelegationProjectPolicySchema>;

export const DelegationPrincipalSchema = z.object({
  id: DelegationSafeIdSchema,
  label: z.string().trim().min(1).max(128),
  tokenHash: z.string().regex(TOKEN_HASH_PATTERN, "must be a lowercase SHA-256 digest"),
  projectIds: uniqueArray(DelegationSafeIdSchema, 64, "project id", { min: 1 }),
  modes: uniqueArray(DelegationModeSchema, 3, "mode", { min: 1 }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type DelegationPrincipal = z.infer<typeof DelegationPrincipalSchema>;

export const DelegationConfigSchema = z.object({
  version: z.literal(DELEGATION_CONFIG_VERSION),
  projects: z.array(DelegationProjectPolicySchema).max(128),
  principals: z.array(DelegationPrincipalSchema).max(512),
}).strict().superRefine((config, context) => {
  addDuplicateIssues(config.projects, (project) => project.id, ["projects"], "project id", context);
  addDuplicateIssues(config.principals, (principal) => principal.id, ["principals"], "principal id", context);
  addDuplicateIssues(config.principals, (principal) => principal.tokenHash, ["principals"], "token hash", context);

  const projects = new Map(config.projects.map((project) => [project.id, project]));
  config.principals.forEach((principal, principalIndex) => {
    principal.projectIds.forEach((projectId, projectIndex) => {
      const project = projects.get(projectId);
      if (!project) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["principals", principalIndex, "projectIds", projectIndex],
          message: "references an unknown project",
        });
        return;
      }
      principal.modes.forEach((mode, modeIndex) => {
        if (!project.allowedModes.includes(mode)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["principals", principalIndex, "modes", modeIndex],
            message: `mode is not allowed by project ${projectId}`,
          });
        }
      });
    });
  });
});

export type DelegationConfig = z.infer<typeof DelegationConfigSchema>;

export const DelegationJobPhaseSchema = z.enum([
  "accepted",
  "preparing",
  "running",
  "verifying",
  "awaiting-approval",
  "publishing",
  "finished",
]);
export type DelegationJobPhase = z.infer<typeof DelegationJobPhaseSchema>;

export const DelegationJobStatusSchema = z.enum([
  "queued",
  "running",
  "approval-required",
  "completed",
  "failed",
  "denied",
  "cancelled",
]);
export type DelegationJobStatus = z.infer<typeof DelegationJobStatusSchema>;

export const DelegationProgressSchema = z.object({
  percent: z.number().int().min(0).max(100),
  step: z.string().trim().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(2048).optional(),
  completedUnits: z.number().int().nonnegative().max(1_000_000_000).optional(),
  totalUnits: z.number().int().positive().max(1_000_000_000).optional(),
}).strict().superRefine((progress, context) => {
  if (progress.completedUnits !== undefined
    && progress.totalUnits !== undefined
    && progress.completedUnits > progress.totalUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedUnits"],
      message: "must not exceed totalUnits",
    });
  }
});

export type DelegationProgress = z.infer<typeof DelegationProgressSchema>;

const ReportPathSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !isAbsolute(value), "must be relative")
  .refine((value) => !hasParentSegment(value), "must not contain a parent segment")
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");

const AcceptanceResultSchema = z.object({
  criterion: z.string().trim().min(1).max(512),
  status: z.enum(["passed", "failed", "not-run"]),
  detail: z.string().trim().min(1).max(2048).optional(),
}).strict();

const VerificationResultSchema = z.object({
  id: DelegationSafeIdSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  exitCode: z.number().int().min(-1).max(255).optional(),
  durationMs: z.number().int().nonnegative().max(24 * 60 * 60_000).optional(),
  summary: z.string().trim().min(1).max(2048).optional(),
}).strict();

export const DelegationReportSchema = z.object({
  outcome: z.enum(["success", "partial", "failure", "denied", "cancelled"]),
  summary: z.string().trim().min(1).max(12_000),
  baseRevision: DelegationBaseRevisionSchema.optional(),
  finalRevision: DelegationBaseRevisionSchema.optional(),
  changedFileCount: z.number().int().nonnegative().max(10_000).optional(),
  changedFiles: z.array(ReportPathSchema).max(200).optional(),
  diffBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024).optional(),
  patchSha256: z.string().regex(TOKEN_HASH_PATTERN).optional(),
  reportSha256: z.string().regex(TOKEN_HASH_PATTERN).optional(),
  sourceSnapshotSha256: z.string().regex(TOKEN_HASH_PATTERN).optional(),
  commandCount: z.number().int().nonnegative().max(1_000_000).optional(),
  acceptance: z.array(AcceptanceResultSchema).max(12).optional(),
  verification: z.array(VerificationResultSchema).max(32).optional(),
  warnings: z.array(z.string().trim().min(1).max(2048)).max(32).optional(),
}).strict();

export type DelegationReport = z.infer<typeof DelegationReportSchema>;

function isHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith(".") || value.includes("..")) return false;
  const labels = value.split(".");
  return labels.every((label) => label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return isWithin(resolvedLeft, resolvedRight) || isWithin(resolvedRight, resolvedLeft);
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function uniqueArray<T extends z.ZodTypeAny>(
  item: T,
  max: number,
  label: string,
  options: {
    min?: number;
    key?: (value: z.infer<T>) => string;
  } = {},
) {
  const array = options.min === undefined
    ? z.array(item).max(max)
    : z.array(item).min(options.min).max(max);
  return array.superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const itemKey = options.key ? options.key(value) : String(value);
      if (seen.has(itemKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `duplicate ${label}`,
        });
      }
      seen.add(itemKey);
    });
  });
}

function addDuplicateIssues<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: (string | number)[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `duplicate ${label}`,
      });
    } else {
      seen.set(itemKey, index);
    }
  });
}
