import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MeshArtifactFileSchema,
  MeshArtifactIdSchema,
  MeshArtifactPathSchema,
  MeshBaseArtifactManifestSchema,
  MeshResultArtifactManifestSchema,
  MeshTaskIdSchema,
  meshArtifactSha256,
  type MeshArtifactFile,
  type MeshBaseArtifactManifest,
  type MeshResultArtifactManifest,
} from "@agentlink/wire";
import { configDir } from "../store";

export const MAX_ARTIFACT_FILES = 256;
export const MAX_ARTIFACT_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_MANIFEST_BYTES = 12 * 1024 * 1024;
const NO_FOLLOW_FLAG = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

const WINDOWS_AMBIGUOUS_PATH_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f<>:"|?*]/;

interface ValidatedBaseArtifact {
  manifest: MeshBaseArtifactManifest;
  contents: Map<string, Buffer>;
}

interface DirectoryIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

interface OwnedWorkspaceIdentity {
  root: DirectoryIdentity;
  taskDir: DirectoryIdentity;
  workspace: DirectoryIdentity;
}

interface WorkspaceEntryStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

interface WorkspaceEntryIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  modified: bigint;
  changed: bigint;
}

export interface MaterializedArtifactWorkspace {
  taskDir: string;
  workspace: string;
  baseArtifactId: string;
}

export interface MeshArtifactStoreCaptureHooks {
  /** Test-only fault injection proving partial base workspaces are removed. */
  afterMaterializedFileWrite?: (path: string, index: number) => void;
  /** Test-only synchronization point for deterministic replacement-race coverage. */
  beforeWorkspaceSnapshot?: (workspace: string) => void;
  /** Test-only observer proving rejected trees are never opened for content reads. */
  beforeFileRead?: (path: string) => void;
}

/**
 * Applies the wire schema and the stricter path rules required by every
 * supported filesystem. `maxBytes` is used by destinations, whose CLI path
 * budget is expressed in UTF-8 bytes rather than schema characters.
 */
