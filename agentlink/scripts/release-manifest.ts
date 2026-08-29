import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const FUNCTIONAL_MANIFEST_FILE = ".argus-functional-manifest.json";
const MANIFEST_VERSION = 1;
const MANIFEST_SCOPE = "agentlink-functional-runtime";
const MAX_FUNCTIONAL_FILES = 5_000;
const MAX_FUNCTIONAL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REPORTED_DIFFERENCES = 64;

const FUNCTIONAL_FILES = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "mesh.example.json",
  "packages/daemon/package.json",
  "packages/wire/package.json",
  "packages/relay/package.json",
  "packages/app/package.json",
  "packages/app/index.html",
  "packages/app/postcss.config.js",
  "packages/app/tailwind.config.js",
  "packages/app/tsconfig.json",
  "packages/app/vite.config.ts",
] as const;

const FUNCTIONAL_DIRECTORIES = [
  "packages/daemon/src",
  "packages/wire/src",
  "packages/relay/src",
  "packages/app/src",
  "packages/app/public",
  "deploy",
  "scripts",
] as const;

export interface FunctionalManifestEntry {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface FunctionalManifest {
  version: 1;
  scope: "agentlink-functional-runtime";
  algorithm: "sha256";
  gitCommit: string;
  entries: FunctionalManifestEntry[];
}

export interface FunctionalDifference {
  path: string;
  status: "added" | "removed" | "modified";
  expected?: Pick<FunctionalManifestEntry, "size" | "sha256" | "executable">;
  actual?: Pick<FunctionalManifestEntry, "size" | "sha256" | "executable">;
}

export interface GitArtifactDifference {
  path: string;
  status: "added" | "removed" | "modified";
}

export interface BoundedDifferences<T> {
  total: number;
  truncated: boolean;
  items: T[];
}

interface ReleaseVerification {
  manifestValid: boolean;
  treeMatchesManifest: boolean;
  gitCommit: string | null;
  error: "manifest-missing" | "manifest-invalid" | "tree-unreadable" | null;
  differences: BoundedDifferences<FunctionalDifference>;
  manifest?: FunctionalManifest;
}

export interface FunctionalPreflightReport {
  version: 1;
  ok: boolean;
  gitArtifact: {
    clean: boolean;
    gitCommit: string | null;
    error: "git-unavailable" | null;
    differences: BoundedDifferences<GitArtifactDifference>;
  };
  candidate: Omit<ReleaseVerification, "manifest"> & {
    matchesGitArtifact: boolean;
    manifestCommitMatches: boolean;
    artifactDifferences: BoundedDifferences<FunctionalDifference>;
  };
  active: Omit<ReleaseVerification, "manifest">;
  plannedChanges: BoundedDifferences<FunctionalDifference>;
}

export class FunctionalManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly differences: Array<FunctionalDifference | GitArtifactDifference> = [],
  ) {
    super(message);
  }
}

