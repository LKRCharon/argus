import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  AUDIT_SCHEMA,
  MAX_CHILD_OUTPUT_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_OUTPUT_BYTES,
  SHA256_PATTERN,
  WORKFLOW_SCHEMA,
  WORKFLOW_VERSION,
  type AuditRecord,
  type AuditRecordInput,
  type AuditResult,
  type BasePaths,
  type FailureStage,
  type HardenedKmacOptions,
  type OperationState,
  type PrepareOptions,
  type PreflightOptions,
  type ReleaseIdentity,
  type ReleaseStatusResult,
  type RollbackOptions,
  type WorkflowExecutor,
  type WorkflowPhase,
  type WorkflowResult,
} from "./kmac-release-workflow-types";
import { failureFrom, fail, WorkflowError } from "./kmac-release-workflow-error";
import {
  appendAudit,
  acquireLock,
  atomicRenameImmutableDirectory,
  atomicSymlinkSwitch,
  atomicWrite,
  canonicalExistingFile,
  currentTarget,
  ensureActivationDirectories,
  fileMode,
  hashFile,
  identitiesEqual,
  inspectLock,
  makeAuditResult,
  normalizeCommit,
  normalizeOperationId,
  operationIds,
  persistOperationState,
  readAuditRecords,
  readOperationState,
  resolveBasePaths,
  resolvePrepareTarget,
  resolveReleasePaths,
  resolveGitRoot,
  updateOperationState,
} from "./kmac-release-workflow-storage";
import {
  archiveGitTree,
  assertArchivedTreeSafe,
  checkRelease,
  evaluatePreflight,
  identityMatchesDirectory,
  inspectCleanGitManifest,
  makeImmutableTree,
  makeStagingTreeRemovable,
  releaseCheckIsUsable,
  requireReleaseCheck,
} from "./kmac-release-workflow-manifest";
import {
  compareFunctionalManifests,
  type FunctionalManifest,
} from "../scripts/release-manifest";

const DEFAULT_BASE_PATH = join(homedir(), "Library", "Application Support", "AgentLink");
const FUNCTIONAL_MANIFEST_FILE = ".argus-functional-manifest.json";
const FIXED_ACTIVATION_SCRIPT = "deploy/activate-kmac-watcher.sh";
const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_MESH_CONFIG_BYTES = 16 * 1024 * 1024;
const DEPENDENCY_INSTALL_TIMEOUT_MS = 180_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 30_000;
const DEPENDENCY_INSTALL_ARGS = Object.freeze([
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--backend=copyfile",
  "--no-progress",
  "--no-summary",
]);

function result(
  phase: WorkflowPhase,
  values: Partial<WorkflowResult> = {},
): WorkflowResult {
  return {
    schema: WORKFLOW_SCHEMA,
    version: WORKFLOW_VERSION,
    ok: false,
    phase,
    operationId: null,
    reviewedCommit: null,
    candidate: null,
    active: null,
    manifestDigest: null,
    outcome: "blocked",
    failureStage: "none",
    rollbackOutcome: "not-requested",
    errorCode: null,
    ...values,
  };
}

function blocked(
  phase: WorkflowPhase,
  error: unknown,
  values: Partial<WorkflowResult> = {},
): WorkflowResult {
  const failure = failureFrom(error);
  return result(phase, {
    ...values,
    ok: false,
    outcome: "blocked",
    failureStage: failure.stage,
    errorCode: failure.code,
  });
}

function identityEqual(left: ReleaseIdentity | null, right: ReleaseIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id
    && left.path === right.path
    && left.gitCommit === right.gitCommit
    && left.manifestDigest === right.manifestDigest;
}

function identityAt(check: ReturnType<typeof checkRelease>, stage: FailureStage, requireImmutable: boolean): {
  identity: ReleaseIdentity;
  directory: { device: number; inode: number };
  manifest: FunctionalManifest;
} {
  const verified = requireReleaseCheck(check, stage, requireImmutable);
  return {
    identity: verified.identity,
    directory: verified.directoryIdentity,
    manifest: verified.manifest,
  };
}

function checkReleaseAt(
  path: string,
  requireImmutable: boolean,
  manifestStage: FailureStage,
  contentStage: FailureStage,
  mutabilityStage: FailureStage,
): ReturnType<typeof checkRelease> {
  return checkRelease(path, { requireImmutable, manifestStage, contentStage, mutabilityStage });
}

function verifyReleaseIdentity(
  path: string,
  expected: ReleaseIdentity,
  expectedDirectory: { device: number; inode: number } | null,
  requireImmutable: boolean,
  stage: FailureStage,
): ReturnType<typeof identityAt> {
  const check = checkReleaseAt(
    path,
    requireImmutable,
    stage,
    stage,
    stage,
  );
  const verified = identityAt(check, stage, requireImmutable);
  if (!identityEqual(verified.identity, expected)
    || (expectedDirectory !== null && !identitiesEqual(verified.directory, expectedDirectory))) {
    fail(stage, "release_identity_mismatch");
  }
  return verified;
}

function auditInput(
  state: OperationState,
  phase: AuditRecordInput["phase"],
  oldRelease: ReleaseIdentity | null,
  newRelease: ReleaseIdentity | null,
  outcome: AuditRecordInput["outcome"],
  failureStage: FailureStage,
  rollbackOutcome: AuditRecordInput["rollbackOutcome"],
): AuditRecordInput {
  return {
    schema: AUDIT_SCHEMA,
    version: WORKFLOW_VERSION,
    operationId: state.operationId,
    phase,
    executor: state.executor,
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
    reviewedCommit: state.reviewedCommit,
    oldRelease,
    newRelease,
    manifestDigest: newRelease?.manifestDigest ?? null,
    outcome,
    failureStage,
    rollbackOutcome,
  };
}

