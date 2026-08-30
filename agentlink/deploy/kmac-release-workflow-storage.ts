import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPersistentAbsolutePath } from "./kmac-activation-gates";
import {
  AUDIT_RESULT_SCHEMA,
  AUDIT_SCHEMA,
  COMMIT_PATTERN,
  FAILURE_STAGES,
  LOCK_MAX_AGE_MS,
  LOCK_SCHEMA,
  MAX_AUDIT_BYTES,
  MAX_AUDIT_OUTPUT_RECORDS,
  MAX_AUDIT_RECORDS,
  MAX_LOCK_BYTES,
  MAX_PATH_LENGTH,
  MAX_MANIFEST_BYTES,
  MAX_OPERATION_FILES,
  MAX_OPERATION_ID_LENGTH,
  MAX_OUTPUT_BYTES,
  OPERATION_ID_PATTERN,
  OPERATION_SCHEMA,
  RELEASE_ID_PATTERN,
  SHA256_PATTERN,
  WORKFLOW_VERSION,
  type AuditRecord,
  type AuditRecordInput,
  type AuditResult,
  type BasePaths,
  type DirectoryIdentity,
  type FailureStage,
  type OperationState,
  type ReleaseIdentity,
  type ReleasePaths,
  type ReleaseStatusResult,
} from "./kmac-release-workflow-types";
import { fail, isNodeError, WorkflowError } from "./kmac-release-workflow-error";

const NOFOLLOW = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function pathHasTraversal(value: string): boolean {
  return value.split(/[\\/]/).some((part) => part === "." || part === "..");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function validateAbsolutePath(value: unknown, allowTemporaryRoots: boolean): string {
  if (typeof value !== "string"
    || !isAbsolute(value)
    || value.length === 0
    || value.length > MAX_PATH_LENGTH
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
    || pathHasTraversal(value)) {
    fail("path_validation", "invalid_path");
  }
  if (!allowTemporaryRoots && !isPersistentAbsolutePath(value)) {
    fail("path_validation", "non_persistent_path");
  }
  return value;
}

export function normalizeCommit(value: unknown): string {
  if (typeof value !== "string") fail("reviewed_commit", "invalid_reviewed_commit");
  const commit = value.trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) fail("reviewed_commit", "invalid_reviewed_commit");
  return commit;
}

export function normalizeOperationId(value: unknown): string {
  if (typeof value !== "string") fail("usage", "invalid_operation_id");
  const operationId = value.trim();
  if (operationId.length > MAX_OPERATION_ID_LENGTH || !OPERATION_ID_PATTERN.test(operationId)) {
    fail("usage", "invalid_operation_id");
  }
  return operationId;
}

export function normalizeReleaseId(value: unknown): string {
  if (typeof value !== "string") fail("path_validation", "invalid_release_id");
  const id = value.trim();
  if (!RELEASE_ID_PATTERN.test(id)) fail("path_validation", "invalid_release_id");
  return id;
}

