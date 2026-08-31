import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildFunctionalManifest,
  buildGitFunctionalManifest,
  compareFunctionalManifests,
  inspectGitArtifact,
  parseFunctionalManifest,
  verifyFunctionalManifest,
  boundDifferences,
  type FunctionalDifference,
  type FunctionalManifest,
} from "../scripts/release-manifest";
import {
  COMMIT_PATTERN,
  MAX_MANIFEST_BYTES,
  MAX_PATH_LENGTH,
  MAX_PUBLIC_DIFFERENCES,
  MAX_RELEASE_FILES,
  type Bounded,
  type DirectoryIdentity,
  type FailureStage,
  type PreflightOptions,
  type PreflightReport,
  type ReleaseCheck,
  type ReleaseIdentity,
  type ReleasePaths,
} from "./kmac-release-workflow-types";
import { fail, WorkflowError } from "./kmac-release-workflow-error";
import {
  chmodImmutable,
  currentTarget,
  hashFile,
  identitiesEqual,
  normalizeCommit,
  readBounded,
  resolveGitRoot,
  resolveReleasePaths,
  statDirectoryIdentity,
} from "./kmac-release-workflow-storage";

interface TreeEntry {
  kind: "file" | "directory" | "symlink";
  identity: DirectoryIdentity;
  mode: number;
  linkTarget: string | null;
  resolvedTarget: string | null;
  targetIdentity: DirectoryIdentity | null;
  targetKind: "file" | "directory" | null;
}

interface TreeScan {
  entries: Map<string, TreeEntry>;
  immutable: boolean;
}

function emptyCheck(failureStage: FailureStage): ReleaseCheck {
  return {
    manifestValid: false,
    treeMatchesManifest: false,
    immutable: false,
    gitCommit: null,
    manifestDigest: null,
    differences: boundDifferences([], MAX_PUBLIC_DIFFERENCES),
    identity: null,
    manifest: null,
    directoryIdentity: null,
    failureStage,
  };
}