function auditMatches(
  record: AuditRecord,
  input: AuditRecordInput,
): boolean {
  return record.operationId === input.operationId
    && record.phase === input.phase
    && record.executor === input.executor
    && record.outcome === input.outcome
    && record.failureStage === input.failureStage
    && record.rollbackOutcome === input.rollbackOutcome
    && record.reviewedCommit === input.reviewedCommit
    && identityEqual(record.oldRelease, input.oldRelease)
    && identityEqual(record.newRelease, input.newRelease)
    && record.manifestDigest === input.manifestDigest;
}

function appendAuditOnce(paths: BasePaths, input: AuditRecordInput): void {
  const records = readAuditRecords(paths);
  if (records.some((record) => auditMatches(record, input))) return;
  appendAudit(paths, input);
}

function terminalAudit(
  paths: BasePaths,
  operationId: string,
  phase: AuditRecordInput["phase"],
  outcome: AuditRecordInput["outcome"],
  newRelease: ReleaseIdentity,
): boolean {
  return readAuditRecords(paths).some((record) => record.operationId === operationId
    && record.phase === phase
    && record.outcome === outcome
    && record.failureStage === "none"
    && record.newRelease !== null
    && identityEqual(record.newRelease, newRelease)
    && record.manifestDigest === newRelease.manifestDigest);
}

function prepareState(
  operationId: string,
  executor: WorkflowExecutor,
  reviewedCommit: string,
  candidate: ReleaseIdentity,
  candidateDirectory: { device: number; inode: number },
  startedAt: string,
): OperationState {
  return {
    schema: "argus.kmac.release-operation",
    version: WORKFLOW_VERSION,
    operationId,
    phase: "prepare",
    status: "prepared",
    executor,
    startedAt,
    updatedAt: startedAt,
    reviewedCommit,
    candidate,
    active: null,
    candidateDirectory,
    activeDirectory: null,
    failureStage: "none",
    rollbackOutcome: "not-requested",
  };
}

function validateExecutor(value: unknown): WorkflowExecutor {
  if (value === "filesystem" || value === "hardened-kmac") return value;
  fail("usage", "invalid_executor");
}

function validateOperationRequest(
  state: OperationState,
  operationId: string,
  reviewedCommit: string,
  candidatePath: string,
  activePath?: string,
): void {
  if (state.operationId !== operationId
    || state.reviewedCommit !== reviewedCommit
    || state.candidate?.path !== candidatePath
    || (activePath !== undefined && state.active?.path !== activePath)) {
    fail("stale_request", "operation_request_mismatch");
  }
}

function stagingPathIsSafe(staging: string, releasesRoot: string): boolean {
  return staging.startsWith(`${releasesRoot}/.kmac-prepare-`)
    && staging.length <= MAX_OUTPUT_BYTES;
}

function removeStaging(staging: string, releasesRoot: string): void {
  if (!stagingPathIsSafe(staging, releasesRoot)) return;
  try {
    makeStagingTreeRemovable(staging);
  } catch {
    // A failed install normally leaves a writable tree; removal still gets a chance.
  }
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    // The private staging name is never published as a candidate.
  }
}

function runtimePathIsFixed(base: string, runtimeBun: string): boolean {
  const path = relative(join(base, "runtime"), runtimeBun);
  const parts = path.split(sep);
  return parts.length === 3
    && /^bun-[0-9]+\.[0-9]+\.[0-9]+$/.test(parts[0]!)
    && parts[1] === "bin"
    && parts[2] === "bun";
}

function validatePrepareRuntime(paths: BasePaths, executor: WorkflowExecutor, value: unknown): string {
  const runtimeBun = canonicalExistingFile(value, paths.allowTemporaryRoots);
  if ((fileMode(runtimeBun) & 0o111) === 0) fail("path_validation", "runtime_not_executable");
  if (executor === "hardened-kmac" && !runtimePathIsFixed(paths.base, runtimeBun)) {
    fail("path_validation", "runtime_outside_allowlist");
  }
  return runtimeBun;
}

function fixedPrepareEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: FIXED_PATH,
    HOME: homedir(),
    CI: "1",
    NO_COLOR: "1",
  };
}

function installFrozenDependencies(runtimeBun: string, staging: string): void {
  const child = spawnSync(runtimeBun, [...DEPENDENCY_INSTALL_ARGS], {
    cwd: staging,
    env: fixedPrepareEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
  });
  if (child.error || child.status !== 0) fail("candidate_write", "dependency_install_failed");
}

function probeCandidateRuntime(runtimeBun: string, staging: string): void {
  const child = spawnSync(runtimeBun, [
    "run",
    "--no-install",
    "--no-env-file",
    "packages/daemon/src/index.ts",
  ], {
    cwd: staging,
    env: fixedPrepareEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CANDIDATE_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
  });
  if (child.error || child.status !== 0) fail("candidate_content", "candidate_runtime_probe_failed");
}

function verifyPreparedCandidate(
  candidatePath: string,
  expectedManifest: FunctionalManifest,
): ReturnType<typeof identityAt> {
  const check = checkReleaseAt(
    candidatePath,
    true,
    "candidate_manifest",
    "candidate_content",
    "candidate_mutability",
  );
  const verified = identityAt(check, "candidate_manifest", true);
  if (verified.identity.gitCommit !== expectedManifest.gitCommit
    || compareFunctionalManifests(expectedManifest, verified.manifest).length !== 0) {
    fail("candidate_manifest", "candidate_manifest_mismatch");
  }
  return verified;
}

