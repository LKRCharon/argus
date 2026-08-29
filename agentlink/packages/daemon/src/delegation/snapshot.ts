import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SNAPSHOT_MAX_FILES = 100_000;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SNAPSHOT_MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_RETENTION = 3;

export const DELEGATION_MANDATORY_COPY_EXCLUDES = [
  ".git",
  ".codex",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.log",
  ".DS_Store",
  "*.tsbuildinfo",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "data",
  "artifacts",
  "outputs",
  "webpage/node_modules",
  "webpage/.next",
  "webpage/.data",
  "ARGUS_SNAPSHOT.json",
] as const;

export interface MarkSecSnapshotOptions {
  sourceRoot: string;
  cacheRoot: string;
  rsyncExecutable?: string;
  now?: () => number;
}

export interface MarkSecSnapshotResult {
  snapshot: string;
  sha256: string;
  files: number;
  bytes: number;
  createdAt: string;
}

/**
 * Root-only, fixed-input production mirror. The unprivileged delegation
 * service reads the atomically selected, sealed result and never sees the
 * live MarkSec tree.
 */
export function createMarkSecSnapshot(options: MarkSecSnapshotOptions): MarkSecSnapshotResult {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("MarkSec snapshot helper must run as root");
  }
  const sourceRoot = safeExistingRoot(options.sourceRoot, "sourceRoot");
  const cacheRoot = safeCacheRoot(options.cacheRoot, sourceRoot);
  const snapshotsRoot = join(cacheRoot, "snapshots");
  mkdirSync(snapshotsRoot, { recursive: true, mode: 0o755 });
  chmodSync(cacheRoot, 0o755);
  chmodSync(snapshotsRoot, 0o755);

  const createdAt = new Date((options.now ?? Date.now)()).toISOString();
  const stamp = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const id = `marksec-${stamp}-${randomUUID()}`;
  const partial = join(snapshotsRoot, `${id}.partial`);
  const complete = join(snapshotsRoot, id);
  mkdirSync(partial, { mode: 0o700 });
  try {
    const rsync = options.rsyncExecutable ?? "/usr/bin/rsync";
    if (!isAbsolute(rsync) || !existsSync(rsync) || !statSync(rsync).isFile()) {
      throw new Error("rsync executable is unavailable");
    }
    const copy = spawnSync(rsync, [
      "-rlt",
      "--safe-links",
      "--no-devices",
      "--no-specials",
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      ...DELEGATION_MANDATORY_COPY_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
      `${sourceRoot}${sep}`,
      `${partial}${sep}`,
    ], {
      shell: false,
      encoding: "utf8",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      maxBuffer: 256 * 1024,
      timeout: 10 * 60_000,
    });
    if (copy.error || copy.status !== 0) {
      const detail = String(copy.stderr || copy.stdout || copy.error?.message || "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 1_200);
      throw new Error(`MarkSec snapshot rsync failed with status ${copy.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    const measured = measureSnapshot(partial);
    const manifest = {
      version: 1,
      createdAt,
      files: measured.files,
      bytes: measured.bytes,
      sha256: measured.sha256,
    };
    writeFileSync(join(partial, "ARGUS_SNAPSHOT.json"), JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o444,
      flag: "wx",
    });
    sealSnapshot(partial);
    renameSync(partial, complete);
    switchCurrent(cacheRoot, complete);
    try {
      pruneSnapshots(snapshotsRoot, complete);
    } catch (error) {
      console.error(`[snapshot] retention cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { snapshot: complete, ...manifest };
  } catch (error) {
    if (existsSync(partial)) rmSync(partial, { recursive: true, force: false });
    throw error;
  }
}

function measureSnapshot(root: string): { files: number; bytes: number; sha256: string } {
  const files = listTree(root).filter((entry) => entry.kind === "file");
  let bytes = 0;
  const digest = createHash("sha256");
  for (const entry of files) {
    const stat = lstatSync(entry.absolute);
    if (stat.size > SNAPSHOT_MAX_SINGLE_FILE_BYTES) throw new Error("snapshot contains an oversized file");
    bytes += stat.size;
    if (bytes > SNAPSHOT_MAX_BYTES) throw new Error("snapshot exceeds total byte limit");
    const fileDigest = createHash("sha256").update(readFileSync(entry.absolute)).digest("hex");
    digest.update(entry.relative, "utf8");
    digest.update("\0");
    digest.update(String(stat.size), "utf8");
    digest.update("\0");
    digest.update(fileDigest, "ascii");
    digest.update("\n");
  }
  return { files: files.length, bytes, sha256: digest.digest("hex") };
}

function sealSnapshot(root: string): void {
  const entries = listTree(root);
  for (const entry of entries.filter((candidate) => candidate.kind === "file")) {
    const stat = lstatSync(entry.absolute);
    if (stat.uid !== 0 || stat.gid !== 0) throw new Error("snapshot file ownership is not root:root");
    chmodSync(entry.absolute, 0o444);
  }
  for (const entry of entries.filter((candidate) => candidate.kind === "directory").reverse()) {
    const stat = lstatSync(entry.absolute);
    if (stat.uid !== 0 || stat.gid !== 0) throw new Error("snapshot directory ownership is not root:root");
    chmodSync(entry.absolute, 0o555);
  }
  const rootStat = lstatSync(root);
  if (rootStat.uid !== 0 || rootStat.gid !== 0) throw new Error("snapshot root ownership is not root:root");
  chmodSync(root, 0o555);
}

function listTree(root: string): Array<{ absolute: string; relative: string; kind: "file" | "directory" }> {
  const entries: Array<{ absolute: string; relative: string; kind: "file" | "directory" }> = [];
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      if (!within(root, absolute)) throw new Error("snapshot path escaped its root");
      if (child.isSymbolicLink()) throw new Error("snapshot contains a symbolic link");
      if (child.isDirectory()) {
        entries.push({ absolute, relative: relative(root, absolute), kind: "directory" });
        pending.push(absolute);
      } else if (child.isFile()) {
        entries.push({ absolute, relative: relative(root, absolute), kind: "file" });
      } else {
        throw new Error("snapshot contains a non-regular file");
      }
      count += 1;
      if (count > SNAPSHOT_MAX_FILES) throw new Error("snapshot exceeds file count limit");
    }
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

function switchCurrent(cacheRoot: string, complete: string): void {
  const current = join(cacheRoot, "current");
  const temporary = join(cacheRoot, `.current-${randomUUID()}`);
  const target = join("snapshots", basename(complete));
  symlinkSync(target, temporary, "dir");
  renameSync(temporary, current);
}

function pruneSnapshots(snapshotsRoot: string, current: string): void {
  const currentCanonical = realpathSync(current);
  const snapshots = readdirSync(snapshotsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^marksec-\d{14}-[a-f0-9-]{36}$/.test(entry.name))
    .map((entry) => join(snapshotsRoot, entry.name))
    .sort((left, right) => right.localeCompare(left));
  for (const stale of snapshots.slice(SNAPSHOT_RETENTION)) {
    if (realpathSync(stale) === currentCanonical || !within(snapshotsRoot, stale)) continue;
    unsealForRemoval(stale);
    rmSync(stale, { recursive: true, force: false });
  }
}

function unsealForRemoval(root: string): void {
  const entries = listTree(root);
  for (const entry of entries.filter((candidate) => candidate.kind === "file")) chmodSync(entry.absolute, 0o600);
  for (const entry of entries.filter((candidate) => candidate.kind === "directory")) chmodSync(entry.absolute, 0o700);
  chmodSync(root, 0o700);
}

function safeExistingRoot(path: string, label: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${label} must be an existing absolute path`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory() || canonical === sep || canonical === dirname(canonical)) {
    throw new Error(`${label} is unsafe`);
  }
  return canonical;
}

function safeCacheRoot(path: string, sourceRoot: string): string {
  if (!isAbsolute(path)) throw new Error("cacheRoot must be absolute");
  const lexical = resolve(path);
  if (lexical === sep || lexical === dirname(lexical) || within(sourceRoot, lexical) || within(lexical, sourceRoot)) {
    throw new Error("cacheRoot must be separate from sourceRoot");
  }
  mkdirSync(lexical, { recursive: true, mode: 0o755 });
  const canonical = realpathSync(lexical);
  if (canonical === sep || canonical === dirname(canonical)) throw new Error("cacheRoot is unsafe");
  return canonical;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
