import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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

export interface MaterializedArtifactWorkspace {
  taskDir: string;
  workspace: string;
  baseArtifactId: string;
}

export function validateBaseArtifactManifest(value: unknown): ValidatedBaseArtifact {
  const manifest = MeshBaseArtifactManifestSchema.parse(value);
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (contents.has(file.path)) throw new Error("artifact contains a duplicate path");
    const content = decodeCanonicalBase64(file.contentBase64);
    if (content.byteLength !== file.size) throw new Error("artifact file size mismatch");
    if (content.byteLength > MAX_ARTIFACT_FILE_BYTES) throw new Error("artifact file exceeds size limit");
    if (sha256Hex(content) !== file.sha256) throw new Error("artifact file hash mismatch");
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error("artifact exceeds total size limit");
    contents.set(file.path, content);
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

  constructor(root = join(configDir(), "mesh-workspaces")) {
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
    const workspace = join(taskDir, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    this.workspaceIdentities.set(taskId, {
      root: this.rootIdentity!,
      taskDir: directoryIdentity(taskDir),
      workspace: directoryIdentity(workspace),
    });
    try {
      for (const file of manifest.files) {
        const destination = joinArtifactPath(workspace, file.path);
        mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(destination, contents.get(file.path)!, { flag: "wx", mode: file.mode });
        chmodSync(destination, file.mode);
      }
      writeAtomicJson(join(taskDir, "base.json"), withoutArtifactContents(manifest));
      return { taskDir, workspace, baseArtifactId: manifest.artifactId };
    } catch (error) {
      // Keep a failed task directory as a replay tombstone. A retry with the
      // same task id must not merge into a partially materialized workspace.
      throw error;
    }
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

    const current = scanWorkspace(expectedWorkspace);
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
    writeAtomicJson(join(taskDir, "result.json"), result);
    return result;
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

function scanWorkspace(workspace: string): Map<string, MeshArtifactFile> {
  const files = new Map<string, MeshArtifactFile>();
  const pending = [workspace];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error("artifact workspace contains a symbolic link");
      if (info.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error("artifact workspace contains a non-regular file");
      if (files.size >= MAX_ARTIFACT_FILES) throw new Error("artifact exceeds file count limit");
      if (info.size > MAX_ARTIFACT_FILE_BYTES) throw new Error("artifact file exceeds size limit");
      totalBytes += info.size;
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error("artifact exceeds total size limit");
      const path = relative(workspace, absolute).split(sep).join("/");
      MeshArtifactPathSchema.parse(path);
      if (files.has(path)) throw new Error("artifact contains a duplicate path");
      const content = readFileSync(absolute);
      files.set(path, MeshArtifactFileSchema.parse({
        type: "file",
        path,
        mode: info.mode & 0o777,
        size: content.byteLength,
        sha256: sha256Hex(content),
        contentBase64: content.toString("base64"),
      }));
    }
  }
  return files;
}

function joinArtifactPath(root: string, path: string): string {
  MeshArtifactPathSchema.parse(path);
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