export function prepareRelease(options: PrepareOptions): WorkflowResult {
  const phase: WorkflowPhase = "prepare";
  let operationId: string | null = null;
  let reviewedCommit: string | null = null;
  let candidate: ReleaseIdentity | null = null;
  let paths: BasePaths | null = null;
  let lock: ReturnType<typeof acquireLock> | null = null;
  let state: OperationState | null = null;
  let staging: string | null = null;
  let response: WorkflowResult;
  try {
    operationId = options.operationId === undefined
      ? `kmac-${randomUUID()}`
      : normalizeOperationId(options.operationId);
    reviewedCommit = normalizeCommit(options.reviewedCommit);
    const executor = validateExecutor(options.executor ?? "hardened-kmac");
    if (executor === "filesystem" && options.allowTemporaryRoots !== true) {
      fail("path_validation", "filesystem_executor_requires_test_root");
    }
    const target = resolvePrepareTarget(options);
    paths = ensureActivationDirectories(target.base);
    const runtimeBun = validatePrepareRuntime(paths, executor, options.runtimeBun);
    lock = acquireLock(paths, operationId, reviewedCommit, target.candidate, null);

    const existing = readOperationState(paths, operationId);
    if (existing !== null) {
      validateOperationRequest(existing, operationId, reviewedCommit, target.candidate);
      if (existing.phase !== "prepare"
        || (existing.status !== "prepared" && existing.status !== "blocked")
        || existing.candidate === null
        || existing.candidateDirectory === null) {
        fail("stale_request", "operation_not_preparable");
      }
      if (existing.executor !== executor) fail("stale_request", "executor_mismatch");
      const gitManifest = inspectCleanGitManifest(options.gitRoot, reviewedCommit);
      const verified = verifyPreparedCandidate(target.candidate, gitManifest);
      if (!identityEqual(verified.identity, existing.candidate)
        || !identitiesEqual(verified.directory, existing.candidateDirectory)) {
        fail("candidate_manifest", "prepared_candidate_changed");
      }
      candidate = verified.identity;
      state = existing.status === "blocked"
        ? updateOperationState(existing, {
          status: "prepared",
          failureStage: "none",
          rollbackOutcome: "not-requested",
        })
        : existing;
      if (state !== existing) persistOperationState(paths, state);
      appendAuditOnce(paths, auditInput(state, "prepare", null, candidate, "prepared", "none", "not-requested"));
      response = result(phase, {
        ok: true,
        phase,
        operationId,
        reviewedCommit,
        candidate,
        manifestDigest: candidate.manifestDigest,
        outcome: "prepared",
        failureStage: "none",
        rollbackOutcome: "not-requested",
      });
    } else {
      const gitManifest = inspectCleanGitManifest(options.gitRoot, reviewedCommit);
      let verified: ReturnType<typeof identityAt>;
      if (target.candidateExists) {
        verified = verifyPreparedCandidate(target.candidate, gitManifest);
      } else {
        staging = mkdtempSync(join(paths.releasesRoot, `.kmac-prepare-${operationId}-`));
        if (!stagingPathIsSafe(staging, paths.releasesRoot)) fail("candidate_write", "staging_path_invalid");
        archiveGitTree(options.gitRoot, reviewedCommit, staging);
        assertArchivedTreeSafe(staging);
        installFrozenDependencies(runtimeBun, staging);
        probeCandidateRuntime(runtimeBun, staging);
        atomicWrite(
          join(staging, FUNCTIONAL_MANIFEST_FILE),
          `${JSON.stringify(gitManifest, null, 2)}\n`,
          0o600,
          "candidate_write",
          MAX_MANIFEST_BYTES,
        );
        const stagedCheck = checkReleaseAt(
          staging,
          false,
          "candidate_manifest",
          "candidate_content",
          "candidate_content",
        );
        const stagedVerified = identityAt(stagedCheck, "candidate_manifest", false);
        if (stagedVerified.identity.gitCommit !== gitManifest.gitCommit
          || compareFunctionalManifests(gitManifest, stagedVerified.manifest).length !== 0) {
          fail("candidate_manifest", "candidate_manifest_mismatch");
        }
        makeImmutableTree(staging);
        const immutableStaged = identityAt(checkReleaseAt(
          staging,
          true,
          "candidate_manifest",
          "candidate_content",
          "candidate_mutability",
        ), "candidate_manifest", true);
        if (immutableStaged.identity.gitCommit !== gitManifest.gitCommit
          || compareFunctionalManifests(gitManifest, immutableStaged.manifest).length !== 0) {
          fail("candidate_manifest", "candidate_manifest_mismatch");
        }
        atomicRenameImmutableDirectory(staging, target.candidate, "candidate_write");
        staging = null;
        verified = verifyPreparedCandidate(target.candidate, gitManifest);
      }
      candidate = verified.identity;
      state = prepareState(
        operationId,
        executor,
        reviewedCommit,
        candidate,
        verified.directory,
        new Date().toISOString(),
      );
      persistOperationState(paths, state);
      appendAuditOnce(paths, auditInput(state, "prepare", null, candidate, "prepared", "none", "not-requested"));
      response = result(phase, {
        ok: true,
        phase,
        operationId,
        reviewedCommit,
        candidate,
        manifestDigest: candidate.manifestDigest,
        outcome: "prepared",
        failureStage: "none",
        rollbackOutcome: "not-requested",
      });
    }
  } catch (error) {
    const failure = failureFrom(error);
    if (paths !== null && operationId !== null && lock !== null) {
      try {
        if (state !== null) {
          persistOperationState(paths, updateOperationState(state, {
            status: "blocked",
            failureStage: failure.stage,
            rollbackOutcome: "not-needed",
          }));
          appendAuditOnce(paths, auditInput(state, "prepare", null, state.candidate, "blocked", failure.stage, "not-needed"));
        } else {
          const auditState: OperationState = {
            schema: "argus.kmac.release-operation",
            version: WORKFLOW_VERSION,
            operationId,
            phase: "prepare",
            status: "preparing",
            executor: validateExecutor(options.executor ?? "hardened-kmac"),
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            reviewedCommit: reviewedCommit ?? "0".repeat(40),
            candidate: null,
            active: null,
            candidateDirectory: null,
            activeDirectory: null,
            failureStage: failure.stage,
            rollbackOutcome: "not-needed",
          };
          appendAuditOnce(paths, auditInput(auditState, "prepare", null, candidate, "blocked", failure.stage, "not-needed"));
        }
      } catch {
        // A failed audit must never expose the original exception or claim success.
      }
    }
    response = blocked(phase, error, {
      operationId,
      reviewedCommit,
      candidate,
      manifestDigest: candidate?.manifestDigest ?? null,
    });
  } finally {
    if (staging !== null && paths !== null) removeStaging(staging, paths.releasesRoot);
    if (lock !== null) {
      try {
        lock.release();
      } catch {
        response = blocked(phase, new WorkflowError("lock", "lock_release_failed"), {
          operationId,
          reviewedCommit,
          candidate,
          manifestDigest: candidate?.manifestDigest ?? null,
        });
      }
    }
  }
  return response!;
}