function isWithinRelease(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isDependencySymlink(path: string): boolean {
  return path.startsWith("node_modules/") || path.includes("/node_modules/");
}

function scanTree(root: string, stage: FailureStage, allowDependencySymlinks = true): TreeScan {
  const releaseRoot = resolve(root);
  const entries = new Map<string, TreeEntry>();
  const stack = [{ path: releaseRoot, relative: "" }];
  let immutable = true;
  while (stack.length > 0) {
    const item = stack.pop()!;
    const stat = lstatSync(item.path);
    if (stat.isSymbolicLink()) {
      if (!allowDependencySymlinks || !isDependencySymlink(item.relative)) fail(stage, "release_symlink");
      let linkTarget: string;
      let finalTarget: string;
      try {
        linkTarget = readlinkSync(item.path);
        if (linkTarget.length === 0
          || linkTarget.length > MAX_PATH_LENGTH
          || linkTarget.includes("\n")
          || linkTarget.includes("\r")
          || isAbsolute(linkTarget)) {
          fail(stage, "release_symlink_target_invalid");
        }
        const lexicalTarget = resolve(dirname(item.path), linkTarget);
        if (!isWithinRelease(releaseRoot, lexicalTarget)) fail(stage, "release_symlink_escape");
        finalTarget = realpathSync(item.path);
        if (!isWithinRelease(releaseRoot, finalTarget)) fail(stage, "release_symlink_escape");
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        fail(stage, "release_symlink_target_invalid");
      }
      const targetStat = lstatSync(finalTarget!);
      if (!targetStat.isDirectory() && !targetStat.isFile()) fail(stage, "release_symlink_target_invalid");
      if (targetStat.isDirectory()
        && (finalTarget! === releaseRoot || item.path.startsWith(`${finalTarget!}${sep}`))) {
        fail(stage, "release_symlink_cycle");
      }
      entries.set(item.relative, {
        kind: "symlink",
        identity: { device: stat.dev, inode: stat.ino },
        mode: stat.mode,
        linkTarget: linkTarget!,
        resolvedTarget: relative(releaseRoot, finalTarget!).split(sep).join("/"),
        targetIdentity: { device: targetStat.dev, inode: targetStat.ino },
        targetKind: targetStat.isDirectory() ? "directory" : "file",
      });
    } else if (stat.isDirectory()) {
      entries.set(item.relative, {
        kind: "directory",
        identity: { device: stat.dev, inode: stat.ino },
        mode: stat.mode,
        linkTarget: null,
        resolvedTarget: null,
        targetIdentity: null,
        targetKind: null,
      });
      if ((stat.mode & 0o222) !== 0) immutable = false;
      const children = readdirSync(item.path, { withFileTypes: true });
      if (entries.size + stack.length + children.length > MAX_RELEASE_FILES) fail(stage, "release_file_limit");
      for (const child of children) {
        const childPath = join(item.path, child.name);
        const childRelative = item.relative.length === 0 ? child.name : `${item.relative}/${child.name}`;
        const childStat = lstatSync(childPath);
        if (child.isSymbolicLink() !== childStat.isSymbolicLink()
          || child.isDirectory() !== childStat.isDirectory()
          || child.isFile() !== childStat.isFile()) fail(stage, "release_changed");
        if (!childStat.isSymbolicLink() && !childStat.isDirectory() && !childStat.isFile()) {
          fail(stage, "release_special_file");
        }
        stack.push({ path: childPath, relative: childRelative });
      }
    } else if (stat.isFile()) {
      entries.set(item.relative, {
        kind: "file",
        identity: { device: stat.dev, inode: stat.ino },
        mode: stat.mode,
        linkTarget: null,
        resolvedTarget: null,
        targetIdentity: null,
        targetKind: null,
      });
      if ((stat.mode & 0o222) !== 0) immutable = false;
    } else {
      fail(stage, "release_special_file");
    }
  }
  return { entries, immutable };
}

function sameEntryIdentity(left: TreeEntry, right: TreeEntry): boolean {
  return left.kind === right.kind
    && left.identity.device === right.identity.device
    && left.identity.inode === right.identity.inode
    && left.linkTarget === right.linkTarget
    && left.resolvedTarget === right.resolvedTarget
    && left.targetIdentity?.device === right.targetIdentity?.device
    && left.targetIdentity?.inode === right.targetIdentity?.inode
    && left.targetKind === right.targetKind;
}

function sameTree(left: TreeScan, right: TreeScan): boolean {
  if (left.entries.size !== right.entries.size) return false;
  for (const [path, before] of left.entries) {
    const after = right.entries.get(path);
    if (!after
      || !sameEntryIdentity(before, after)
      || before.mode !== after.mode) return false;
  }
  return true;
}

function sameTreeShape(left: TreeScan, right: TreeScan): boolean {
  if (left.entries.size !== right.entries.size) return false;
  for (const [path, before] of left.entries) {
    const after = right.entries.get(path);
    if (!after || !sameEntryIdentity(before, after)) return false;
  }
  return true;
}

function manifestDigest(root: string, stage: FailureStage): string {
  return hashFile(join(root, ".argus-functional-manifest.json"), MAX_MANIFEST_BYTES, stage);
}

export function checkRelease(
  root: string,
  options: { requireImmutable: boolean; manifestStage: FailureStage; contentStage: FailureStage; mutabilityStage: FailureStage },
): ReleaseCheck {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return emptyCheck(options.contentStage);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return emptyCheck(options.contentStage);
  const directoryIdentity: DirectoryIdentity = { device: rootStat.dev, inode: rootStat.ino };
  let before: TreeScan;
  try {
    before = scanTree(root, options.contentStage);
  } catch (error) {
    return { ...emptyCheck(error instanceof WorkflowError ? error.stage : options.contentStage), directoryIdentity };
  }
  const manifestPath = join(root, ".argus-functional-manifest.json");
  let manifest: FunctionalManifest;
  let initialDigest: string;
  try {
    manifest = parseFunctionalManifest(JSON.parse(readBounded(manifestPath, MAX_MANIFEST_BYTES, options.manifestStage)));
    initialDigest = manifestDigest(root, options.contentStage);
  } catch {
    return { ...emptyCheck(options.manifestStage), directoryIdentity };
  }

  let differences: FunctionalDifference[];
  let after: TreeScan;
  let finalDigest: string;
  try {
    differences = verifyFunctionalManifest(root, manifest);
    after = scanTree(root, options.contentStage);
    const secondDifferences = verifyFunctionalManifest(root, manifest);
    finalDigest = manifestDigest(root, options.contentStage);
    if (!sameTree(before, after)
      || differences.length !== secondDifferences.length
      || JSON.stringify(differences) !== JSON.stringify(secondDifferences)
      || initialDigest !== finalDigest) {
      return {
        ...emptyCheck(options.contentStage),
        manifestValid: true,
        gitCommit: manifest.gitCommit,
        manifestDigest: finalDigest,
        manifest,
        directoryIdentity,
      };
    }
  } catch (error) {
    return {
      ...emptyCheck(error instanceof WorkflowError ? error.stage : options.contentStage),
      manifestValid: true,
      gitCommit: manifest.gitCommit,
      manifestDigest: (() => {
        try {
          return manifestDigest(root, options.contentStage);
        } catch {
          return null;
        }
      })(),
      manifest,
      directoryIdentity,
    };
  }

  const identity: ReleaseIdentity = {
    id: basename(root),
    path: root,
    gitCommit: manifest.gitCommit,
    manifestDigest: finalDigest,
  };
  const immutable = before.immutable && after.immutable;
  return {
    manifestValid: true,
    treeMatchesManifest: differences.length === 0,
    immutable,
    gitCommit: manifest.gitCommit,
    manifestDigest: finalDigest,
    differences: boundDifferences(differences, MAX_PUBLIC_DIFFERENCES),
    identity,
    manifest,
    directoryIdentity,
    failureStage: differences.length !== 0
      ? options.contentStage
      : options.requireImmutable && !immutable
        ? options.mutabilityStage
        : "none",
  };
}

export function releaseCheckIsUsable(check: ReleaseCheck, requireImmutable: boolean): boolean {
  return check.manifestValid
    && check.treeMatchesManifest
    && (!requireImmutable || check.immutable)
    && check.identity !== null
    && check.manifest !== null;
}

export function requireReleaseCheck(check: ReleaseCheck, stage: FailureStage, requireImmutable: boolean): {
  identity: ReleaseIdentity;
  manifest: FunctionalManifest;
  directoryIdentity: DirectoryIdentity;
} {
  if (!releaseCheckIsUsable(check, requireImmutable) || !check.identity || !check.manifest || !check.directoryIdentity) {
    fail(check.failureStage === "none" ? stage : check.failureStage, "release_verification_failed");
  }
  return { identity: check.identity, manifest: check.manifest, directoryIdentity: check.directoryIdentity };
}

export function identityMatchesDirectory(path: string, expected: DirectoryIdentity): boolean {
  return identitiesEqual(statDirectoryIdentity(path), expected);
}

export function verifyManifestAgainstCommit(check: ReleaseCheck, reviewedCommit: string): boolean {
  return check.manifestValid && check.treeMatchesManifest && check.gitCommit === reviewedCommit;
}

export interface PreflightEvaluation {
  report: PreflightReport;
  paths: ReleasePaths | null;
  candidate: ReturnType<typeof requireReleaseCheck> | null;
  active: ReturnType<typeof requireReleaseCheck> | null;
  gitManifest: FunctionalManifest | null;
}

function blankPreflight(reviewedCommit: string, failureStage: FailureStage = "path_validation"): PreflightReport {
  return {
    schema: "argus.kmac.release-workflow",
    version: 1,
    phase: "preflight",
    ok: false,
    reviewedCommit,
    candidatePath: null,
    activePath: null,
    gitArtifact: { clean: false, gitCommit: null, differences: boundDifferences([], MAX_PUBLIC_DIFFERENCES) },
    candidate: {
      manifestValid: false,
      treeMatchesManifest: false,
      immutable: false,
      gitCommit: null,
      manifestDigest: null,
      differences: boundDifferences([], MAX_PUBLIC_DIFFERENCES),
      artifactDifferences: boundDifferences([], MAX_PUBLIC_DIFFERENCES),
    },
    active: {
      manifestValid: false,
      treeMatchesManifest: false,
      immutable: false,
      gitCommit: null,
      manifestDigest: null,
      differences: boundDifferences([], MAX_PUBLIC_DIFFERENCES),
    },
    current: { linkPresent: false, targetPath: null, matchesActive: false },
    plannedChanges: boundDifferences([], MAX_PUBLIC_DIFFERENCES),
    failureStage,
  };
}

export function evaluatePreflight(options: PreflightOptions): PreflightEvaluation {
  let reviewedCommit: string;
  try {
    reviewedCommit = normalizeCommit(options.reviewedCommit);
  } catch {
    return { report: blankPreflight("", "reviewed_commit"), paths: null, candidate: null, active: null, gitManifest: null };
  }
  const report = blankPreflight(reviewedCommit);
  let paths: ReleasePaths;
  try {
    paths = resolveReleasePaths(options);
  } catch (error) {
    report.failureStage = error instanceof WorkflowError ? error.stage : "path_validation";
    return { report, paths: null, candidate: null, active: null, gitManifest: null };
  }
  report.candidatePath = paths.candidate;
  report.activePath = paths.active;

  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(options.gitRoot, paths.allowTemporaryRoots);
  } catch (error) {
    report.failureStage = error instanceof WorkflowError ? error.stage : "git_artifact";
    return { report, paths, candidate: null, active: null, gitManifest: null };
  }
  let inspected;
  try {
    inspected = inspectGitArtifact(gitRoot);
  } catch {
    report.failureStage = "git_artifact";
    return { report, paths, candidate: null, active: null, gitManifest: null };
  }
  report.gitArtifact = {
    clean: inspected.gitCommit === reviewedCommit && inspected.differences.length === 0,
    gitCommit: inspected.gitCommit,
    differences: boundDifferences(inspected.differences, MAX_PUBLIC_DIFFERENCES),
  };
  if (inspected.gitCommit !== reviewedCommit) report.failureStage = "reviewed_commit";
  else if (inspected.differences.length > 0) report.failureStage = "git_artifact";

  let gitManifest: FunctionalManifest;
  try {
    gitManifest = buildFunctionalManifest(gitRoot, reviewedCommit);
  } catch {
    report.failureStage = "git_artifact";
    return { report, paths, candidate: null, active: null, gitManifest: null };
  }
  const candidateCheck = checkRelease(paths.candidate, {
    requireImmutable: true,
    manifestStage: "candidate_manifest",
    contentStage: "candidate_content",
    mutabilityStage: "candidate_mutability",
  });
  const activeCheck = checkRelease(paths.active, {
    requireImmutable: false,
    manifestStage: "active_manifest",
    contentStage: "active_content",
    mutabilityStage: "active_content",
  });
  report.candidate = {
    manifestValid: candidateCheck.manifestValid,
    treeMatchesManifest: candidateCheck.treeMatchesManifest,
    immutable: candidateCheck.immutable,
    gitCommit: candidateCheck.gitCommit,
    manifestDigest: candidateCheck.manifestDigest,
    differences: candidateCheck.differences,
    artifactDifferences: candidateCheck.manifest
      ? boundDifferences(compareFunctionalManifests(gitManifest, candidateCheck.manifest), MAX_PUBLIC_DIFFERENCES)
      : boundDifferences([], MAX_PUBLIC_DIFFERENCES),
  };
  report.active = {
    manifestValid: activeCheck.manifestValid,
    treeMatchesManifest: activeCheck.treeMatchesManifest,
    immutable: activeCheck.immutable,
    gitCommit: activeCheck.gitCommit,
    manifestDigest: activeCheck.manifestDigest,
    differences: activeCheck.differences,
  };
  const current = currentTarget(paths);
  report.current = { ...current, matchesActive: current.targetPath === paths.active };
  report.plannedChanges = candidateCheck.manifest && activeCheck.manifest
    ? boundDifferences(compareFunctionalManifests(activeCheck.manifest, candidateCheck.manifest), MAX_PUBLIC_DIFFERENCES)
    : boundDifferences([], MAX_PUBLIC_DIFFERENCES);

  if (report.failureStage === "path_validation" && report.gitArtifact.clean) report.failureStage = "none";
  if (report.failureStage === "none" && !releaseCheckIsUsable(candidateCheck, true)) report.failureStage = candidateCheck.failureStage;
  if (report.failureStage === "none" && !verifyManifestAgainstCommit(candidateCheck, reviewedCommit)) report.failureStage = "candidate_manifest";
  if (report.failureStage === "none" && report.candidate.artifactDifferences.total > 0) report.failureStage = "candidate_manifest";
  if (report.failureStage === "none" && !releaseCheckIsUsable(activeCheck, false)) report.failureStage = activeCheck.failureStage;
  if (report.failureStage === "none" && !report.current.matchesActive) report.failureStage = "current_link";
  report.ok = report.failureStage === "none"
    && report.gitArtifact.clean
    && releaseCheckIsUsable(candidateCheck, true)
    && verifyManifestAgainstCommit(candidateCheck, reviewedCommit)
    && report.candidate.artifactDifferences.total === 0
    && releaseCheckIsUsable(activeCheck, false)
    && report.current.matchesActive;
  return {
    report,
    paths,
    candidate: report.ok ? requireReleaseCheck(candidateCheck, "candidate_manifest", true) : null,
    active: report.ok ? requireReleaseCheck(activeCheck, "active_manifest", false) : null,
    gitManifest,
  };
}