function canonicalExistingDirectory(value: unknown, allowTemporaryRoots: boolean): string {
  validateAbsolutePath(value, allowTemporaryRoots);
  let stat;
  try {
    stat = lstatSync(value as string);
  } catch {
    fail("path_validation", "path_missing");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("path_validation", "directory_invalid");
  try {
    const canonical = realpathSync(value as string);
    validateAbsolutePath(canonical, allowTemporaryRoots);
    if (canonical !== value) fail("path_validation", "noncanonical_path");
    return canonical;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail("path_validation", "path_unreadable");
  }
}

export function canonicalExistingFile(value: unknown, allowTemporaryRoots: boolean): string {
  validateAbsolutePath(value, allowTemporaryRoots);
  let stat;
  try {
    stat = lstatSync(value as string);
  } catch {
    fail("path_validation", "path_missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("path_validation", "file_invalid");
  try {
    const canonical = realpathSync(value as string);
    validateAbsolutePath(canonical, allowTemporaryRoots);
    if (canonical !== value) fail("path_validation", "noncanonical_path");
    return canonical;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail("path_validation", "path_unreadable");
  }
}

function assertPrivateDirectory(path: string, stage: FailureStage): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(stage, "directory_missing");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(stage, "directory_invalid");
  if ((stat.mode & 0o077) !== 0) fail(stage, "directory_permissions_invalid");
}

function ensureDirectory(value: string, mode: number, allowTemporaryRoots: boolean): string {
  validateAbsolutePath(value, allowTemporaryRoots);
  const absolute = resolve(value);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    const next = join(current, part);
    let stat;
    try {
      stat = lstatSync(next);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") fail("path_validation", "directory_unavailable");
      try {
        mkdirSync(next, { mode });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          fail("path_validation", "directory_unavailable");
        }
      }
      try {
        stat = lstatSync(next);
      } catch {
        fail("path_validation", "directory_unavailable");
      }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("path_validation", "directory_invalid");
    current = next;
  }
  try {
    const canonical = realpathSync(absolute);
    if (canonical !== absolute) fail("path_validation", "noncanonical_path");
    return canonical;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail("path_validation", "directory_unavailable");
  }
}

function basePathsFor(value: unknown, allowTemporaryRoots: boolean, create: boolean): BasePaths {
  const base = create
    ? ensureDirectory(validateAbsolutePath(value, allowTemporaryRoots), 0o700, allowTemporaryRoots)
    : canonicalExistingDirectory(value, allowTemporaryRoots);
  assertPrivateDirectory(base, "path_validation");
  const releasesPath = join(base, "releases");
  const releasesRoot = create
    ? ensureDirectory(releasesPath, 0o700, allowTemporaryRoots)
    : canonicalExistingDirectory(releasesPath, allowTemporaryRoots);
  assertPrivateDirectory(releasesRoot, "path_validation");
  const activationPath = join(base, "activation");
  const activationRoot = create
    ? ensureDirectory(activationPath, 0o700, allowTemporaryRoots)
    : pathExists(activationPath)
      ? canonicalExistingDirectory(activationPath, allowTemporaryRoots)
      : activationPath;
  const operationsPath = join(activationRoot, "operations");
  const operationsRoot = pathExists(operationsPath)
    ? canonicalExistingDirectory(operationsPath, allowTemporaryRoots)
    : operationsPath;
  if (pathExists(activationRoot)) assertPrivateDirectory(activationRoot, "path_validation");
  if (pathExists(operationsRoot)) assertPrivateDirectory(operationsRoot, "path_validation");
  return {
    base,
    releasesRoot,
    current: join(base, "current"),
    activationRoot,
    operationsRoot,
    lock: join(activationRoot, "deploy.lock"),
    audit: join(activationRoot, "audit.jsonl"),
    allowTemporaryRoots,
  };
}

export function resolveBasePaths(options: {
  basePath: string;
  allowTemporaryRoots?: boolean;
  create?: boolean;
}): BasePaths {
  return basePathsFor(options.basePath, options.allowTemporaryRoots === true, options.create === true);
}

function directReleasePath(root: string, input: unknown, allowTemporaryRoots: boolean, mustExist: boolean): string {
  validateAbsolutePath(input, allowTemporaryRoots);
  const resolved = resolve(input as string);
  const id = normalizeReleaseId(basename(resolved));
  const expected = join(root, id);
  if (resolved !== expected || input !== resolved) fail("path_validation", "release_path_outside_allowlist");
  if (!mustExist) {
    if (pathExists(expected)) fail("candidate_exists", "candidate_exists");
    return expected;
  }
  const canonical = canonicalExistingDirectory(expected, allowTemporaryRoots);
  if (canonical !== expected) fail("path_validation", "release_path_outside_allowlist");
  return canonical;
}

export function resolveReleasePaths(options: {
  basePath: string;
  candidatePath: string;
  activePath: string;
  allowTemporaryRoots?: boolean;
}): ReleasePaths {
  const base = basePathsFor(options.basePath, options.allowTemporaryRoots === true, false);
  const candidate = directReleasePath(base.releasesRoot, options.candidatePath, base.allowTemporaryRoots, true);
  const active = directReleasePath(base.releasesRoot, options.activePath, base.allowTemporaryRoots, true);
  if (candidate === active) fail("path_validation", "candidate_active_same");
  return { ...base, candidate, active };
}

export function resolvePrepareTarget(options: {
  basePath: string;
  candidatePath: string;
  allowTemporaryRoots?: boolean;
}): { base: BasePaths; candidate: string; candidateExists: boolean } {
  const base = basePathsFor(options.basePath, options.allowTemporaryRoots === true, true);
  validateAbsolutePath(options.candidatePath, base.allowTemporaryRoots);
  const resolved = resolve(options.candidatePath);
  const id = normalizeReleaseId(basename(resolved));
  const candidate = join(base.releasesRoot, id);
  if (resolved !== candidate || options.candidatePath !== resolved) {
    fail("path_validation", "release_path_outside_allowlist");
  }
  return { base, candidate, candidateExists: pathExists(candidate) };
}

export function currentTarget(paths: BasePaths): { linkPresent: boolean; targetPath: string | null } {
  let stat;
  try {
    stat = lstatSync(paths.current);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { linkPresent: false, targetPath: null };
    return { linkPresent: true, targetPath: null };
  }
  if (!stat.isSymbolicLink()) return { linkPresent: true, targetPath: null };
  let raw;
  try {
    raw = readlinkSync(paths.current);
  } catch {
    return { linkPresent: true, targetPath: null };
  }
  const target = isAbsolute(raw) ? raw : resolve(dirname(paths.current), raw);
  try {
    const canonical = canonicalExistingDirectory(target, paths.allowTemporaryRoots);
    const id = basename(canonical);
    if (canonical !== target
      || dirname(canonical) !== paths.releasesRoot
      || !RELEASE_ID_PATTERN.test(id)) {
      return { linkPresent: true, targetPath: null };
    }
    return { linkPresent: true, targetPath: canonical };
  } catch {
    return { linkPresent: true, targetPath: null };
  }
}

export function operationPath(paths: BasePaths, operationId: string): string {
  const normalized = normalizeOperationId(operationId);
  return join(paths.operationsRoot, `${normalized}.json`);
}

function fsyncDirectory(path: string, stage: FailureStage): void {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    fsyncSync(fd);
  } catch {
    fail(stage, "directory_fsync_failed");
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // The fsync failure is the useful fixed-stage error.
      }
    }
  }
}