export function preflightRelease(options: PreflightOptions): WorkflowResult {
  try {
    const evaluated = evaluatePreflight(options);
    const report = evaluated.report;
    const candidate = report.ok && evaluated.candidate ? evaluated.candidate.identity : null;
    const active = report.ok && evaluated.active ? evaluated.active.identity : null;
    return result("preflight", {
      ok: report.ok,
      phase: "preflight",
      reviewedCommit: report.reviewedCommit || null,
      candidate,
      active,
      manifestDigest: candidate?.manifestDigest ?? null,
      outcome: report.ok ? "preflight-passed" : "blocked",
      failureStage: report.failureStage,
      errorCode: report.ok ? null : "preflight_failed",
      rollbackOutcome: "not-requested",
      preflight: report,
    });
  } catch (error) {
    return blocked("preflight", error);
  }
}

function validateHardenedKmac(
  paths: ReturnType<typeof resolveReleasePaths>,
  options: PreflightOptions,
  hardened: HardenedKmacOptions,
): { runtimeBun: string; candidateConfig: string; repositoryRoot: string; activationScript: string; expectedLiveHash: string; expectedCandidateHash: string; requireGithubAuth: boolean } {
  if (paths.allowTemporaryRoots) fail("path_validation", "hardened_executor_requires_persistent_root");
  if (hardened.requireRemoteCodexControl !== true) fail("activation_script", "remote_codex_control_not_required");
  if (!SHA256_PATTERN.test(hardened.expectedLiveMeshSha256) || !SHA256_PATTERN.test(hardened.expectedCandidateMeshSha256)) {
    fail("activation_script", "mesh_hash_invalid");
  }
  const runtimeBun = canonicalExistingFile(hardened.runtimeBun, false);
  if ((fileMode(runtimeBun) & 0o111) === 0) fail("activation_script", "runtime_not_executable");
  if (!runtimePathIsFixed(paths.base, runtimeBun)) fail("path_validation", "runtime_outside_allowlist");
  const candidateConfig = canonicalExistingFile(hardened.candidateConfig, false);
  const preparedRoot = `${paths.base}/prepared/`;
  if (!candidateConfig.startsWith(preparedRoot)) {
    fail("path_validation", "candidate_config_outside_prepared");
  }
  if (fileMode(candidateConfig) & 0o077) fail("activation_script", "candidate_config_permissions_invalid");
  const liveConfig = canonicalExistingFile(`${paths.base}/state/mesh.json`, false);
  if (liveConfig !== `${paths.base}/state/mesh.json`) fail("path_validation", "live_config_path_invalid");
  if (hashFile(liveConfig, MAX_MESH_CONFIG_BYTES, "activation_script") !== hardened.expectedLiveMeshSha256) {
    fail("stale_request", "live_mesh_hash_changed");
  }
  if (hashFile(candidateConfig, MAX_MESH_CONFIG_BYTES, "activation_script") !== hardened.expectedCandidateMeshSha256) {
    fail("activation_script", "candidate_mesh_hash_mismatch");
  }
  const gitRoot = resolveGitRoot(options.gitRoot, false);
  const repositoryRoot = resolveGitRoot(hardened.repositoryRoot, false);
  if (repositoryRoot !== gitRoot) fail("path_validation", "repository_root_mismatch");
  const activationScriptInput = hardened.activationScript ?? join(gitRoot, FIXED_ACTIVATION_SCRIPT);
  const activationScript = canonicalExistingFile(activationScriptInput, false);
  if (activationScript !== join(gitRoot, FIXED_ACTIVATION_SCRIPT)) fail("path_validation", "activation_script_not_fixed");
  if ((fileMode(activationScript) & 0o111) === 0) fail("activation_script", "activation_script_not_executable");
  return {
    runtimeBun,
    candidateConfig,
    repositoryRoot,
    activationScript,
    expectedLiveHash: hardened.expectedLiveMeshSha256,
    expectedCandidateHash: hardened.expectedCandidateMeshSha256,
    requireGithubAuth: hardened.requireGithubAuth === true,
  };
}

function runHardenedKmac(
  paths: ReturnType<typeof resolveReleasePaths>,
  reviewedCommit: string,
  validated: ReturnType<typeof validateHardenedKmac>,
): void {
  const env: NodeJS.ProcessEnv = {
    PATH: FIXED_PATH,
    HOME: homedir(),
    ARGUS_REPO_ROOT: validated.repositoryRoot,
    ARGUS_REVIEWED_COMMIT: reviewedCommit,
    AGENTLINK_INSTALL_ROOT: paths.base,
    ARGUS_CURRENT_LINK: paths.current,
    ARGUS_EXPECTED_OLD_RELEASE: paths.active,
    ARGUS_CANDIDATE_RELEASE: paths.candidate,
    ARGUS_CANDIDATE_CONFIG: validated.candidateConfig,
    ARGUS_EXPECTED_LIVE_MESH_SHA256: validated.expectedLiveHash,
    ARGUS_EXPECTED_CANDIDATE_MESH_SHA256: validated.expectedCandidateHash,
    ARGUS_RUNTIME_BUN: validated.runtimeBun,
    ARGUS_REQUIRE_REMOTE_CODEX_CONTROL: "true",
    ARGUS_REQUIRE_GITHUB_AUTH: String(validated.requireGithubAuth),
  };
  const child = spawnSync(validated.activationScript, {
    cwd: validated.repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
  });
  if (child.error || child.status !== 0) fail("activation_script", "hardened_activation_failed");
}

