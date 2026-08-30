import type {
  FunctionalDifference,
  FunctionalManifest,
  GitArtifactDifference,
} from "../scripts/release-manifest";

export const WORKFLOW_VERSION = 1 as const;
export const WORKFLOW_SCHEMA = "argus.kmac.release-workflow" as const;
export const AUDIT_SCHEMA = "argus.kmac.release-audit" as const;
export const OPERATION_SCHEMA = "argus.kmac.release-operation" as const;
export const RELEASE_STATUS_SCHEMA = "argus.kmac.release-status" as const;
export const AUDIT_RESULT_SCHEMA = "argus.kmac.release-audit-result" as const;
export const LOCK_SCHEMA = "argus.kmac.release-lock" as const;

export const MAX_PATH_LENGTH = 4096;
export const MAX_OPERATION_ID_LENGTH = 96;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_RELEASE_FILES = 50_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
export const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
export const MAX_AUDIT_RECORDS = 10_000;
export const MAX_OPERATION_FILES = 10_000;
export const MAX_AUDIT_OUTPUT_RECORDS = 16;
export const MAX_PUBLIC_DIFFERENCES = 16;
export const MAX_LOCK_BYTES = 16 * 1024;
export const LOCK_MAX_AGE_MS = 30 * 60 * 1000;