export function validatePortableArtifactPath(
  value: unknown,
  label = "artifact path",
  maxBytes?: number,
): string {
  let path: string;
  try {
    path = MeshArtifactPathSchema.parse(value);
  } catch {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  if (maxBytes !== undefined && Buffer.byteLength(path, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its path size limit`);
  }
  for (const segment of path.split("/")) {
    if (WINDOWS_AMBIGUOUS_PATH_CHARACTER_PATTERN.test(segment)
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || isWindowsDeviceName(segment)) {
      throw new Error(`${label} contains an unsafe path component`);
    }
  }
  return path;
}

function isWindowsDeviceName(value: string): boolean {
  const basename = value.split(".", 1)[0].replace(/[. ]+$/g, "");
  return /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(basename);
}

export function validateBaseArtifactManifest(value: unknown): ValidatedBaseArtifact {
  const manifest = MeshBaseArtifactManifestSchema.parse(value);
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    validatePortableArtifactPath(file.path, "base artifact file path");
    if (contents.has(file.path)) throw new Error("artifact contains a duplicate path");
    const content = decodeCanonicalBase64(file.contentBase64);
    if (content.byteLength !== file.size) throw new Error("artifact file size mismatch");
    if (content.byteLength > MAX_ARTIFACT_FILE_BYTES) throw new Error("artifact file exceeds size limit");
    if (sha256Hex(content) !== file.sha256) throw new Error("artifact file hash mismatch");
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error("artifact exceeds total size limit");
    contents.set(file.path, content);
  }
  for (const path of contents.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      if (contents.has(segments.slice(0, index).join("/"))) {
        throw new Error("artifact file path conflicts with a directory");
      }
    }
  }
  const digest = meshArtifactSha256(manifest);
  if (manifest.sha256 !== digest || manifest.artifactId !== `sha256:${digest}`) {
    throw new Error("artifact manifest hash mismatch");
  }
  return { manifest, contents };
}

export function validateResultArtifactManifest(value: unknown): MeshResultArtifactManifest {
  const manifest = MeshResultArtifactManifestSchema.parse(value);
  if (manifest.changed.length + manifest.deleted.length > MAX_ARTIFACT_FILES) {
    throw new Error("artifact exceeds file count limit");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.changed) {
    validatePortableArtifactPath(file.path, "result artifact changed file path");
    if (seen.has(file.path)) throw new Error("artifact contains a duplicate path");
    seen.add(file.path);
    const content = decodeCanonicalBase64(file.contentBase64);
    if (content.byteLength !== file.size) throw new Error("artifact file size mismatch");
    if (content.byteLength > MAX_ARTIFACT_FILE_BYTES) throw new Error("artifact file exceeds size limit");
    if (sha256Hex(content) !== file.sha256) throw new Error("artifact file hash mismatch");
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error("artifact exceeds total size limit");
  }
  for (const path of manifest.deleted) {
    validatePortableArtifactPath(path, "result artifact deleted path");
    if (seen.has(path)) throw new Error("artifact contains a duplicate path");
    seen.add(path);
  }
  const digest = meshArtifactSha256(manifest);
  if (manifest.sha256 !== digest || manifest.artifactId !== `sha256:${digest}`) {
    throw new Error("artifact manifest hash mismatch");
  }
  return manifest;
}

export class MeshArtifactStore {
  private readonly root: string;
  private rootIdentity?: DirectoryIdentity;
  private readonly workspaceIdentities = new Map<string, OwnedWorkspaceIdentity>();

  constructor(
    root = join(configDir(), "mesh-workspaces"),
    private readonly captureHooks: MeshArtifactStoreCaptureHooks = {},
  ) {
    if (!isAbsolute(root)) throw new Error("artifact workspace root must be absolute");
    this.root = resolve(root);
  }

  materialize(taskIdValue: string, value: unknown): MaterializedArtifactWorkspace {
    const taskId = MeshTaskIdSchema.parse(taskIdValue);
    const { manifest, contents } = validateBaseArtifactManifest(value);
    const root = this.ensureRoot();
    const taskDir = join(root, taskId);
    if (existsSync(taskDir)) throw new Error("task artifact workspace already exists");
    mkdirSync(taskDir, { mode: 0o700 });
    const taskIdentity = directoryIdentity(taskDir);
    const workspace = join(taskDir, "workspace");
    try {
      mkdirSync(workspace, { mode: 0o700 });
      this.workspaceIdentities.set(taskId, {
        root: this.rootIdentity!,
        taskDir: taskIdentity,
        workspace: directoryIdentity(workspace),
      });
      for (const [index, file] of manifest.files.entries()) {
        const destination = joinArtifactPath(workspace, file.path);
        mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(destination, contents.get(file.path)!, { flag: "wx", mode: file.mode });
        chmodSync(destination, file.mode);
        this.captureHooks.afterMaterializedFileWrite?.(destination, index);
      }
      writeAtomicJson(join(taskDir, "base.json"), withoutArtifactContents(manifest));
      return { taskDir, workspace, baseArtifactId: manifest.artifactId };
    } catch (error) {
      this.workspaceIdentities.delete(taskId);
      assertDirectoryIdentity(root, this.rootIdentity!, "artifact workspace root");
      removeOwnedDirectory(taskDir, taskIdentity, "artifact task directory");
      throw error;
    }
  }

  /** Remove a materialized workspace when execution cannot reach capture. */
  discardWorkspace(taskIdValue: string): void {
    const taskId = MeshTaskIdSchema.parse(taskIdValue);
    const ownedIdentity = this.workspaceIdentities.get(taskId);
    if (!ownedIdentity) return;
    const root = this.ensureRoot();
    const taskDir = join(root, taskId);
    const workspace = join(taskDir, "workspace");
    assertDirectoryIdentity(root, ownedIdentity.root, "artifact workspace root");
    assertDirectoryIdentity(taskDir, ownedIdentity.taskDir, "artifact task directory");
    assertDirectoryIdentity(workspace, ownedIdentity.workspace, "artifact workspace");
    removeOwnedDirectory(taskDir, ownedIdentity.taskDir, "artifact task directory");
    this.workspaceIdentities.delete(taskId);
  }

  captureResult(
    taskIdValue: string,
    baseValue: unknown,
    workspaceValue: string,
  ): MeshResultArtifactManifest {
    const taskId = MeshTaskIdSchema.parse(taskIdValue);
    const { manifest: base } = validateBaseArtifactManifest(baseValue);
    const root = this.ensureRoot();
    const taskDir = join(root, taskId);
    const expectedWorkspace = join(taskDir, "workspace");
    const ownedIdentity = this.workspaceIdentities.get(taskId);
    if (!ownedIdentity) throw new Error("artifact workspace identity is not bound to task");
    assertDirectoryIdentity(root, ownedIdentity.root, "artifact workspace root");
    assertDirectoryIdentity(taskDir, ownedIdentity.taskDir, "artifact task directory");
    assertDirectoryIdentity(expectedWorkspace, ownedIdentity.workspace, "artifact workspace");
    if (resolve(workspaceValue) !== expectedWorkspace) throw new Error("artifact workspace does not match task");
    assertContained(root, expectedWorkspace);

    const snapshotWorkspace = join(taskDir, `.workspace-capture-${randomUUID()}`);
    let snapshotCreated = false;
    let snapshotOwned = false;
    let workspaceRetired = false;
    try {
      this.captureHooks.beforeWorkspaceSnapshot?.(expectedWorkspace);
      renameSync(expectedWorkspace, snapshotWorkspace);
      snapshotCreated = true;

      // The atomic rename pins the directory entry before any traversal. A
      // replacement is rejected before readdir or content reads.
      assertDirectoryIdentity(root, ownedIdentity.root, "artifact workspace root");
      assertDirectoryIdentity(taskDir, ownedIdentity.taskDir, "artifact task directory");
      assertMovedDirectoryIdentity(snapshotWorkspace, ownedIdentity.workspace, "artifact workspace snapshot");
      assertContained(taskDir, snapshotWorkspace);
      snapshotOwned = true;

      const current = scanWorkspace(snapshotWorkspace, this.captureHooks.beforeFileRead);
      const original = new Map(base.files.map((file) => [file.path, file]));
      const changed = [...current.values()]
        .filter((file) => {
          const before = original.get(file.path);
          return !before || before.sha256 !== file.sha256 || before.mode !== file.mode;
        })
        .sort((left, right) => compareCanonicalPath(left.path, right.path));
      const deleted = base.files
        .map((file) => file.path)
        .filter((path) => !current.has(path))
        .sort();
      const identity = {
        version: 1 as const,
        kind: "result" as const,
        baseArtifactId: base.artifactId,
        taskId,
        changed,
        deleted,
      };
      const digest = meshArtifactSha256(identity);
      const result = MeshResultArtifactManifestSchema.parse({
        ...identity,
        artifactId: `sha256:${digest}`,
        sha256: digest,
      });
      validateResultArtifactManifest(result);

      removeMovedOwnedDirectory(
        snapshotWorkspace,
        ownedIdentity.workspace,
        "artifact workspace snapshot",
      );
      snapshotOwned = false;
      workspaceRetired = true;
      writeAtomicJson(join(taskDir, "result.json"), result);
      return result;
    } catch (error) {
      if (snapshotOwned) {
        removeMovedOwnedDirectory(
          snapshotWorkspace,
          ownedIdentity.workspace,
          "artifact workspace snapshot",
        );
        workspaceRetired = true;
      } else if (!snapshotCreated) {
        assertDirectoryIdentity(expectedWorkspace, ownedIdentity.workspace, "artifact workspace");
        workspaceRetired = true;
      }
      if (workspaceRetired) {
        assertDirectoryIdentity(root, ownedIdentity.root, "artifact workspace root");
        removeOwnedDirectory(taskDir, ownedIdentity.taskDir, "artifact task directory");
      }
      throw error;
    } finally {
      this.workspaceIdentities.delete(taskId);
    }
  }

  readResult(taskIdValue: string, artifactIdValue: string): MeshResultArtifactManifest {
    const taskId = MeshTaskIdSchema.parse(taskIdValue);
    const artifactId = MeshArtifactIdSchema.parse(artifactIdValue);
    const root = this.ensureRoot();
    const file = join(root, taskId, "result.json");
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new Error("result artifact not found");
    if (statSync(file).size > MAX_RESULT_MANIFEST_BYTES) throw new Error("result artifact exceeds size limit");
    const manifest = validateResultArtifactManifest(JSON.parse(readFileSync(file, "utf8")) as unknown);
    if (manifest.taskId !== taskId || manifest.artifactId !== artifactId) {
      throw new Error("result artifact does not match task");
    }
    return manifest;
  }

  private ensureRoot(): string {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error("artifact workspace root cannot be a symlink");
    chmodSync(this.root, 0o700);
    const canonicalRoot = realpathSync(this.root);
    const current = directoryIdentity(canonicalRoot);
    if (this.rootIdentity) {
      assertSameIdentity(current, this.rootIdentity, "artifact workspace root");
    } else {
      this.rootIdentity = current;
    }
    return canonicalRoot;
  }
}

function directoryIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink()) throw new Error("artifact owned directory cannot be a symbolic link");
  if (!info.isDirectory()) throw new Error("artifact owned path is not a directory");
  return {
    canonicalPath: realpathSync(path),
    device: info.dev,
    inode: info.ino,
  };
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity, label: string): void {
  let current: DirectoryIdentity;
  try {
    current = directoryIdentity(path);
  } catch {
    throw new Error(`${label} was replaced or is not an owned directory`);
  }
  assertSameIdentity(current, expected, label);
}

function assertMovedDirectoryIdentity(path: string, expected: DirectoryIdentity, label: string): void {
  let current: DirectoryIdentity;
  try {
    current = directoryIdentity(path);
  } catch {
    throw new Error(`${label} was replaced or is not an owned directory`);
  }
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error(`${label} identity changed`);
  }
}

function removeOwnedDirectory(path: string, expected: DirectoryIdentity, label: string): void {
  assertDirectoryIdentity(path, expected, label);
  rmSync(path, { recursive: true });
  if (existsSync(path)) throw new Error(`${label} could not be removed`);
}

function removeMovedOwnedDirectory(path: string, expected: DirectoryIdentity, label: string): void {
  assertMovedDirectoryIdentity(path, expected, label);
  rmSync(path, { recursive: true });
  if (existsSync(path)) throw new Error(`${label} could not be removed`);
}

function assertSameIdentity(current: DirectoryIdentity, expected: DirectoryIdentity, label: string): void {
  if (current.canonicalPath !== expected.canonicalPath
    || current.device !== expected.device
    || current.inode !== expected.inode) {
    throw new Error(`${label} identity changed`);
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("artifact workspace escapes task-owned root");
  }
}

function scanWorkspace(
  workspace: string,
  beforeFileRead?: (path: string) => void,
): Map<string, MeshArtifactFile> {
  const files = new Map<string, MeshArtifactFile>();
  const workspaceStats = workspaceEntryStats(workspace);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error("artifact workspace root is not an owned directory");
  }
  const pending = [{ path: workspace, identity: workspaceEntryIdentity(workspaceStats) }];
  const visitedDirectories: Array<{ path: string; identity: WorkspaceEntryIdentity }> = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    assertWorkspaceEntryIdentity(directory.path, directory.identity, "artifact workspace directory", "directory");
    visitedDirectories.push(directory);
    const entries = readdirSync(directory.path, { withFileTypes: true });
    assertWorkspaceEntryIdentity(directory.path, directory.identity, "artifact workspace directory", "directory");
    for (const entry of entries) {
      const absolute = join(directory.path, entry.name);
      const info = workspaceEntryStats(absolute);
      if (info.isSymbolicLink()) throw new Error("artifact workspace contains a symbolic link");
      if (info.isDirectory()) {
        pending.push({ path: absolute, identity: workspaceEntryIdentity(info) });
        continue;
      }
      if (!info.isFile()) throw new Error("artifact workspace contains a non-regular file");
      if (files.size >= MAX_ARTIFACT_FILES) throw new Error("artifact exceeds file count limit");
      if (info.size > BigInt(MAX_ARTIFACT_FILE_BYTES)) throw new Error("artifact file exceeds size limit");
      totalBytes += Number(info.size);
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error("artifact exceeds total size limit");
      const path = relative(workspace, absolute).split(sep).join("/");
      validatePortableArtifactPath(path, "artifact workspace file path");
      if (files.has(path)) throw new Error("artifact contains a duplicate path");
      beforeFileRead?.(absolute);
      const content = readWorkspaceFile(absolute, workspaceEntryIdentity(info));
      files.set(path, MeshArtifactFileSchema.parse({
        type: "file",
        path,
        mode: Number(info.mode & 0o777n),
        size: content.byteLength,
        sha256: sha256Hex(content),
        contentBase64: content.toString("base64"),
      }));
    }
  }
  for (const directory of visitedDirectories) {
    assertWorkspaceEntryIdentity(directory.path, directory.identity, "artifact workspace directory", "directory");
  }
  return files;
}

function workspaceEntryStats(path: string): WorkspaceEntryStats {
  return lstatSync(path, { bigint: true }) as unknown as WorkspaceEntryStats;
}

function workspaceEntryIdentity(info: WorkspaceEntryStats): WorkspaceEntryIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mode: info.mode,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
  };
}

function sameWorkspaceEntry(left: WorkspaceEntryIdentity, right: WorkspaceEntryIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.modified === right.modified
    && left.changed === right.changed;
}

function assertWorkspaceEntryIdentity(
  path: string,
  expected: WorkspaceEntryIdentity,
  label: string,
  kind: "directory" | "file",
): void {
  let current: WorkspaceEntryStats;
  try {
    current = workspaceEntryStats(path);
  } catch {
    throw new Error(`${label} changed or is unreadable`);
  }
  const kindMatches = kind === "directory" ? current.isDirectory() : current.isFile();
  if (current.isSymbolicLink() || !kindMatches
    || !sameWorkspaceEntry(expected, workspaceEntryIdentity(current))) {
    throw new Error(`${label} changed or is unreadable`);
  }
}

function readWorkspaceFile(path: string, expected: WorkspaceEntryIdentity): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
    const opened = fstatSync(descriptor, { bigint: true }) as unknown as WorkspaceEntryStats;
    if (!opened.isFile() || opened.isSymbolicLink()
      || !sameWorkspaceEntry(expected, workspaceEntryIdentity(opened))) {
      throw new Error("artifact workspace file changed or is unreadable");
    }
    const content = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < content.byteLength) {
      const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
      if (count <= 0) throw new Error("artifact workspace file changed or is unreadable");
      offset += count;
    }
    verifyDescriptorContent(descriptor, content);
    const afterDescriptor = fstatSync(descriptor, { bigint: true }) as unknown as WorkspaceEntryStats;
    if (!afterDescriptor.isFile()
      || !sameWorkspaceEntry(expected, workspaceEntryIdentity(afterDescriptor))) {
      throw new Error("artifact workspace file changed or is unreadable");
    }
    assertWorkspaceEntryIdentity(path, expected, "artifact workspace file", "file");
    return content;
  } catch {
    throw new Error("artifact workspace file changed or is unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifyDescriptorContent(descriptor: number, expected: Buffer): void {
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, expected.byteLength)));
  let offset = 0;
  while (offset < expected.byteLength) {
    const requested = Math.min(chunk.byteLength, expected.byteLength - offset);
    const count = readSync(descriptor, chunk, 0, requested, offset);
    if (count !== requested || !chunk.subarray(0, count).equals(expected.subarray(offset, offset + count))) {
      throw new Error("artifact workspace file changed or is unreadable");
    }
    offset += count;
  }
}

function joinArtifactPath(root: string, path: string): string {
  validatePortableArtifactPath(path);
  const candidate = resolve(root, ...path.split("/"));
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("artifact path escapes workspace");
  }
  return candidate;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("artifact content is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("artifact content is not canonical base64");
  return decoded;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCanonicalPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withoutArtifactContents(manifest: MeshBaseArtifactManifest): Record<string, unknown> {
  return {
    version: manifest.version,
    kind: manifest.kind,
    artifactId: manifest.artifactId,
    sha256: manifest.sha256,
    files: manifest.files.map(({ contentBase64: _content, ...file }) => file),
  };
}

function writeAtomicJson(path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_RESULT_MANIFEST_BYTES) {
    throw new Error("artifact manifest exceeds size limit");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