function verifyCurrentRelease(
  paths: ReturnType<typeof resolveReleasePaths>,
  target: "candidate" | "active",
  expected: ReleaseIdentity,
  expectedDirectory: { device: number; inode: number },
): ReturnType<typeof identityAt> {
  const targetPath = target === "candidate" ? paths.candidate : paths.active;
  const current = currentTarget(paths);
  if (current.targetPath !== targetPath) fail("postcondition", "current_target_mismatch");
  if (!identityMatchesDirectory(targetPath, expectedDirectory)) fail("postcondition", "release_directory_changed");
  return verifyReleaseIdentity(targetPath, expected, expectedDirectory, target === "candidate", "postcondition");
}

export function activateRelease(options: import("./kmac-release-workflow-types").ActivateOptions): WorkflowResult {
  const phase: WorkflowPhase = "activate";
  let operationId: string | null = null;
  let reviewedCommit: string | null = null;
  let paths: ReturnType<typeof resolveReleasePaths> | null = null;
  let state: OperationState | null = null;
  let lock: ReturnType<typeof acquireLock> | null = null;
  let switched = false;
  let response: WorkflowResult;
  try {
    operationId = normalizeOperationId(options.operationId);
    reviewedCommit = normalizeCommit(options.reviewedCommit);
    paths = resolveReleasePaths(options);
    paths = ensureActivationDirectories(paths) as ReturnType<typeof resolveReleasePaths>;
    lock = acquireLock(paths, operationId, reviewedCommit, paths.candidate, paths.active);
    state = readOperationState(paths, operationId);
    if (state === null) fail("stale_request", "operation_not_found");
    validateOperationRequest(state, operationId, reviewedCommit, paths.candidate);
    if (state.active !== null && state.active.path !== paths.active) fail("stale_request", "operation_request_mismatch");
    const executor = options.executor === undefined ? state.executor : validateExecutor(options.executor);
    if (state.executor !== executor) fail("stale_request", "executor_mismatch");

    if (state.status === "active") {
      if (state.candidate === null || state.candidateDirectory === null || !terminalAudit(paths, operationId, "activate", "active", state.candidate)) {
        fail("operation_state", "active_audit_missing");
      }
      const verified = verifyCurrentRelease(paths, "candidate", state.candidate, state.candidateDirectory);
      response = result(phase, {
        ok: true,
        phase,
        operationId,
        reviewedCommit,
        candidate: verified.identity,
        active: verified.identity,
        manifestDigest: verified.identity.manifestDigest,
        outcome: "active",
        failureStage: "none",
        rollbackOutcome: "not-needed",
      });
    } else {
      if (state.phase !== "prepare" || state.status !== "prepared" || state.candidate === null || state.candidateDirectory === null) {
        fail("stale_request", "operation_requires_rollback");
      }
      const evaluated = evaluatePreflight(options);
      if (!evaluated.report.ok || evaluated.candidate === null || evaluated.active === null) {
        appendAuditOnce(paths, auditInput(state, "activate", null, state.candidate, "blocked", evaluated.report.failureStage, "not-needed"));
        response = result(phase, {
          phase,
          operationId,
          reviewedCommit,
          candidate: state.candidate,
          manifestDigest: state.candidate.manifestDigest,
          outcome: "blocked",
          failureStage: evaluated.report.failureStage,
          errorCode: "preflight_failed",
          rollbackOutcome: "not-needed",
          preflight: evaluated.report,
        });
      } else {
        const preparedCandidate = state.candidate;
        const preparedDirectory = state.candidateDirectory;
        if (preparedCandidate === null || preparedDirectory === null
          || !identityEqual(evaluated.candidate.identity, preparedCandidate)
          || !identitiesEqual(evaluated.candidate.directoryIdentity, preparedDirectory)) {
          fail("stale_request", "candidate_changed_since_prepare");
        }
        const oldRelease = evaluated.active.identity;
        const oldDirectory = evaluated.active.directoryIdentity;
        let validatedHardened: ReturnType<typeof validateHardenedKmac> | null = null;
        if (executor === "filesystem") {
          if (!paths.allowTemporaryRoots) fail("path_validation", "filesystem_executor_requires_test_root");
          if (!identityMatchesDirectory(paths.active, oldDirectory)) fail("stale_request", "active_release_changed");
        } else {
          if (!options.hardenedKmac) fail("activation_script", "hardened_options_required");
          validatedHardened = validateHardenedKmac(paths, options, options.hardenedKmac);
        }
        const activating = updateOperationState(state, {
          phase: "activate",
          status: "activating",
          executor,
          active: oldRelease,
          activeDirectory: oldDirectory,
          failureStage: "none",
          rollbackOutcome: "not-requested",
        });
        state = activating;
        persistOperationState(paths, state);
        if (executor === "filesystem") {
          const before = currentTarget(paths);
          if (before.targetPath !== paths.active) fail("stale_request", "active_target_changed");
          atomicSymlinkSwitch(paths.current, paths.candidate, "switch", paths.active);
          switched = true;
          options.hooks?.afterSwitch?.();
        } else {
          if (validatedHardened === null) fail("activation_script", "hardened_options_required");
          runHardenedKmac(paths, reviewedCommit, validatedHardened);
          switched = currentTarget(paths).targetPath === paths.candidate;
          if (!switched) fail("postcondition", "hardened_activation_target_missing");
        }
        const verified = verifyCurrentRelease(paths, "candidate", preparedCandidate, preparedDirectory);
        appendAuditOnce(paths, auditInput(state, "activate", oldRelease, verified.identity, "active", "none", "not-needed"));
        state = updateOperationState(state, {
          status: "active",
          failureStage: "none",
          candidate: verified.identity,
          active: oldRelease,
          candidateDirectory: verified.directory,
          activeDirectory: oldDirectory,
          rollbackOutcome: "not-needed",
        });
        persistOperationState(paths, state);
        response = result(phase, {
          ok: true,
          phase,
          operationId,
          reviewedCommit,
          candidate: verified.identity,
          active: verified.identity,
          manifestDigest: verified.identity.manifestDigest,
          outcome: "active",
          failureStage: "none",
          rollbackOutcome: "not-needed",
        });
      }
    }
  } catch (error) {
    const failure = failureFrom(error);
    if (paths !== null && lock !== null && operationId !== null && state !== null) {
      const current = currentTarget(paths);
      const rollbackRequired = switched || current.targetPath === paths.candidate || state.status === "activating";
      const nextStatus = rollbackRequired
        ? "needs-rollback"
        : state.phase === "prepare" && state.status === "prepared"
          ? "prepared"
          : "blocked";
      const failedState = updateOperationState(state, {
        phase: nextStatus === "prepared" ? "prepare" : "activate",
        status: nextStatus,
        failureStage: nextStatus === "prepared" ? "none" : failure.stage,
        rollbackOutcome: nextStatus === "prepared"
          ? "not-requested"
          : rollbackRequired
            ? "not-requested"
            : "not-needed",
      });
      try {
        persistOperationState(paths, failedState);
        appendAuditOnce(paths, auditInput(
          failedState,
          "activate",
          failedState.active,
          failedState.candidate,
          "blocked",
          failure.stage,
          rollbackRequired ? "not-requested" : "not-needed",
        ));
      } catch {
        // The state remains fail-closed even when the audit medium is unavailable.
      }
      state = failedState;
    }
    response = blocked(phase, error, {
      operationId,
      reviewedCommit,
      candidate: state?.candidate ?? null,
      active: state?.active ?? null,
      manifestDigest: state?.candidate?.manifestDigest ?? null,
      rollbackOutcome: state?.status === "needs-rollback" ? "not-requested" : "not-needed",
    });
  } finally {
    if (lock !== null) {
      try {
        lock.release();
      } catch {
        response = blocked(phase, new WorkflowError("lock", "lock_release_failed"), {
          operationId,
          reviewedCommit,
          candidate: state?.candidate ?? null,
          active: state?.candidate ?? state?.active ?? null,
          manifestDigest: state?.candidate?.manifestDigest ?? null,
        });
      }
    }
  }
  return response!;
}

