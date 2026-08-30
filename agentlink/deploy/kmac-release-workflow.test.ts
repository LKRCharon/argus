import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateRelease,
  auditRelease,
  prepareRelease,
  preflightRelease,
  rollbackRelease,
  runCli,
  statusRelease,
} from "./kmac-release-workflow";
import {
  acquireLock,
  atomicSymlinkSwitch,
  persistOperationState,
  readOperationState,
  resolveBasePaths,
  statDirectoryIdentity,
} from "./kmac-release-workflow-storage";
import {
  LOCK_MAX_AGE_MS,
  MAX_OUTPUT_BYTES,
  WORKFLOW_SCHEMA,
} from "./kmac-release-workflow-types";

interface Fixture {
  root: string;
  gitRoot: string;
  basePath: string;
  candidatePath: string;
  activePath: string;
  currentPath: string;
  reviewedCommit: string;
  operationId: string;
}

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    removeTempTree(root);
  }
});

function removeTempTree(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) removeTempTree(join(path, name));
    rmdirSync(path);
    return;
  }
  chmodSync(path, 0o600);
  unlinkSync(path);
}

function tempRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `argus-kmac-${label}-`)));
  fixtureRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixture(label: string): Fixture {
  const root = tempRoot(label);
  const gitRoot = join(root, "source");
  const basePath = join(root, "agentlink-state");
  mkdirSync(gitRoot, { recursive: true, mode: 0o700 });
  mkdirSync(basePath, { recursive: true, mode: 0o700 });
  chmodSync(gitRoot, 0o700);
  chmodSync(basePath, 0o700);
  writeFixtureFile(gitRoot, "package.json", "{\"name\":\"workflow-fixture\"}\n");
  writeFixtureFile(gitRoot, "packages/daemon/src/feature.ts", "export const feature = 1;\n");
  git(gitRoot, "init", "-q");
  git(gitRoot, "config", "user.name", "Argus workflow fixture");
  git(gitRoot, "config", "user.email", "argus-workflow@example.invalid");
  git(gitRoot, "add", "package.json", "packages/daemon/src/feature.ts");
  git(gitRoot, "commit", "-qm", "fixture release");
  const reviewedCommit = git(gitRoot, "rev-parse", "HEAD").toLowerCase();
  return {
    root,
    gitRoot,
    basePath,
    candidatePath: join(basePath, "releases", "candidate-1"),
    activePath: join(basePath, "releases", "active-1"),
    currentPath: join(basePath, "current"),
    reviewedCommit,
    operationId: `kmac-${label}`,
  };
}

function prepareFixture(fixture: Fixture): void {
  const prepared = prepareRelease({
    basePath: fixture.basePath,
    candidatePath: fixture.candidatePath,
    gitRoot: fixture.gitRoot,
    reviewedCommit: fixture.reviewedCommit,
    operationId: fixture.operationId,
    executor: "filesystem",
    allowTemporaryRoots: true,
  });
  expect(prepared).toMatchObject({ ok: true, failureStage: "none" });
  expect(prepared.candidate?.path).toBe(fixture.candidatePath);
  cpSync(fixture.candidatePath, fixture.activePath, { recursive: true });
  symlinkSync(fixture.activePath, fixture.currentPath);
}

function workflowPaths(fixture: Fixture) {
  return {
    basePath: fixture.basePath,
    candidatePath: fixture.candidatePath,
    activePath: fixture.activePath,
    reviewedCommit: fixture.reviewedCommit,
    allowTemporaryRoots: true,
  } as const;
}

function activateFixture(fixture: Fixture, hooks?: { afterSwitch?: () => void }) {
  return activateRelease({
    ...workflowPaths(fixture),
    gitRoot: fixture.gitRoot,
    operationId: fixture.operationId,
    executor: "filesystem",
    hooks,
  });
}