export function atomicWrite(
  path: string,
  content: string,
  mode: number,
  stage: FailureStage,
  maxBytes = MAX_OUTPUT_BYTES,
): void {
  if (Buffer.byteLength(content, "utf8") > maxBytes) fail(stage, "record_too_large");
  try {
    const destination = lstatSync(path);
    if (destination.isSymbolicLink()) fail(stage, "destination_symlink");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") fail(stage, "destination_unavailable");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd = -1;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path), stage);
  } catch (error) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the fixed-stage failure below.
      }
    }
    if (error instanceof WorkflowError) throw error;
    fail(stage, "atomic_write_failed");
  } finally {
    try {
      if (pathExists(temporary)) unlinkSync(temporary);
    } catch {
      // A failed cleanup must not turn a bounded workflow result into a raw error.
    }
  }
}

export function atomicSymlinkSwitch(
  current: string,
  target: string,
  stage: FailureStage,
  expectedCurrentTarget?: string,
): void {
  const temporary = `${current}.${randomUUID()}.tmp`;
  try {
    if (pathExists(temporary)) fail(stage, "switch_temporary_exists");
    let destination;
    try {
      destination = lstatSync(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") fail(stage, "current_link_invalid");
    }
    if (destination && !destination.isSymbolicLink()) fail(stage, "current_link_invalid");
    if (!destination && expectedCurrentTarget !== undefined) fail(stage, "current_link_changed");
    if (destination && expectedCurrentTarget !== undefined) {
      const raw = readlinkSync(current);
      const unresolved = isAbsolute(raw) ? raw : resolve(dirname(current), raw);
      if (realpathSync(unresolved) !== expectedCurrentTarget) fail(stage, "current_link_changed");
    }
    symlinkSync(target, temporary);
    if (readlinkSync(temporary) !== target) fail(stage, "switch_target_mismatch");
    renameSync(temporary, current);
    fsyncDirectory(dirname(current), stage);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail(stage, "current_link_switch_failed");
  } finally {
    try {
      if (pathExists(temporary)) unlinkSync(temporary);
    } catch {
      // The temporary name is unique and a cleanup failure must stay bounded.
    }
  }
}

export function atomicRenameDirectory(source: string, destination: string, stage: FailureStage): void {
  try {
    const sourceStat = lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail(stage, "staging_directory_invalid");
    if (pathExists(destination)) fail("candidate_exists", "candidate_exists");
    renameSync(source, destination);
    fsyncDirectory(dirname(destination), stage);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail(stage, "directory_rename_failed");
  }
}

export function readBounded(path: string, maxBytes: number, stage: FailureStage): string {
  return readBoundedBytes(path, maxBytes, stage).toString("utf8");
}

export function readBoundedBytes(path: string, maxBytes: number, stage: FailureStage): Buffer {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) fail(stage, "file_invalid");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > maxBytes) fail(stage, "file_invalid");
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return fail(stage, "file_unreadable");
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original fixed-stage failure.
      }
    }
  }
}

function validateDirectoryIdentity(value: unknown): value is DirectoryIdentity {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger((value as Record<string, unknown>).device)
    && Number.isSafeInteger((value as Record<string, unknown>).inode)
    && Number((value as Record<string, unknown>).device) >= 0
    && Number((value as Record<string, unknown>).inode) >= 0
    && Object.keys(value).sort().join(",") === "device,inode";
}

function identityPathSafe(base: BasePaths, value: ReleaseIdentity): boolean {
  return RELEASE_ID_PATTERN.test(value.id)
    && isSafeStoredPath(value.path, base.allowTemporaryRoots)
    && value.path === join(base.releasesRoot, value.id)
    && COMMIT_PATTERN.test(value.gitCommit)
    && SHA256_PATTERN.test(value.manifestDigest);
}