function verifyRollbackState(
  paths: ReturnType<typeof resolveReleasePaths>,
  state: OperationState,
): { candidate: ReturnType<typeof identityAt>; active: ReturnType<typeof identityAt> } {
  if (state.candidate === null || state.active === null || state.candidateDirectory === null || state.activeDirectory === null) {
    fail("rollback_unsupported", "rollback_identity_missing");
  }
  const candidate = verifyReleaseIdentity(paths.candidate, state.candidate, state.candidateDirectory, true, "rollback_verification");
  const active = verifyReleaseIdentity(paths.active, state.active, state.activeDirectory, false, "rollback_verification");
  return { candidate, active };
}

export function rollbackRelease(options: RollbackOptions): WorkflowResult {
  const phase: WorkflowPhase = "rollback";
  let operationId: string | null = null;
  let reviewedCommit: string | null = null;
  let paths: ReturnType<typeof resolveReleasePaths> | null = null;
  let state: OperationState | null = null;
  let lock: ReturnType<typeof acquireLock> | null = null;
  let switched = false;
  let response: WorkflowResult;
  try {
    operationId = normalizeOperationId(options.operationId);
    reviewedCommit = normalizeCommit(options.reviewedCommit);
    paths = resolveReleasePaths(options);
    paths = ensureActivationDirectories(paths) as ReturnType<typeof resolveReleasePaths>;
    lock = acquireLock(paths, operationId, reviewedCommit, paths.candidate, paths.active);
    state = readOperationState(paths, operationId);
    if (state === null) fail("stale_request", "operation_not_found");
    validateOperationRequest(state, operationId, reviewedCommit, paths.candidate, paths.active);
    if (state.executor === "hardened-kmac") fail("rollback_unsupported", "hardened_rollback_requires_live_adapter");
    if (!paths.allowTemporaryRoots) fail("rollback_unsupported", "filesystem_executor_requires_test_root");
    if (state.active === null || state.activeDirectory === null || state.candidate === null || state.candidateDirectory === null) {
      fail("rollback_unsupported", "operation_has_no_prior_release");
    }
    if (state.status === "rolled-back") {
      const alreadyRolledBack = verifyReleaseIdentity(
        paths.active,
        state.active,
        state.activeDirectory,
        false,
        "rollback_verification",
      );
      if (currentTarget(paths).targetPath !== paths.active
        || !terminalAudit(paths, operationId, "rollback", "rolled-back", alreadyRolledBack.identity)) {
        fail("rollback_verification", "rolled_back_postcondition_missing");
      }
      response = result(phase, {
        ok: true,
        phase,
        operationId,
        reviewedCommit,
        candidate: state.candidate,
        active: alreadyRolledBack.identity,
        manifestDigest: alreadyRolledBack.identity.manifestDigest,
        outcome: "rolled-back",
        failureStage: "none",
        rollbackOutcome: "succeeded",
      });
      return response;
    }
    if (!["active", "activating", "needs-rollback", "rolling-back", "blocked"].includes(state.status)) {
      fail("rollback_unsupported", "operation_not_rollbackable");
    }
    const verified = verifyRollbackState(paths, state);
    const current = currentTarget(paths);
    if (current.targetPath !== paths.active && current.targetPath !== paths.candidate) {
      fail("rollback_verification", "current_target_not_known");
    }
    const rolling = updateOperationState(state, {
      phase: "rollback",
      status: "rolling-back",
      failureStage: "none",
      rollbackOutcome: "failed",
    });
    state = rolling;
    persistOperationState(paths, state);
    if (current.targetPath === paths.candidate) {
      atomicSymlinkSwitch(paths.current, paths.active, "rollback_switch", paths.candidate);
      switched = true;
      options.hooks?.afterRollbackSwitch?.();
    }
    const post = verifyCurrentRelease(paths, "active", verified.active.identity, verified.active.directory);
    appendAuditOnce(paths, auditInput(state, "rollback", verified.candidate.identity, post.identity, "rolled-back", "none", "succeeded"));
    state = updateOperationState(state, {
      phase: "rollback",
      status: "rolled-back",
      failureStage: "none",
      rollbackOutcome: "succeeded",
      active: post.identity,
      activeDirectory: post.directory,
    });
    persistOperationState(paths, state);
    response = result(phase, {
      ok: true,
      phase,
      operationId,
      reviewedCommit,
      candidate: verified.candidate.identity,
      active: post.identity,
      manifestDigest: post.identity.manifestDigest,
      outcome: "rolled-back",
      failureStage: "none",
      rollbackOutcome: "succeeded",
    });
  } catch (error) {
    const failure = failureFrom(error);
    if (paths !== null
      && lock !== null
      && state !== null
      && state.candidate !== null
      && state.active !== null
      && state.candidateDirectory !== null
      && state.activeDirectory !== null) {
      const current = currentTarget(paths);
      const failedState = updateOperationState(state, {
        phase: "rollback",
        status: switched || current.targetPath === paths.active ? "blocked" : "needs-rollback",
        failureStage: failure.stage,
        rollbackOutcome: "failed",
      });
      try {
        persistOperationState(paths, failedState);
        appendAuditOnce(paths, auditInput(
          failedState,
          "rollback",
          failedState.candidate,
          failedState.active,
          "blocked",
          failure.stage,
          "failed",
        ));
      } catch {
        // A missing audit is itself a fail-closed condition observed by status.
      }
      state = failedState;
    }
    response = blocked(phase, error, {
      operationId,
      reviewedCommit,
      candidate: state?.candidate ?? null,
      active: state?.active ?? null,
      manifestDigest: state?.active?.manifestDigest ?? null,
      rollbackOutcome: "failed",
    });
  } finally {
    if (lock !== null) {
      try {
        lock.release();
      } catch {
        response = blocked(phase, new WorkflowError("lock", "lock_release_failed"), {
          operationId,
          reviewedCommit,
          candidate: state?.candidate ?? null,
          active: state?.active ?? null,
          manifestDigest: state?.active?.manifestDigest ?? null,
          rollbackOutcome: "failed",
        });
      }
    }
  }
  return response!;
}