export function isSelectedFunctionalPath(path: string): boolean {
  if (!isSafeRelativePath(path) || isExcludedFunctionalPath(path)) return false;
  return FUNCTIONAL_FILES.includes(path as (typeof FUNCTIONAL_FILES)[number])
    || FUNCTIONAL_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`));
}

export function buildFunctionalManifest(root: string, gitCommit: string): FunctionalManifest {
  const commit = gitCommit.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new FunctionalManifestError("invalid-git-commit", "functional manifest git commit is invalid");
  }
  return parseFunctionalManifest({
    version: MANIFEST_VERSION,
    scope: MANIFEST_SCOPE,
    algorithm: "sha256",
    gitCommit: commit,
    entries: collectFunctionalEntries(root),
  });
}

export function parseFunctionalManifest(value: unknown): FunctionalManifest {
  if (!isRecord(value)
    || !hasExactKeys(value, ["version", "scope", "algorithm", "gitCommit", "entries"])
    || value.version !== MANIFEST_VERSION
    || value.scope !== MANIFEST_SCOPE
    || value.algorithm !== "sha256"
    || typeof value.gitCommit !== "string"
    || !/^[a-f0-9]{40,64}$/.test(value.gitCommit)
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_FUNCTIONAL_FILES) {
    throw new FunctionalManifestError("manifest-invalid", "functional release manifest is invalid");
  }
  const entries: FunctionalManifestEntry[] = value.entries.map((entry) => {
    if (!isRecord(entry)
      || !hasExactKeys(entry, ["path", "size", "sha256", "executable"])
      || typeof entry.path !== "string"
      || entry.path.length < 1
      || entry.path.length > 512
      || typeof entry.size !== "number"
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || entry.size > MAX_FUNCTIONAL_FILE_BYTES
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || typeof entry.executable !== "boolean") {
      throw new FunctionalManifestError("manifest-invalid", "functional release manifest entry is invalid");
    }
    return {
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
      executable: entry.executable,
    };
  });
  const paths = entries.map((entry) => entry.path);
  if (paths.some((path) => !isSelectedFunctionalPath(path))
    || new Set(paths).size !== paths.length
    || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    throw new FunctionalManifestError("manifest-invalid", "functional release manifest paths are invalid");
  }
  return {
    version: 1,
    scope: MANIFEST_SCOPE,
    algorithm: "sha256",
    gitCommit: value.gitCommit,
    entries,
  };
}

export function readFunctionalManifest(root: string): FunctionalManifest {
  const file = join(resolve(root), FUNCTIONAL_MANIFEST_FILE);
  if (!existsSync(file)) {
    throw new FunctionalManifestError("manifest-missing", "functional release manifest is missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new FunctionalManifestError("manifest-invalid", "functional release manifest is unreadable");
  }
  return parseFunctionalManifest(value);
}

export function writeFunctionalManifest(root: string, manifest: FunctionalManifest): void {
  const parsed = parseFunctionalManifest(manifest);
  const file = join(resolve(root), FUNCTIONAL_MANIFEST_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function verifyFunctionalManifest(
  root: string,
  manifest: FunctionalManifest,
): FunctionalDifference[] {
  const actual: FunctionalManifest = {
    ...parseFunctionalManifest(manifest),
    entries: collectFunctionalEntries(root),
  };
  return compareFunctionalManifests(manifest, actual);
}

export function compareFunctionalManifests(
  expected: FunctionalManifest,
  actual: FunctionalManifest,
): FunctionalDifference[] {
  const expectedEntries = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualEntries = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...expectedEntries.keys(), ...actualEntries.keys()])].sort();
  const differences: FunctionalDifference[] = [];
  for (const path of paths) {
    const before = expectedEntries.get(path);
    const after = actualEntries.get(path);
    if (!before && after) {
      differences.push({ path, status: "added", actual: entryIdentity(after) });
    } else if (before && !after) {
      differences.push({ path, status: "removed", expected: entryIdentity(before) });
    } else if (before && after && (before.size !== after.size
      || before.sha256 !== after.sha256
      || before.executable !== after.executable)) {
      differences.push({
        path,
        status: "modified",
        expected: entryIdentity(before),
        actual: entryIdentity(after),
      });
    }
  }
  return differences;
}

export function inspectGitArtifact(root: string): {
  gitCommit: string;
  differences: GitArtifactDifference[];
} {
  const normalizedRoot = resolve(root);
  const gitCommit = gitOutput(normalizedRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(gitCommit)) {
    throw new FunctionalManifestError("git-unavailable", "Git HEAD is invalid");
  }
  const tracked = new Set(splitNul(gitOutput(normalizedRoot, [
    "ls-files", "-z", "--", ...FUNCTIONAL_FILES, ...FUNCTIONAL_DIRECTORIES,
  ])).filter(isSelectedFunctionalPath));
  const actual = new Set(collectFunctionalEntries(normalizedRoot).map((entry) => entry.path));
  const modified = new Set(splitNul(gitOutput(normalizedRoot, [
    "diff", "--name-only", "-z", "--relative", "--no-renames", "HEAD", "--",
    ...FUNCTIONAL_FILES, ...FUNCTIONAL_DIRECTORIES,
  ])).filter(isSelectedFunctionalPath));
  const differences: GitArtifactDifference[] = [];
  for (const path of actual) {
    if (!tracked.has(path)) differences.push({ path, status: "added" });
    else if (modified.has(path)) differences.push({ path, status: "modified" });
  }
  for (const path of tracked) {
    if (!actual.has(path)) differences.push({ path, status: "removed" });
  }
  differences.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
  return { gitCommit, differences };
}

export function buildGitFunctionalManifest(root: string): FunctionalManifest {
  const inspected = inspectGitArtifact(root);
  if (inspected.differences.length > 0) {
    throw new FunctionalManifestError(
      "git-artifact-drift",
      "functional files do not match the Git artifact",
      inspected.differences,
    );
  }
  return buildFunctionalManifest(root, inspected.gitCommit);
}

export function preflightFunctionalReleases(options: {
  gitRoot: string;
  candidateRoot: string;
  activeRoot: string;
}): FunctionalPreflightReport {
  let gitCommit: string | null = null;
  let gitError: "git-unavailable" | null = null;
  let gitDifferences: GitArtifactDifference[] = [];
  let gitManifest: FunctionalManifest | undefined;
  try {
    const inspected = inspectGitArtifact(options.gitRoot);
    gitCommit = inspected.gitCommit;
    gitDifferences = inspected.differences;
    if (gitDifferences.length === 0) gitManifest = buildFunctionalManifest(options.gitRoot, gitCommit);
  } catch {
    gitError = "git-unavailable";
  }

  const candidate = verifyRelease(options.candidateRoot);
  const active = verifyRelease(options.activeRoot);
  const artifactDifferences = gitManifest && candidate.manifest
    ? compareFunctionalManifests(gitManifest, candidate.manifest)
    : [];
  const manifestCommitMatches = Boolean(
    gitManifest && candidate.manifest && gitManifest.gitCommit === candidate.manifest.gitCommit,
  );
  const matchesGitArtifact = manifestCommitMatches && artifactDifferences.length === 0;
  const plannedChanges = candidate.manifest && active.manifest
    ? compareFunctionalManifests(active.manifest, candidate.manifest)
    : [];

  return {
    version: 1,
    ok: gitError === null
      && gitDifferences.length === 0
      && candidate.manifestValid
      && candidate.treeMatchesManifest
      && matchesGitArtifact
      && active.manifestValid
      && active.treeMatchesManifest,
    gitArtifact: {
      clean: gitError === null && gitDifferences.length === 0,
      gitCommit,
      error: gitError,
      differences: boundDifferences(gitDifferences),
    },
    candidate: {
      ...publicVerification(candidate),
      matchesGitArtifact,
      manifestCommitMatches,
      artifactDifferences: boundDifferences(artifactDifferences),
    },
    active: publicVerification(active),
    plannedChanges: boundDifferences(plannedChanges),
  };
}

export function boundDifferences<T>(items: readonly T[], limit = MAX_REPORTED_DIFFERENCES): BoundedDifferences<T> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  return {
    total: items.length,
    truncated: items.length > boundedLimit,
    items: items.slice(0, boundedLimit),
  };
}

function collectFunctionalEntries(root: string): FunctionalManifestEntry[] {
  const normalizedRoot = resolve(root);
  const paths = new Set<string>();
  for (const file of FUNCTIONAL_FILES) {
    const absolute = join(normalizedRoot, ...file.split("/"));
    if (existsSync(absolute)) collectFile(normalizedRoot, absolute, paths);
  }
  for (const directory of FUNCTIONAL_DIRECTORIES) {
    const absolute = join(normalizedRoot, ...directory.split("/"));
    if (!existsSync(absolute)) continue;
    if (!lstatSync(absolute).isDirectory()) {
      throw new FunctionalManifestError("tree-unreadable", `functional path is not a directory: ${directory}`);
    }
    walkFunctionalDirectory(normalizedRoot, absolute, paths);
  }
  if (paths.size > MAX_FUNCTIONAL_FILES) {
    throw new FunctionalManifestError("tree-unreadable", "functional file count exceeds the manifest limit");
  }
  return [...paths].sort().map((path) => {
    const absolute = join(normalizedRoot, ...path.split("/"));
    const stat = statSync(absolute);
    if (stat.size > MAX_FUNCTIONAL_FILE_BYTES) {
      throw new FunctionalManifestError("tree-unreadable", `functional file exceeds the size limit: ${path}`);
    }
    const bytes = readFileSync(absolute);
    return {
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: (stat.mode & 0o111) !== 0,
    };
  });
}

function walkFunctionalDirectory(root: string, directory: string, paths: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    const path = relativePath(root, absolute);
    if (isExcludedFunctionalPath(path)) continue;
    if (entry.isDirectory()) {
      walkFunctionalDirectory(root, absolute, paths);
    } else if (entry.isFile()) {
      collectFile(root, absolute, paths);
    } else {
      throw new FunctionalManifestError("tree-unreadable", `functional tree contains a non-regular file: ${path}`);
    }
  }
}

function collectFile(root: string, absolute: string, paths: Set<string>): void {
  const stat = lstatSync(absolute);
  const path = relativePath(root, absolute);
  if (!stat.isFile() || !isSelectedFunctionalPath(path)) {
    throw new FunctionalManifestError("tree-unreadable", `functional path is invalid: ${path}`);
  }
  paths.add(path);
}

function verifyRelease(root: string): ReleaseVerification {
  const file = join(resolve(root), FUNCTIONAL_MANIFEST_FILE);
  if (!existsSync(file)) return invalidVerification("manifest-missing");
  let manifest: FunctionalManifest;
  try {
    manifest = readFunctionalManifest(root);
  } catch {
    return invalidVerification("manifest-invalid");
  }
  try {
    const differences = verifyFunctionalManifest(root, manifest);
    return {
      manifestValid: true,
      treeMatchesManifest: differences.length === 0,
      gitCommit: manifest.gitCommit,
      error: null,
      differences: boundDifferences(differences),
      manifest,
    };
  } catch {
    return {
      manifestValid: true,
      treeMatchesManifest: false,
      gitCommit: manifest.gitCommit,
      error: "tree-unreadable",
      differences: boundDifferences([]),
      manifest,
    };
  }
}

function invalidVerification(error: "manifest-missing" | "manifest-invalid"): ReleaseVerification {
  return {
    manifestValid: false,
    treeMatchesManifest: false,
    gitCommit: null,
    error,
    differences: boundDifferences([]),
  };
}

function publicVerification(value: ReleaseVerification): Omit<ReleaseVerification, "manifest"> {
  const { manifest: _manifest, ...publicValue } = value;
  return publicValue;
}

function entryIdentity(entry: FunctionalManifestEntry): Pick<FunctionalManifestEntry, "size" | "sha256" | "executable"> {
  return { size: entry.size, sha256: entry.sha256, executable: entry.executable };
}

function relativePath(root: string, absolute: string): string {
  const path = relative(root, absolute).split(sep).join("/");
  if (!isSafeRelativePath(path)) {
    throw new FunctionalManifestError("tree-unreadable", "functional path escaped the release root");
  }
  return path;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isExcludedFunctionalPath(path: string): boolean {
  const parts = path.split("/");
  const basename = parts.at(-1) ?? "";
  return parts.includes("node_modules")
    || basename === ".DS_Store"
    || basename === ".env"
    || basename.startsWith(".env.")
    || basename.endsWith(".log")
    || basename.endsWith(".pem")
    || basename.endsWith(".key")
    || basename.endsWith(".p12")
    || basename.endsWith(".pfx")
    || basename === "mesh.json"
    || basename === "identity.json"
    || basename === "peers.json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new FunctionalManifestError("git-unavailable", "unable to inspect the Git artifact");
  }
  return result.stdout;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredFlag(args: string[], flag: string): string {
  const value = flagValue(args, flag)?.trim();
  if (!value) throw new FunctionalManifestError("usage", `missing ${flag}`);
  return value;
}

async function main(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "write") {
    const root = resolve(flagValue(args, "--root") ?? process.cwd());
    const manifest = buildGitFunctionalManifest(root);
    writeFunctionalManifest(root, manifest);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      manifest: FUNCTIONAL_MANIFEST_FILE,
      gitCommit: manifest.gitCommit,
      files: manifest.entries.length,
    }, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const root = resolve(requiredFlag(args, "--release"));
    const verification = verifyRelease(root);
    const result = { ok: verification.manifestValid && verification.treeMatchesManifest, ...publicVerification(verification) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "preflight") {
    const report = preflightFunctionalReleases({
      gitRoot: resolve(flagValue(args, "--git-root") ?? process.cwd()),
      candidateRoot: resolve(requiredFlag(args, "--candidate")),
      activeRoot: resolve(requiredFlag(args, "--active")),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  throw new FunctionalManifestError(
    "usage",
    "usage: release:manifest write [--root DIR] | verify --release DIR | preflight --candidate DIR --active DIR [--git-root DIR]",
  );
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error) => {
    const known = error instanceof FunctionalManifestError ? error : undefined;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: known?.code ?? "manifest-gate-failed",
      message: known?.message ?? "functional release manifest gate failed",
      differences: boundDifferences(known?.differences ?? []),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