function isSafeStoredPath(value: unknown, allowTemporaryRoots: boolean): value is string {
  return typeof value === "string"
    && isAbsolute(value)
    && value.length <= MAX_PATH_LENGTH
    && !value.includes("\0")
    && !value.includes("\n")
    && !value.includes("\r")
    && !pathHasTraversal(value)
    && (allowTemporaryRoots || isPersistentAbsolutePath(value));
}

export function validateReleaseIdentity(value: unknown, base?: BasePaths): value is ReleaseIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "gitCommit,id,manifestDigest,path"
    || typeof record.id !== "string"
    || typeof record.path !== "string"
    || typeof record.gitCommit !== "string"
    || typeof record.manifestDigest !== "string"
    || !RELEASE_ID_PATTERN.test(record.id)
    || !isSafeStoredPath(record.path, true)
    || record.path.length > MAX_PATH_LENGTH
    || !COMMIT_PATTERN.test(record.gitCommit)
    || !SHA256_PATTERN.test(record.manifestDigest)) return false;
  return base ? identityPathSafe(base, record as unknown as ReleaseIdentity) : true;
}

const OPERATION_KEYS = "active,activeDirectory,candidate,candidateDirectory,executor,failureStage,operationId,phase,reviewedCommit,rollbackOutcome,schema,startedAt,status,updatedAt,version";

function validateState(value: unknown, base: BasePaths, expectedOperationId: string): OperationState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("operation_state", "operation_state_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== OPERATION_KEYS
    || record.schema !== OPERATION_SCHEMA
    || record.version !== WORKFLOW_VERSION
    || record.operationId !== expectedOperationId
    || !OPERATION_ID_PATTERN.test(String(record.operationId))
    || !["prepare", "activate", "rollback"].includes(String(record.phase))
    || !["filesystem", "hardened-kmac"].includes(String(record.executor))
    || !["preparing", "prepared", "activating", "active", "needs-rollback", "rolling-back", "rolled-back", "blocked"].includes(String(record.status))
    || !isTimestamp(record.startedAt)
    || !isTimestamp(record.updatedAt)
    || !COMMIT_PATTERN.test(String(record.reviewedCommit))
    || !FAILURE_STAGES.includes(record.failureStage as FailureStage)
    || !["not-requested", "not-needed", "succeeded", "failed"].includes(String(record.rollbackOutcome))
    || (record.candidate !== null && !validateReleaseIdentity(record.candidate, base))
    || (record.active !== null && !validateReleaseIdentity(record.active, base))
    || (record.candidateDirectory !== null && !validateDirectoryIdentity(record.candidateDirectory))
    || (record.activeDirectory !== null && !validateDirectoryIdentity(record.activeDirectory))) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.candidate === null && record.candidateDirectory !== null) fail("operation_state", "operation_state_invalid");
  if (record.active === null && record.activeDirectory !== null) fail("operation_state", "operation_state_invalid");
  if (Date.parse(record.updatedAt as string) < Date.parse(record.startedAt as string)) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.candidate !== null && record.active !== null && record.candidate.path === record.active.path) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.candidate !== null && record.candidate.gitCommit !== record.reviewedCommit) fail("operation_state", "operation_state_invalid");
  if (record.phase !== "prepare" && (record.candidate === null || record.active === null)) fail("operation_state", "operation_state_invalid");
  if (record.status === "prepared"
    && (record.phase !== "prepare" || record.candidate === null || record.candidateDirectory === null
      || record.failureStage !== "none" || record.rollbackOutcome !== "not-requested")) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.status === "active"
    && (record.phase !== "activate" || record.candidate === null || record.active === null
      || record.candidateDirectory === null || record.activeDirectory === null
      || record.failureStage !== "none" || record.rollbackOutcome !== "not-needed")) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.status === "rolled-back"
    && (record.phase !== "rollback" || record.candidate === null || record.active === null
      || record.candidateDirectory === null || record.activeDirectory === null
      || record.failureStage !== "none" || record.rollbackOutcome !== "succeeded")) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.status === "needs-rollback"
    && (record.phase !== "activate" && record.phase !== "rollback" || record.candidate === null || record.active === null
      || record.candidateDirectory === null || record.activeDirectory === null
      || record.rollbackOutcome === "succeeded")) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.status === "rolling-back"
    && (record.phase !== "rollback" || record.candidate === null || record.active === null
      || record.candidateDirectory === null || record.activeDirectory === null
      || record.rollbackOutcome !== "failed")) {
    fail("operation_state", "operation_state_invalid");
  }
  if (record.status === "activating" && (record.phase !== "activate" || record.candidate === null || record.active === null)) {
    fail("operation_state", "operation_state_invalid");
  }
  return record as unknown as OperationState;
}