function currentRelease(paths: BasePaths): ReleaseIdentity | null {
  const current = currentTarget(paths);
  if (current.targetPath === null) return null;
  const check = checkReleaseAt(current.targetPath, false, "active_manifest", "active_content", "active_content");
  return releaseCheckIsUsable(check, false) ? check.identity : null;
}

function latestState(paths: BasePaths): OperationState | null {
  let latest: OperationState | null = null;
  for (const operationId of operationIds(paths)) {
    const state = readOperationState(paths, operationId);
    if (state === null) continue;
    if (latest === null
      || Date.parse(state.updatedAt) > Date.parse(latest.updatedAt)
      || (state.updatedAt === latest.updatedAt && state.operationId > latest.operationId)) {
      latest = state;
    }
  }
  return latest;
}

export function statusRelease(options: { basePath: string; allowTemporaryRoots?: boolean }): ReleaseStatusResult {
  const empty: ReleaseStatusResult = {
    schema: "argus.kmac.release-status",
    version: WORKFLOW_VERSION,
    ok: false,
    state: "blocked",
    current: null,
    latestOperation: null,
    lock: { held: false, stale: false, operationId: null, startedAt: null },
    failureStage: "none",
  };
  try {
    const paths = resolveBasePaths(options);
    const lock = inspectLock(paths);
    const current = currentRelease(paths);
    const latest = latestState(paths);
    readAuditRecords(paths);
    const latestOperation = latest === null ? null : {
      operationId: latest.operationId,
      status: latest.status,
      updatedAt: latest.updatedAt,
      failureStage: latest.failureStage,
    };
    if (lock.held) return { ...empty, current, latestOperation, lock, failureStage: "lock" };
    if (latest === null) {
      return {
        ...empty,
        ok: true,
        state: current === null ? "idle" : "active",
        current,
        latestOperation,
        lock,
        failureStage: current === null ? "none" : "none",
      };
    }
    if (latest.status === "active"
      && latest.candidate !== null
      && latest.candidateDirectory !== null
      && current !== null
      && identityEqual(current, latest.candidate)
      && releaseCheckIsUsable(
        checkReleaseAt(latest.candidate.path, true, "active_manifest", "active_content", "candidate_mutability"),
        true,
      )
      && identityMatchesDirectory(latest.candidate.path, latest.candidateDirectory)
      && terminalAudit(paths, latest.operationId, "activate", "active", latest.candidate)) {
      return { ...empty, ok: true, state: "active", current, latestOperation, lock, failureStage: "none" };
    }
    if (latest.status === "rolled-back"
      && latest.active !== null
      && latest.activeDirectory !== null
      && current !== null
      && identityEqual(current, latest.active)
      && identityMatchesDirectory(latest.active.path, latest.activeDirectory)
      && terminalAudit(paths, latest.operationId, "rollback", "rolled-back", latest.active)) {
      return { ...empty, ok: true, state: "active", current, latestOperation, lock, failureStage: "none" };
    }
    if (["activating", "needs-rollback", "rolling-back"].includes(latest.status)) {
      return { ...empty, state: "rollback-required", current, latestOperation, lock, failureStage: latest.failureStage };
    }
    if (latest.status === "prepared") {
      return { ...empty, ok: current !== null, state: current === null ? "blocked" : "active", current, latestOperation, lock, failureStage: current === null ? "current_link" : "none" };
    }
    return { ...empty, current, latestOperation, lock, failureStage: latest.failureStage === "none" ? "operation_state" : latest.failureStage };
  } catch (error) {
    return { ...empty, failureStage: failureFrom(error).stage };
  }
}

export function auditRelease(options: { basePath: string; operationId?: string; allowTemporaryRoots?: boolean }): AuditResult {
  try {
    const operationId = options.operationId === undefined ? null : normalizeOperationId(options.operationId);
    const paths = resolveBasePaths(options);
    return makeAuditResult(paths, operationId);
  } catch (error) {
    return {
      schema: "argus.kmac.release-audit-result",
      version: WORKFLOW_VERSION,
      ok: false,
      operationId: null,
      total: 0,
      truncated: false,
      records: [],
      failureStage: failureFrom(error).stage,
    };
  }
}