export function makeImmutableTree(root: string): void {
  const scan = scanTree(root, "candidate_content");
  const files = [...scan.entries.entries()]
    .filter(([, entry]) => entry.kind === "file")
    .sort(([left], [right]) => left.localeCompare(right));
  const directories = [...scan.entries.entries()]
    .filter(([, entry]) => entry.kind === "directory")
    .sort(([left], [right]) => right.length - left.length || right.localeCompare(left));
  for (const [relative, entry] of files) {
    chmodImmutable(join(root, relative), (entry.mode & 0o111) !== 0 ? 0o555 : 0o444, entry.identity);
  }
  for (const [relative, entry] of directories) {
    chmodImmutable(relative.length === 0 ? root : join(root, relative), 0o555, entry.identity);
  }
  const after = scanTree(root, "candidate_content");
  if (!after.immutable || !sameTreeShape(scan, after)) fail("candidate_mutability", "release_not_immutable");
}

export function assertArchivedTreeSafe(root: string): void {
  scanTree(root, "candidate_content", false);
}

export function makeStagingTreeRemovable(root: string): void {
  const stack = [root];
  let entries = 0;
  while (stack.length > 0) {
    const path = stack.pop()!;
    const stat = lstatSync(path);
    entries += 1;
    if (entries > MAX_RELEASE_FILES) fail("candidate_write", "release_file_limit");
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    chmodImmutable(path, 0o700, { device: stat.dev, inode: stat.ino });
    for (const child of readdirSync(path)) stack.push(join(path, child));
  }
}