export function readOperationState(paths: BasePaths, operationId: string): OperationState | null {
  const normalized = normalizeOperationId(operationId);
  const path = operationPath(paths, normalized);
  if (!pathExists(path)) return null;
  const content = readBounded(path, MAX_OUTPUT_BYTES, "operation_state");
  try {
    return validateState(JSON.parse(content), paths, normalized);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail("operation_state", "operation_state_invalid");
  }
}

export function persistOperationState(paths: BasePaths, state: OperationState): void {
  const operations = canonicalExistingDirectory(paths.operationsRoot, paths.allowTemporaryRoots);
  if (operations !== paths.operationsRoot) fail("operation_state", "operations_path_invalid");
  atomicWrite(operationPath(paths, state.operationId), `${JSON.stringify(state)}\n`, 0o600, "operation_state");
}

export function updateOperationState(state: OperationState, patch: Partial<OperationState>): OperationState {
  return { ...state, ...patch, updatedAt: new Date().toISOString() };
}

function auditWithoutDigest(record: Omit<AuditRecord, "recordDigest">): Record<string, unknown> {
  return {
    schema: record.schema,
    version: record.version,
    sequence: record.sequence,
    previousDigest: record.previousDigest,
    operationId: record.operationId,
    phase: record.phase,
    executor: record.executor,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    reviewedCommit: record.reviewedCommit,
    oldRelease: record.oldRelease,
    newRelease: record.newRelease,
    manifestDigest: record.manifestDigest,
    outcome: record.outcome,
    failureStage: record.failureStage,
    rollbackOutcome: record.rollbackOutcome,
  };
}

function digestAudit(record: Omit<AuditRecord, "recordDigest">): string {
  return createHash("sha256").update(JSON.stringify(auditWithoutDigest(record))).digest("hex");
}

const AUDIT_KEYS = "completedAt,executor,failureStage,manifestDigest,newRelease,oldRelease,operationId,outcome,phase,previousDigest,recordDigest,reviewedCommit,rollbackOutcome,schema,sequence,startedAt,version";

function auditSemantics(record: AuditRecord): boolean {
  const phaseOutcomes: Record<AuditRecord["phase"], readonly AuditRecord["outcome"][]> = {
    prepare: ["prepared", "blocked"],
    preflight: ["preflight-passed", "blocked"],
    activate: ["active", "blocked"],
    rollback: ["rolled-back", "blocked"],
  };
  if (!phaseOutcomes[record.phase].includes(record.outcome)) return false;
  if (record.phase === "prepare" && record.oldRelease !== null) return false;
  if (record.phase === "rollback" && (record.oldRelease === null || record.newRelease === null)) return false;
  if (record.outcome === "blocked" && record.failureStage === "none") return false;
  if (record.outcome !== "blocked" && record.failureStage !== "none") return false;
  if (record.outcome !== "blocked" && record.newRelease === null) return false;
  if ((record.newRelease === null && record.manifestDigest !== null)
    || (record.newRelease !== null && record.manifestDigest !== record.newRelease.manifestDigest)) return false;
  if ((record.phase === "prepare" || record.phase === "activate")
    && record.newRelease !== null
    && record.newRelease.gitCommit !== record.reviewedCommit) return false;
  if (record.phase === "rollback"
    && record.oldRelease !== null
    && record.oldRelease.gitCommit !== record.reviewedCommit) return false;
  if (record.outcome === "active" && (record.oldRelease === null || record.newRelease === null)) return false;
  if (record.outcome === "prepared" && record.newRelease === null) return false;
  if (record.outcome === "rolled-back" && (record.oldRelease === null || record.newRelease === null)) return false;
  if (record.outcome === "rolled-back" && record.rollbackOutcome !== "succeeded") return false;
  if (record.outcome === "active" && record.rollbackOutcome !== "not-needed") return false;
  if (record.outcome === "prepared" && record.rollbackOutcome !== "not-requested") return false;
  if (record.outcome === "preflight-passed"
    && (record.phase !== "preflight" || record.oldRelease !== null || record.newRelease !== null
      || record.manifestDigest !== null || record.rollbackOutcome !== "not-requested")) return false;
  if (record.phase === "rollback" && record.rollbackOutcome !== "succeeded" && record.rollbackOutcome !== "failed") return false;
  if (record.phase === "prepare" && record.rollbackOutcome !== "not-requested" && record.rollbackOutcome !== "not-needed") return false;
  if (record.phase === "activate" && record.rollbackOutcome !== "not-needed" && record.rollbackOutcome !== "not-requested") return false;
  if (record.phase === "preflight" && record.rollbackOutcome !== "not-requested") return false;
  if (record.phase === "rollback" && record.outcome === "blocked" && record.rollbackOutcome !== "failed") return false;
  if (record.phase === "rollback" && record.outcome === "rolled-back" && record.rollbackOutcome !== "succeeded") return false;
  if (record.oldRelease !== null && record.newRelease !== null && record.oldRelease.path === record.newRelease.path) return false;
  return true;
}