interface ParsedArgs {
  command: string;
  values: Map<string, string | true>;
}

const COMMON_FLAGS = new Set(["base-path", "candidate", "active", "git-root", "reviewed-commit", "operation-id", "executor", "json"]);
const HARDENED_FLAGS = new Set([
  "runtime-bun",
  "candidate-config",
  "expected-live-mesh-sha256",
  "expected-candidate-mesh-sha256",
  "repository-root",
  "activation-script",
  "require-remote-codex-control",
  "require-github-auth",
]);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "";
  if (!["prepare", "preflight", "activate", "rollback", "status", "audit"].includes(command)) {
    fail("usage", "unknown_command");
  }
  const allowed = command === "prepare"
    ? new Set(["base-path", "candidate", "git-root", "reviewed-commit", "operation-id", "executor", "runtime-bun", "json"])
    : command === "preflight"
      ? new Set(["base-path", "candidate", "active", "git-root", "reviewed-commit", "json"])
      : command === "activate"
        ? new Set([...COMMON_FLAGS, ...HARDENED_FLAGS])
        : command === "rollback"
          ? new Set(["base-path", "candidate", "active", "reviewed-commit", "operation-id", "json"])
          : command === "status"
            ? new Set(["base-path", "json"])
            : new Set(["base-path", "operation-id", "json"]);
  const values = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) fail("usage", "unexpected_argument");
    const equals = argument.indexOf("=");
    const rawName = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    if (!allowed.has(rawName)) fail("usage", "unknown_flag");
    if (values.has(rawName)) fail("usage", "duplicate_flag");
    if (["json", "require-remote-codex-control", "require-github-auth"].includes(rawName)) {
      if (inline !== undefined) fail("usage", "boolean_flag_value");
      values.set(rawName, true);
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith("--")) fail("usage", "flag_value_missing");
    values.set(rawName, value);
  }
  return { command, values };
}

function required(values: Map<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string") fail("usage", `missing_${name.replaceAll("-", "_")}`);
  return value;
}

function optional(values: Map<string, string | true>, name: string): string | undefined {
  const value = values.get(name);
  return typeof value === "string" ? value : undefined;
}

function cliBase(values: Map<string, string | true>): string {
  return optional(values, "base-path") ?? DEFAULT_BASE_PATH;
}

function hardenedOptions(values: Map<string, string | true>): HardenedKmacOptions {
  return {
    runtimeBun: required(values, "runtime-bun"),
    candidateConfig: required(values, "candidate-config"),
    expectedLiveMeshSha256: required(values, "expected-live-mesh-sha256"),
    expectedCandidateMeshSha256: required(values, "expected-candidate-mesh-sha256"),
    repositoryRoot: required(values, "repository-root"),
    activationScript: optional(values, "activation-script"),
    requireRemoteCodexControl: values.get("require-remote-codex-control") === true,
    requireGithubAuth: values.get("require-github-auth") === true,
  };
}

function phaseForCommand(command: string): WorkflowPhase {
  if (command === "status") return "status";
  if (command === "audit") return "audit";
  if (command === "preflight") return "preflight";
  if (command === "activate") return "activate";
  if (command === "rollback") return "rollback";
  return "prepare";
}

export function runCli(argv: readonly string[]): { exitCode: number; output: string } {
  let command = argv[0] ?? "status";
  let output: WorkflowResult | ReleaseStatusResult | AuditResult;
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    const values = parsed.values;
    switch (parsed.command) {
      case "prepare":
        if (optional(values, "executor") === "filesystem") fail("usage", "filesystem_executor_is_api_only");
        output = prepareRelease({
          basePath: cliBase(values),
          candidatePath: required(values, "candidate"),
          gitRoot: required(values, "git-root"),
          reviewedCommit: required(values, "reviewed-commit"),
          runtimeBun: required(values, "runtime-bun"),
          operationId: optional(values, "operation-id"),
          executor: optional(values, "executor") as WorkflowExecutor | undefined,
        });
        break;
      case "preflight":
        output = preflightRelease({
          basePath: cliBase(values),
          candidatePath: required(values, "candidate"),
          activePath: required(values, "active"),
          gitRoot: required(values, "git-root"),
          reviewedCommit: required(values, "reviewed-commit"),
        });
        break;
      case "activate":
        if (optional(values, "executor") === "filesystem") fail("usage", "filesystem_executor_is_api_only");
        output = activateRelease({
          basePath: cliBase(values),
          candidatePath: required(values, "candidate"),
          activePath: required(values, "active"),
          gitRoot: required(values, "git-root"),
          reviewedCommit: required(values, "reviewed-commit"),
          operationId: required(values, "operation-id"),
          executor: (optional(values, "executor") ?? "hardened-kmac") as WorkflowExecutor,
          hardenedKmac: hardenedOptions(values),
        });
        break;
      case "rollback":
        output = rollbackRelease({
          basePath: cliBase(values),
          candidatePath: required(values, "candidate"),
          activePath: required(values, "active"),
          reviewedCommit: required(values, "reviewed-commit"),
          operationId: required(values, "operation-id"),
        });
        break;
      case "status":
        output = statusRelease({ basePath: cliBase(values) });
        break;
      case "audit":
        output = auditRelease({ basePath: cliBase(values), operationId: optional(values, "operation-id") });
        break;
      default:
        fail("usage", "unknown_command");
    }
  } catch (error) {
    output = blocked(phaseForCommand(command), error);
  }
  let serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, "utf8") + 1 > MAX_OUTPUT_BYTES) {
    serialized = JSON.stringify(result(phaseForCommand(command), {
      errorCode: "output_too_large",
      failureStage: "output",
    }));
  }
  return {
    exitCode: output.ok ? 0 : output.failureStage === "usage" ? 64 : 1,
    output: `${serialized}\n`,
  };
}

if (import.meta.main) {
  const cli = runCli(process.argv.slice(2));
  process.stdout.write(cli.output);
  process.exitCode = cli.exitCode;
}