function gitText(gitRoot: string, args: string[], maxBuffer = 16 * 1024): string {
  try {
    return execFileSync("git", ["-C", gitRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer,
    }).trim();
  } catch {
    fail("candidate_archive", "git_archive_failed");
  }
}

export function archiveGitTree(gitRoot: string, reviewedCommit: string, staging: string): void {
  const top = gitText(gitRoot, ["rev-parse", "--show-toplevel"]);
  const prefix = gitText(gitRoot, ["rev-parse", "--show-prefix"]);
  const spec = prefix.length === 0
    ? normalizeCommit(reviewedCommit)
    : `${normalizeCommit(reviewedCommit)}:${prefix.replace(/\/$/, "")}`;
  let archive: Buffer;
  try {
    archive = execFileSync("git", ["-C", top, "archive", "--format=tar", spec], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    fail("candidate_archive", "git_archive_failed");
  }
  try {
    execFileSync("/usr/bin/tar", ["-xf", "-", "-C", staging], {
      input: archive,
      stdio: ["pipe", "ignore", "ignore"],
      maxBuffer: 64 * 1024,
    });
  } catch {
    fail("candidate_archive", "archive_extract_failed");
  }
}

export function assertManifestCommit(gitRoot: string, reviewedCommit: string): string {
  const expected = normalizeCommit(reviewedCommit);
  const result = spawnSync("git", ["-C", gitRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    maxBuffer: 1024,
  });
  const actual = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim().toLowerCase() : "";
  if (!COMMIT_PATTERN.test(actual)) fail("git_artifact", "git_unavailable");
  if (actual !== expected) fail("reviewed_commit", "reviewed_commit_mismatch");
  return expected;
}

export function inspectCleanGitManifest(gitRoot: string, reviewedCommit: string): FunctionalManifest {
  const expected = assertManifestCommit(gitRoot, reviewedCommit);
  let inspected;
  try {
    inspected = inspectGitArtifact(gitRoot);
  } catch {
    fail("git_artifact", "git_artifact_invalid");
  }
  if (inspected.gitCommit !== expected) fail("reviewed_commit", "reviewed_commit_mismatch");
  if (inspected.differences.length > 0) fail("git_artifact", "git_artifact_dirty");
  try {
    return buildGitFunctionalManifest(gitRoot);
  } catch {
    fail("git_artifact", "git_manifest_invalid");
  }
}