export function auditRecordValid(value: unknown, base: BasePaths): value is AuditRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== AUDIT_KEYS
    || record.schema !== AUDIT_SCHEMA
    || record.version !== WORKFLOW_VERSION
    || !Number.isSafeInteger(record.sequence)
    || Number(record.sequence) < 1
    || (record.previousDigest !== null && !SHA256_PATTERN.test(String(record.previousDigest)))
    || !SHA256_PATTERN.test(String(record.recordDigest))
    || typeof record.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(record.operationId)
    || !["prepare", "preflight", "activate", "rollback"].includes(String(record.phase))
    || !["filesystem", "hardened-kmac"].includes(String(record.executor))
    || !isTimestamp(record.startedAt)
    || !isTimestamp(record.completedAt)
    || !COMMIT_PATTERN.test(String(record.reviewedCommit))
    || (record.manifestDigest !== null && !SHA256_PATTERN.test(String(record.manifestDigest)))
    || !["prepared", "preflight-passed", "active", "rolled-back", "blocked"].includes(String(record.outcome))
    || !FAILURE_STAGES.includes(record.failureStage as FailureStage)
    || !["not-requested", "not-needed", "succeeded", "failed"].includes(String(record.rollbackOutcome))
    || (record.oldRelease !== null && !validateReleaseIdentity(record.oldRelease, base))
    || (record.newRelease !== null && !validateReleaseIdentity(record.newRelease, base))) return false;
  if (Date.parse(record.completedAt as string) < Date.parse(record.startedAt as string)) return false;
  return auditSemantics(record as unknown as AuditRecord)
    && digestAudit(record as unknown as Omit<AuditRecord, "recordDigest">) === record.recordDigest;
}

export function appendAudit(paths: BasePaths, input: AuditRecordInput): AuditRecord {
  const existing = readAuditRecords(paths);
  const previous = existing.at(-1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const withoutDigest: Omit<AuditRecord, "recordDigest"> = {
    ...input,
    sequence,
    previousDigest: previous?.recordDigest ?? null,
  };
  const record: AuditRecord = {
    ...withoutDigest,
    recordDigest: digestAudit(withoutDigest),
  };
  if (!auditRecordValid(record, paths)) fail("audit", "audit_record_invalid");
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_BYTES) fail("audit", "audit_record_too_large");
  let existingSize = 0;
  if (pathExists(paths.audit)) {
    const stat = lstatSync(paths.audit);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("audit", "audit_file_invalid");
    existingSize = stat.size;
  }
  if (existingSize + Buffer.byteLength(line, "utf8") > MAX_AUDIT_BYTES) fail("audit", "audit_file_full");
  let fd = -1;
  try {
    fd = openSync(paths.audit, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600);
    const bytes = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    fsyncDirectory(dirname(paths.audit), "audit");
  } catch (error) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the fixed-stage failure.
      }
    }
    if (error instanceof WorkflowError) throw error;
    fail("audit", "audit_append_failed");
  }
  return record;
}

export function readAuditRecords(paths: BasePaths): AuditRecord[] {
  if (!pathExists(paths.audit)) return [];
  const stat = lstatSync(paths.audit);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("audit", "audit_file_invalid");
  const content = readBounded(paths.audit, MAX_AUDIT_BYTES, "audit");
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) fail("audit", "audit_record_invalid");
  const lines = content.split("\n").slice(0, -1);
  if (lines.length > MAX_AUDIT_RECORDS || lines.some((line) => line.length === 0)) fail("audit", "audit_record_limit");
  const records: AuditRecord[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_BYTES) fail("audit", "audit_record_invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail("audit", "audit_record_invalid");
    }
    if (!auditRecordValid(parsed, paths)) fail("audit", "audit_record_invalid");
    const record = parsed as AuditRecord;
    const previous = records.at(-1);
    if (record.sequence !== records.length + 1
      || record.previousDigest !== (previous?.recordDigest ?? null)) {
      fail("audit", "audit_chain_invalid");
    }
    records.push(record);
  }
  return records;
}

interface LockMetadata {
  schema: typeof LOCK_SCHEMA;
  version: typeof WORKFLOW_VERSION;
  nonce: string;
  operationId: string;
  pid: number;
  host: string;
  startedAt: string;
  reviewedCommit: string;
  candidatePath: string | null;
  activePath: string | null;
  currentPath: string;
}