export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const OPERATION_ID_PATTERN = /^kmac-[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const FAILURE_STAGES = [
  "none",
  "usage",
  "path_validation",
  "git_artifact",
  "reviewed_commit",
  "candidate_exists",
  "candidate_archive",
  "candidate_write",
  "candidate_manifest",
  "candidate_content",
  "candidate_mutability",
  "active_manifest",
  "active_content",
  "current_link",
  "stale_request",
  "operation_state",
  "lock",
  "audit",
  "switch",
  "postcondition",
  "rollback_switch",
  "rollback_verification",
  "rollback_unsupported",
  "activation_script",
  "output",
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export type WorkflowPhase = "prepare" | "preflight" | "activate" | "rollback" | "audit" | "status";
export type WorkflowOutcome = "prepared" | "preflight-passed" | "active" | "rolled-back" | "blocked";
export type RollbackOutcome = "not-requested" | "not-needed" | "succeeded" | "failed";
export type WorkflowExecutor = "filesystem" | "hardened-kmac";
export type OperationStatus =
  | "preparing"
  | "prepared"
  | "activating"
  | "active"
  | "needs-rollback"
  | "rolling-back"
  | "rolled-back"
  | "blocked";

export interface ReleaseIdentity {
  id: string;
  path: string;
  gitCommit: string;
  manifestDigest: string;
}

export interface DirectoryIdentity {
  device: number;
  inode: number;
}

export interface BasePaths {
  base: string;
  releasesRoot: string;
  current: string;
  activationRoot: string;
  operationsRoot: string;
  lock: string;
  audit: string;
  allowTemporaryRoots: boolean;
}

export interface ReleasePaths extends BasePaths {
  candidate: string;
  active: string;
}

export interface Bounded<T> {
  total: number;
  truncated: boolean;
  items: T[];
}

export interface ReleaseCheck {
  manifestValid: boolean;
  treeMatchesManifest: boolean;
  immutable: boolean;
  gitCommit: string | null;
  manifestDigest: string | null;
  differences: Bounded<FunctionalDifference>;
  identity: ReleaseIdentity | null;
  manifest: FunctionalManifest | null;
  directoryIdentity: DirectoryIdentity | null;
  failureStage: FailureStage;
}

export interface PreflightReport {
  schema: typeof WORKFLOW_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  phase: "preflight";
  ok: boolean;
  reviewedCommit: string;
  candidatePath: string | null;
  activePath: string | null;
  gitArtifact: {
    clean: boolean;
    gitCommit: string | null;
    differences: Bounded<GitArtifactDifference>;
  };
  candidate: {
    manifestValid: boolean;
    treeMatchesManifest: boolean;
    immutable: boolean;
    gitCommit: string | null;
    manifestDigest: string | null;
    differences: Bounded<FunctionalDifference>;
    artifactDifferences: Bounded<FunctionalDifference>;
  };
  active: {
    manifestValid: boolean;
    treeMatchesManifest: boolean;
    immutable: boolean;
    gitCommit: string | null;
    manifestDigest: string | null;
    differences: Bounded<FunctionalDifference>;
  };
  current: {
    linkPresent: boolean;
    targetPath: string | null;
    matchesActive: boolean;
  };
  plannedChanges: Bounded<FunctionalDifference>;
  failureStage: FailureStage;
}

export interface WorkflowHooks {
  afterSwitch?: () => void;
  afterRollbackSwitch?: () => void;
}

export interface WorkflowPathOptions {
  basePath: string;
  candidatePath: string;
  activePath: string;
  reviewedCommit: string;
  allowTemporaryRoots?: boolean;
}

export interface PreflightOptions extends WorkflowPathOptions {
  gitRoot: string;
}

export interface HardenedKmacOptions {
  runtimeBun: string;
  candidateConfig: string;
  expectedLiveMeshSha256: string;
  expectedCandidateMeshSha256: string;
  repositoryRoot: string;
  activationScript?: string;
  requireRemoteCodexControl?: boolean;
}

export interface ActivateOptions extends PreflightOptions {
  operationId: string;
  executor?: WorkflowExecutor;
  hooks?: WorkflowHooks;
  hardenedKmac?: HardenedKmacOptions;
}

export interface RollbackOptions extends WorkflowPathOptions {
  operationId: string;
  hooks?: WorkflowHooks;
}

export interface PrepareOptions {
  basePath: string;
  candidatePath: string;
  gitRoot: string;
  reviewedCommit: string;
  operationId?: string;
  executor?: WorkflowExecutor;
  allowTemporaryRoots?: boolean;
}

export interface OperationState {
  schema: typeof OPERATION_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  operationId: string;
  phase: "prepare" | "activate" | "rollback";
  status: OperationStatus;
  executor: WorkflowExecutor;
  startedAt: string;
  updatedAt: string;
  reviewedCommit: string;
  candidate: ReleaseIdentity | null;
  active: ReleaseIdentity | null;
  candidateDirectory: DirectoryIdentity | null;
  activeDirectory: DirectoryIdentity | null;
  failureStage: FailureStage;
  rollbackOutcome: RollbackOutcome;
}

export interface AuditRecord {
  schema: typeof AUDIT_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  sequence: number;
  previousDigest: string | null;
  recordDigest: string;
  operationId: string;
  phase: "prepare" | "preflight" | "activate" | "rollback";
  executor: WorkflowExecutor;
  startedAt: string;
  completedAt: string;
  reviewedCommit: string;
  oldRelease: ReleaseIdentity | null;
  newRelease: ReleaseIdentity | null;
  manifestDigest: string | null;
  outcome: WorkflowOutcome;
  failureStage: FailureStage;
  rollbackOutcome: RollbackOutcome;
}

export type AuditRecordInput = Omit<AuditRecord, "sequence" | "previousDigest" | "recordDigest">;

export interface WorkflowResult {
  schema: typeof WORKFLOW_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  ok: boolean;
  phase: WorkflowPhase;
  operationId: string | null;
  reviewedCommit: string | null;
  candidate: ReleaseIdentity | null;
  active: ReleaseIdentity | null;
  manifestDigest: string | null;
  outcome: WorkflowOutcome;
  failureStage: FailureStage;
  rollbackOutcome: RollbackOutcome;
  errorCode: string | null;
  preflight?: PreflightReport;
}

export interface ReleaseStatusResult {
  schema: typeof RELEASE_STATUS_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  ok: boolean;
  state: "idle" | "active" | "rollback-required" | "blocked";
  current: ReleaseIdentity | null;
  latestOperation: {
    operationId: string;
    status: OperationStatus;
    updatedAt: string;
    failureStage: FailureStage;
  } | null;
  lock: {
    held: boolean;
    stale: boolean;
    operationId: string | null;
    startedAt: string | null;
  };
  failureStage: FailureStage;
}

export interface AuditResult {
  schema: typeof AUDIT_RESULT_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  ok: boolean;
  operationId: string | null;
  total: number;
  truncated: boolean;
  records: AuditRecord[];
  failureStage: FailureStage;
}

export function isFailureStage(value: unknown): value is FailureStage {
  return typeof value === "string" && (FAILURE_STAGES as readonly string[]).includes(value);
}