describe("KMac release workflow", () => {
  test("prepares, preflights, activates, rolls back, and is idempotent", () => {
    const fixture = createFixture("success");
    prepareFixture(fixture);

    const beforeActivation = preflightRelease({ ...workflowPaths(fixture), gitRoot: fixture.gitRoot });
    expect(beforeActivation).toMatchObject({
      ok: true,
      phase: "preflight",
      outcome: "preflight-passed",
      reviewedCommit: fixture.reviewedCommit,
    });

    const activated = activateFixture(fixture);
    expect(activated).toMatchObject({ ok: true, phase: "activate", outcome: "active" });
    expect(readFileSync(join(fixture.basePath, "activation", "audit.jsonl"), "utf8")).not.toContain("workflow-fixture");
    expect(activateFixture(fixture)).toEqual(activated);

    const activeStatus = statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true });
    expect(activeStatus).toMatchObject({ ok: true, state: "active", lock: { held: false } });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toEqual(activeStatus);

    const rolledBack = rollbackRelease({ ...workflowPaths(fixture), operationId: fixture.operationId });
    expect(rolledBack).toMatchObject({ ok: true, phase: "rollback", outcome: "rolled-back", rollbackOutcome: "succeeded" });
    expect(rollbackRelease({ ...workflowPaths(fixture), operationId: fixture.operationId })).toEqual(rolledBack);

    const audit = auditRelease({ basePath: fixture.basePath, allowTemporaryRoots: true });
    expect(audit).toMatchObject({ ok: true, total: 3, truncated: false });
    expect(audit.records.map((record) => [record.phase, record.outcome])).toEqual([
      ["prepare", "prepared"],
      ["activate", "active"],
      ["rollback", "rolled-back"],
    ]);
    expect(auditRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toEqual(audit);
  });

  test("keeps preflight read-only and fails on active drift", () => {
    const fixture = createFixture("preflight-failure");
    prepareFixture(fixture);
    const activationRoot = join(fixture.basePath, "activation");
    const beforeAudit = readFileSync(join(activationRoot, "audit.jsonl"), "utf8");
    const beforeOperations = readdirSync(join(activationRoot, "operations")).sort();
    const activeFeature = join(fixture.activePath, "packages/daemon/src/feature.ts");
    chmodSync(activeFeature, 0o644);
    writeFileSync(activeFeature, "export const feature = 'active-drift';\n");

    const report = preflightRelease({ ...workflowPaths(fixture), gitRoot: fixture.gitRoot });
    expect(report).toMatchObject({ ok: false, phase: "preflight" });
    expect(report.failureStage).toBe("active_content");
    expect(readFileSync(join(activationRoot, "audit.jsonl"), "utf8")).toBe(beforeAudit);
    expect(readdirSync(join(activationRoot, "operations")).sort()).toEqual(beforeOperations);
  });

  test("blocks concurrent and stale lock owners without reclaiming them", () => {
    const fixture = createFixture("locks");
    prepareFixture(fixture);
    const paths = resolveBasePaths({ basePath: fixture.basePath, allowTemporaryRoots: true });
    const owner = acquireLock(paths, "kmac-lock-owner", fixture.reviewedCommit, fixture.candidatePath, fixture.activePath);
    const concurrent = prepareRelease({
      basePath: fixture.basePath,
      candidatePath: join(fixture.basePath, "releases", "candidate-2"),
      gitRoot: fixture.gitRoot,
      reviewedCommit: fixture.reviewedCommit,
      operationId: "kmac-lock-contender",
      executor: "filesystem",
      allowTemporaryRoots: true,
    });
    expect(concurrent).toMatchObject({ ok: false, failureStage: "lock", errorCode: "deployment_lock_held" });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({
      ok: false,
      lock: { held: true, stale: false, operationId: "kmac-lock-owner" },
    });
    owner.release();

    const staleLock = {
      schema: "argus.kmac.release-lock",
      version: 1,
      nonce: "0".repeat(36),
      operationId: "kmac-stale-owner",
      pid: 1,
      host: "fixture",
      startedAt: new Date(Date.now() - LOCK_MAX_AGE_MS * 2).toISOString(),
      reviewedCommit: fixture.reviewedCommit,
      candidatePath: null,
      activePath: null,
      currentPath: paths.current,
    };
    writeFileSync(paths.lock, `${JSON.stringify(staleLock)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(paths.lock, 0o600);
    const stale = prepareRelease({
      basePath: fixture.basePath,
      candidatePath: join(fixture.basePath, "releases", "candidate-3"),
      gitRoot: fixture.gitRoot,
      reviewedCommit: fixture.reviewedCommit,
      operationId: "kmac-stale-contender",
      executor: "filesystem",
      allowTemporaryRoots: true,
    });
    expect(stale).toMatchObject({ ok: false, failureStage: "lock", errorCode: "stale_lock_owner" });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({
      ok: false,
      lock: { held: true, stale: true, operationId: "kmac-stale-owner" },
    });
    unlinkSync(paths.lock);
  });

  test("rejects stale operation requests and path aliases", () => {
    const fixture = createFixture("stale-request");
    prepareFixture(fixture);
    const otherCandidate = join(fixture.basePath, "releases", "candidate-other");
    cpSync(fixture.candidatePath, otherCandidate, { recursive: true });
    const stale = activateRelease({
      ...workflowPaths(fixture),
      candidatePath: otherCandidate,
      gitRoot: fixture.gitRoot,
      operationId: fixture.operationId,
      executor: "filesystem",
    });
    expect(stale).toMatchObject({ ok: false, failureStage: "stale_request", errorCode: "operation_request_mismatch" });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({ ok: true, state: "active" });

    const alias = preflightRelease({
      ...workflowPaths(fixture),
      candidatePath: `${fixture.candidatePath}/`,
      gitRoot: fixture.gitRoot,
    });
    expect(alias).toMatchObject({ ok: false, failureStage: "path_validation" });
  });

  test("rejects tampered manifests, candidate symlinks, and outside paths", () => {
    const fixture = createFixture("tamper-path");
    prepareFixture(fixture);
    const candidateFeature = join(fixture.candidatePath, "packages/daemon/src/feature.ts");
    chmodSync(candidateFeature, 0o644);
    writeFileSync(candidateFeature, "export const feature = 'candidate-drift';\n");
    const tamperedCandidate = preflightRelease({ ...workflowPaths(fixture), gitRoot: fixture.gitRoot });
    expect(tamperedCandidate).toMatchObject({ ok: false, failureStage: "candidate_content" });
    writeFileSync(candidateFeature, "export const feature = 1;\n");
    chmodSync(candidateFeature, 0o444);
    const manifest = join(fixture.candidatePath, ".argus-functional-manifest.json");
    chmodSync(manifest, 0o644);
    writeFileSync(manifest, "{\"tamperedSecret\":\"DO_NOT_PRINT\"}\n");
    const tampered = preflightRelease({ ...workflowPaths(fixture), gitRoot: fixture.gitRoot });
    expect(tampered).toMatchObject({ ok: false, failureStage: "candidate_manifest" });
    expect(JSON.stringify(tampered)).not.toContain("DO_NOT_PRINT");

    removeTempTree(fixture.candidatePath);
    const outside = join(fixture.root, "outside-release");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    symlinkSync(outside, fixture.candidatePath);
    const symlinkCandidate = preflightRelease({ ...workflowPaths(fixture), gitRoot: fixture.gitRoot });
    expect(symlinkCandidate).toMatchObject({ ok: false, failureStage: "path_validation" });
    unlinkSync(fixture.candidatePath);

    const escaped = preflightRelease({
      ...workflowPaths(fixture),
      candidatePath: outside,
      gitRoot: fixture.gitRoot,
    });
    expect(escaped).toMatchObject({ ok: false, failureStage: "path_validation" });

    unlinkSync(fixture.currentPath);
    writeFileSync(fixture.currentPath, "current must remain a symlink\n");
    expect(() => atomicSymlinkSwitch(fixture.currentPath, fixture.candidatePath, "switch", fixture.activePath))
      .toThrow("current_link_invalid");
  });

  test("derives rollback state from a durable activating marker after interruption", () => {
    const fixture = createFixture("interrupted");
    prepareFixture(fixture);
    const preflight = preflightRelease({ ...workflowPaths(fixture), gitRoot: fixture.gitRoot });
    expect(preflight.ok).toBe(true);
    if (!preflight.active) throw new Error("fixture active identity missing");
    const paths = resolveBasePaths({ basePath: fixture.basePath, allowTemporaryRoots: true });
    const prepared = readOperationState(paths, fixture.operationId);
    const activeDirectory = statDirectoryIdentity(fixture.activePath);
    if (!prepared || !activeDirectory) throw new Error("fixture operation identity missing");
    persistOperationState(paths, {
      ...prepared,
      phase: "activate",
      status: "activating",
      active: preflight.active,
      activeDirectory,
      updatedAt: new Date().toISOString(),
    });
    atomicSymlinkSwitch(fixture.currentPath, fixture.candidatePath, "switch", fixture.activePath);
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({
      ok: false,
      state: "rollback-required",
      latestOperation: { status: "activating" },
    });
    const rollback = rollbackRelease({ ...workflowPaths(fixture), operationId: fixture.operationId });
    expect(rollback).toMatchObject({ ok: true, outcome: "rolled-back" });
  });

  test("records rollback-required after a post-switch failure and restores the exact prior release", () => {
    const fixture = createFixture("post-switch");
    prepareFixture(fixture);
    const failed = activateFixture(fixture, {
      afterSwitch: () => {
        throw new Error("post-switch fixture failure");
      },
    });
    expect(failed).toMatchObject({ ok: false, failureStage: "operation_state", rollbackOutcome: "not-requested" });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({
      ok: false,
      state: "rollback-required",
      latestOperation: { status: "needs-rollback" },
    });
    const rolledBack = rollbackRelease({ ...workflowPaths(fixture), operationId: fixture.operationId });
    expect(rolledBack).toMatchObject({ ok: true, outcome: "rolled-back", rollbackOutcome: "succeeded" });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({ ok: true, state: "active" });
  });

  test("fails closed when the exact prior release cannot be verified for rollback", () => {
    const fixture = createFixture("rollback-verification");
    prepareFixture(fixture);
    expect(activateFixture(fixture).ok).toBe(true);
    const activeFeature = join(fixture.activePath, "packages/daemon/src/feature.ts");
    chmodSync(activeFeature, 0o644);
    writeFileSync(activeFeature, "export const feature = 'prior-release-tampered';\n");
    const rollback = rollbackRelease({ ...workflowPaths(fixture), operationId: fixture.operationId });
    expect(rollback).toMatchObject({ ok: false, failureStage: "rollback_verification", rollbackOutcome: "failed" });
    expect(statusRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({
      ok: false,
      state: "rollback-required",
    });
  });

  test("rejects audit tampering and keeps CLI errors strict, bounded, and redacted", () => {
    const fixture = createFixture("output-audit");
    prepareFixture(fixture);
    expect(activateFixture(fixture).ok).toBe(true);
    const auditPath = join(fixture.basePath, "activation", "audit.jsonl");
    const lines = readFileSync(auditPath, "utf8").trimEnd().split("\n");
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first.outcome = "blocked";
    lines[0] = JSON.stringify(first);
    chmodSync(auditPath, 0o600);
    writeFileSync(auditPath, `${lines.join("\n")}\n`);
    expect(auditRelease({ basePath: fixture.basePath, allowTemporaryRoots: true })).toMatchObject({
      ok: false,
      failureStage: "audit",
    });

    const secret = `CLI_SECRET_${randomUUID()}`;
    const unknown = runCli(["status", "--base-path", "/tmp/argus-secret-fixture", "--unknown", secret]);
    expect(unknown.exitCode).toBe(64);
    expect(Buffer.byteLength(unknown.output, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(unknown.output).not.toContain(secret);
    expect(JSON.parse(unknown.output)).toMatchObject({ schema: WORKFLOW_SCHEMA, ok: false, failureStage: "usage" });

    const booleanValue = runCli(["status", "--json=false"]);
    expect(booleanValue.exitCode).toBe(64);
    expect(JSON.parse(booleanValue.output)).toMatchObject({ ok: false, failureStage: "usage" });

    const filesystemCli = runCli(["activate", "--executor", "filesystem"]);
    expect(filesystemCli.exitCode).toBe(64);
    expect(JSON.parse(filesystemCli.output)).toMatchObject({
      ok: false,
      phase: "activate",
      errorCode: "filesystem_executor_is_api_only",
    });

    const filesystemPrepareCli = runCli(["prepare", "--executor", "filesystem"]);
    expect(filesystemPrepareCli.exitCode).toBe(64);
    expect(JSON.parse(filesystemPrepareCli.output)).toMatchObject({
      ok: false,
      phase: "prepare",
      errorCode: "filesystem_executor_is_api_only",
    });

    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    expect(packageJson.scripts?.["release:workflow"]).toBe("bun run deploy/kmac-release-workflow.ts");
  });
});