function lockMetadata(paths: BasePaths, operationId: string, reviewedCommit: string, candidatePath: string | null, activePath: string | null): LockMetadata {
  return {
    schema: LOCK_SCHEMA,
    version: WORKFLOW_VERSION,
    nonce: randomUUID(),
    operationId: normalizeOperationId(operationId),
    pid: process.pid,
    host: hostname().slice(0, 128),
    startedAt: new Date().toISOString(),
    reviewedCommit: normalizeCommit(reviewedCommit),
    candidatePath,
    activePath,
    currentPath: paths.current,
  };
}

const LOCK_KEYS = "activePath,candidatePath,currentPath,host,nonce,operationId,pid,reviewedCommit,schema,startedAt,version";

function validLockMetadata(value: unknown, paths: BasePaths): value is LockMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === LOCK_KEYS
    && record.schema === LOCK_SCHEMA
    && record.version === WORKFLOW_VERSION
    && typeof record.nonce === "string"
    && /^[0-9a-f-]{36}$/.test(record.nonce)
    && typeof record.operationId === "string"
    && OPERATION_ID_PATTERN.test(record.operationId)
    && Number.isSafeInteger(record.pid)
    && Number(record.pid) > 0
    && typeof record.host === "string"
    && record.host.length > 0
    && record.host.length <= 128
    && isTimestamp(record.startedAt)
    && COMMIT_PATTERN.test(String(record.reviewedCommit))
    && (record.candidatePath === null
      || (typeof record.candidatePath === "string"
        && isSafeStoredPath(record.candidatePath, paths.allowTemporaryRoots)
        && RELEASE_ID_PATTERN.test(basename(record.candidatePath))
        && record.candidatePath === join(paths.releasesRoot, basename(record.candidatePath))))
    && (record.activePath === null
      || (typeof record.activePath === "string"
        && isSafeStoredPath(record.activePath, paths.allowTemporaryRoots)
        && RELEASE_ID_PATTERN.test(basename(record.activePath))
        && record.activePath === join(paths.releasesRoot, basename(record.activePath))))
    && record.currentPath === paths.current;
}

function lockIsStale(value: LockMetadata): boolean {
  return Date.now() - Date.parse(value.startedAt) > LOCK_MAX_AGE_MS;
}

export class DeploymentLock {
  private acquired = false;

  constructor(
    private readonly paths: BasePaths,
    private readonly content: string,
  ) {}

  acquire(): void {
    let fd = -1;
    try {
      if (!pathExists(this.paths.activationRoot) || !pathExists(this.paths.operationsRoot)) {
        fail("lock", "activation_directories_missing");
      }
      fd = openSync(this.paths.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      const bytes = Buffer.from(this.content, "utf8");
      if (bytes.byteLength > MAX_LOCK_BYTES) fail("lock", "lock_metadata_too_large");
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      fsyncDirectory(this.paths.activationRoot, "lock");
      this.acquired = true;
    } catch (error) {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the fixed-stage failure.
        }
      }
      if (error instanceof WorkflowError) throw error;
      if (isNodeError(error) && error.code === "EEXIST") {
        let existing: unknown;
        try {
          existing = JSON.parse(readBounded(this.paths.lock, MAX_LOCK_BYTES, "lock"));
        } catch {
          fail("lock", "lock_metadata_invalid");
        }
        if (!validLockMetadata(existing, this.paths)) fail("lock", "lock_metadata_invalid");
        fail("lock", lockIsStale(existing) ? "stale_lock_owner" : "deployment_lock_held");
      }
      fail("lock", "lock_acquire_failed");
    }
  }

  release(): void {
    if (!this.acquired) return;
    const current = readBounded(this.paths.lock, MAX_LOCK_BYTES, "lock");
    if (current !== this.content) fail("lock", "lock_owner_changed");
    const stat = lstatSync(this.paths.lock);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("lock", "lock_owner_changed");
    unlinkSync(this.paths.lock);
    fsyncDirectory(this.paths.activationRoot, "lock");
    this.acquired = false;
  }
}

export function acquireLock(
  paths: BasePaths,
  operationId: string,
  reviewedCommit: string,
  candidatePath: string | null,
  activePath: string | null,
): DeploymentLock {
  const metadata = lockMetadata(paths, operationId, reviewedCommit, candidatePath, activePath);
  const content = `${JSON.stringify(metadata)}\n`;
  const lock = new DeploymentLock(paths, content);
  lock.acquire();
  return lock;
}

export function inspectLock(paths: BasePaths): ReleaseStatusResult["lock"] {
  if (!pathExists(paths.lock)) return { held: false, stale: false, operationId: null, startedAt: null };
  try {
    const value = JSON.parse(readBounded(paths.lock, MAX_LOCK_BYTES, "lock"));
    if (!validLockMetadata(value, paths)) return { held: true, stale: true, operationId: null, startedAt: null };
    return {
      held: true,
      stale: lockIsStale(value),
      operationId: value.operationId,
      startedAt: value.startedAt,
    };
  } catch {
    return { held: true, stale: true, operationId: null, startedAt: null };
  }
}

export function ensureActivationDirectories(paths: BasePaths): BasePaths {
  const activationRoot = ensureDirectory(paths.activationRoot, 0o700, paths.allowTemporaryRoots);
  const operationsRoot = ensureDirectory(join(activationRoot, "operations"), 0o700, paths.allowTemporaryRoots);
  assertPrivateDirectory(activationRoot, "path_validation");
  assertPrivateDirectory(operationsRoot, "path_validation");
  return {
    ...paths,
    activationRoot,
    operationsRoot,
    lock: join(activationRoot, "deploy.lock"),
    audit: join(activationRoot, "audit.jsonl"),
  };
}

export function makeAuditResult(paths: BasePaths, operationId: string | null): AuditResult {
  try {
    const records = readAuditRecords(paths).filter((record) => operationId === null || record.operationId === operationId);
    let visible = records.slice(Math.max(0, records.length - MAX_AUDIT_OUTPUT_RECORDS));
    const fits = (items: AuditRecord[]): boolean => Buffer.byteLength(JSON.stringify({
      schema: AUDIT_RESULT_SCHEMA,
      version: WORKFLOW_VERSION,
      ok: true,
      operationId,
      total: records.length,
      truncated: items.length !== records.length,
      records: items,
      failureStage: "none",
    }), "utf8") <= MAX_OUTPUT_BYTES;
    while (visible.length > 0 && !fits(visible)) visible = visible.slice(1);
    return {
      schema: AUDIT_RESULT_SCHEMA,
      version: WORKFLOW_VERSION,
      ok: true,
      operationId,
      total: records.length,
      truncated: visible.length !== records.length,
      records: visible,
      failureStage: "none",
    };
  } catch (error) {
    return {
      schema: AUDIT_RESULT_SCHEMA,
      version: WORKFLOW_VERSION,
      ok: false,
      operationId,
      total: 0,
      truncated: false,
      records: [],
      failureStage: error instanceof WorkflowError ? error.stage : "audit",
    };
  }
}

export function operationIds(paths: BasePaths): string[] {
  if (!pathExists(paths.operationsRoot)) return [];
  const root = canonicalExistingDirectory(paths.operationsRoot, paths.allowTemporaryRoots);
  if (root !== paths.operationsRoot) fail("operation_state", "operations_path_invalid");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > MAX_OPERATION_FILES) fail("operation_state", "operation_file_limit");
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) fail("operation_state", "operation_file_invalid");
    ids.push(normalizeOperationId(entry.name.slice(0, -5)));
  }
  return ids.sort();
}

export function resolveGitRepositoryRoot(value: unknown, allowTemporaryRoots: boolean): string {
  const input = canonicalExistingDirectory(value, allowTemporaryRoots);
  const result = spawnSync("git", ["-C", input, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") fail("git_artifact", "git_unavailable");
  return canonicalExistingDirectory(result.stdout.trim(), allowTemporaryRoots);
}

export function resolveGitRoot(value: unknown, allowTemporaryRoots: boolean): string {
  const input = canonicalExistingDirectory(value, allowTemporaryRoots);
  const top = resolveGitRepositoryRoot(input, allowTemporaryRoots);
  const prefix = relative(top, input);
  if (prefix === "" || (!prefix.startsWith("..") && !isAbsolute(prefix))) return input;
  fail("git_artifact", "git_root_invalid");
}

export function statDirectoryIdentity(path: string): DirectoryIdentity | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? { device: stat.dev, inode: stat.ino } : null;
  } catch {
    return null;
  }
}

export function identitiesEqual(left: DirectoryIdentity | null, right: DirectoryIdentity | null): boolean {
  return left !== null && right !== null && left.device === right.device && left.inode === right.inode;
}

export function hashFile(path: string, maxBytes = MAX_MANIFEST_BYTES, stage: FailureStage = "candidate_content"): string {
  return createHash("sha256").update(readBoundedBytes(path, maxBytes, stage)).digest("hex");
}

export function fileMode(path: string): number {
  try {
    const stat = lstatSync(path);
    return stat.mode;
  } catch {
    fail("path_validation", "file_missing");
  }
}

export function chmodImmutable(path: string, mode: number, expected: DirectoryIdentity): void {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (stat.dev !== expected.device || stat.ino !== expected.inode) fail("candidate_content", "release_changed");
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail("candidate_content", "release_immutable_failed");
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the fixed-stage failure.
      }
    }
  }
}
