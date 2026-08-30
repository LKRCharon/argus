import { createHash } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MeshTaskIdSchema,
  type MeshArtifactFile,
  type MeshBaseArtifactManifest,
  type MeshResultArtifactManifest,
} from "@agentlink/wire";
import {
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_TOTAL_BYTES,
  validatePortableArtifactPath,
  validateBaseArtifactManifest,
  validateResultArtifactManifest,
} from "./artifact-store";

const MAX_DESTINATION_PATH_BYTES = 512;
const NO_FOLLOW_FLAG = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
const DARWIN_RENAME_EXCL = 0x0004;
const DARWIN_RENAME_NOFOLLOW_ANY = 0x0010;
const LINUX_RENAME_NOREPLACE = 0x0001;
const WINDOWS_MOVEFILE_WRITE_THROUGH = 0x0008;

export interface MeshResultArtifactMaterializationRequest {
  materializationRoot: string;
  /** A safe relative POSIX path whose parent already exists below the root. */
  destination: string;
  baseArtifact: MeshBaseArtifactManifest;
  resultArtifact: MeshResultArtifactManifest;
  expectedTaskId?: string;
}

export interface MeshResultArtifactMaterializationSummary {
  taskId: string;
  baseArtifactId: string;
  resultArtifactId: string;
  destination: string;
  fileCount: number;
  totalBytes: number;
  changedCount: number;
  deletedCount: number;
}

/** Test-only synchronization used to prove partial staging is cleaned. */
export interface MeshResultArtifactMaterializationHooks {
  afterFileWrite?: (path: string, index: number, stagingPath: string) => void;
  /** Test-only hook called after all output descriptors are closed. */
  afterOutputDescriptorsClosed?: (context: {
    stagingPath: string;
    destination: string;
    closedOutputDescriptors: readonly number[];
  }) => void;
  /** Test-only hook called after all output descriptors are closed. */
  beforePublish?: (context: {
    stagingPath: string;
    destination: string;
    closedOutputDescriptors: readonly number[];
  }) => void;
}

interface DirectoryIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

interface MaterializedFile {
  file: MeshArtifactFile;
  content: Buffer;
}

interface OwnedOutputFile {
  descriptor: number;
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: number;
}

interface OutputFileMetadata {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: number;
}

interface MaterializedTree {
  files: Map<string, MaterializedFile>;
  orderedFiles: MaterializedFile[];
  directories: Set<string>;
  totalBytes: number;
}

export function materializeMeshResultArtifact(
  request: MeshResultArtifactMaterializationRequest,
  hooks: MeshResultArtifactMaterializationHooks = {},
): MeshResultArtifactMaterializationSummary {
  const base = validateBaseArtifactManifest(request.baseArtifact);
  const result = validateResultArtifactManifest(request.resultArtifact);
  if (result.baseArtifactId !== base.manifest.artifactId) {
    throw new Error("result artifact baseArtifactId does not match base artifact");
  }

  const expectedTaskId = request.expectedTaskId === undefined
    ? undefined
    : MeshTaskIdSchema.parse(request.expectedTaskId);
  if (expectedTaskId !== undefined && result.taskId !== expectedTaskId) {
    throw new Error("result artifact taskId does not match expected task");
  }

  const tree = reconstructTree(base.manifest, base.contents, result);
  const rootPath = validateMaterializationRoot(request.materializationRoot);
  const destinationName = validateDestinationName(request.destination);
  const destination = join(rootPath, ...destinationName.split("/"));
  assertContained(rootPath, destination, "materialization destination");

  const destinationParent = join(rootPath, ...destinationName.split("/").slice(0, -1));
  const rootIdentity = directoryIdentity(rootPath, "materialization root");
  const parentIdentity = directoryIdentity(destinationParent, "destination parent");
  assertDestinationAbsent(destination);

  const stagingPath = mkdtempSync(join(destinationParent, ".argus-materialize-"));
  let stagingIdentity: DirectoryIdentity | undefined;
  let outputFiles = new Map<string, OwnedOutputFile>();
  let published = false;
  try {
    stagingIdentity = directoryIdentity(stagingPath, "materialization staging");
    assertContained(rootPath, stagingPath, "materialization staging");
    assertDirectoryIdentity(rootPath, rootIdentity, "materialization root");
    assertDirectoryIdentity(destinationParent, parentIdentity, "destination parent");
    outputFiles = writeTree(stagingPath, stagingIdentity, tree.orderedFiles, hooks);
    assertDirectoryIdentity(rootPath, rootIdentity, "materialization root");
    assertDirectoryIdentity(destinationParent, parentIdentity, "destination parent");
    assertDirectoryIdentity(stagingPath, stagingIdentity, "materialization staging");
    verifyTree(stagingPath, tree, outputFiles);

    const outputMetadata = snapshotOutputMetadata(outputFiles);
    const closedOutputDescriptors = closeOutputFiles(outputFiles, true);
    hooks.afterOutputDescriptorsClosed?.({ stagingPath, destination, closedOutputDescriptors });
    verifyTreeDescriptorFree(stagingPath, tree, outputMetadata);

    assertDirectoryIdentity(rootPath, rootIdentity, "materialization root");
    assertDirectoryIdentity(destinationParent, parentIdentity, "destination parent");
    assertDirectoryIdentity(stagingPath, stagingIdentity, "materialization staging");
    assertContained(rootPath, stagingPath, "materialization staging");
    assertDestinationAbsent(destination);
    hooks.beforePublish?.({ stagingPath, destination, closedOutputDescriptors });

    publishDirectoryNoReplace(stagingPath, destination, destinationParent, parentIdentity, stagingIdentity);
    published = true;
    return {
      taskId: result.taskId,
      baseArtifactId: base.manifest.artifactId,
      resultArtifactId: result.artifactId,
      destination,
      fileCount: tree.files.size,
      totalBytes: tree.totalBytes,
      changedCount: result.changed.length,
      deletedCount: result.deleted.length,
    };
  } finally {
    closeOutputFiles(outputFiles);
    if (!published && stagingIdentity) {
      cleanupOwnedStaging(
        rootPath,
        rootIdentity,
        destinationParent,
        parentIdentity,
        stagingPath,
        stagingIdentity,
      );
    }
  }
}

function reconstructTree(
  base: MeshBaseArtifactManifest,
  baseContents: Map<string, Buffer>,
  result: MeshResultArtifactManifest,
): MaterializedTree {
  for (const file of base.files) {
    validatePortableArtifactPath(file.path, "base artifact file path");
  }
  for (const file of result.changed) {
    validatePortableArtifactPath(file.path, "result artifact changed file path");
  }
  for (const path of result.deleted) {
    validatePortableArtifactPath(path, "result artifact deleted path");
  }

  const baseFiles = new Map(base.files.map((file) => [file.path, file]));
  const changedPaths = new Set<string>();
  for (const file of result.changed) {
    if (changedPaths.has(file.path)) throw new Error("result artifact contains a duplicate changed path");
    changedPaths.add(file.path);
  }

  const deletedPaths = new Set<string>();
  for (const path of result.deleted) {
    if (deletedPaths.has(path)) throw new Error("result artifact contains a duplicate deleted path");
    if (changedPaths.has(path)) throw new Error("result artifact changed and deleted paths overlap");
    if (!baseFiles.has(path)) throw new Error("result artifact deletes a path absent from base artifact");
    deletedPaths.add(path);
  }

  const files = new Map<string, MaterializedFile>();
  for (const file of base.files) {
    if (deletedPaths.has(file.path)) continue;
    const content = baseContents.get(file.path);
    if (!content) throw new Error("base artifact content is incomplete");
    files.set(file.path, { file, content: Buffer.from(content) });
  }
  for (const file of result.changed) {
    files.set(file.path, {
      file,
      content: Buffer.from(file.contentBase64, "base64"),
    });
  }

  let totalBytes = 0;
  const directories = new Set<string>();
  for (const path of files.keys()) {
    validatePortableArtifactPath(path, "reconstructed artifact file path");
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join("/");
      directories.add(parent);
      if (files.has(parent)) throw new Error("artifact file path conflicts with a directory");
    }
  }
  if (files.size > MAX_ARTIFACT_FILES) throw new Error("reconstructed artifact exceeds file count limit");
  for (const { file, content } of files.values()) {
    if (content.byteLength !== file.size || content.byteLength > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error("reconstructed artifact file size is invalid");
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new Error("reconstructed artifact exceeds total size limit");
    }
  }

  return {
    files,
    orderedFiles: [...files.values()].sort((left, right) => comparePaths(left.file.path, right.file.path)),
    directories,
    totalBytes,
  };
}

function validateMaterializationRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("materialization root must be an absolute path");
  }
  const root = resolve(value);
  assertNoSymlinkComponents(root, "materialization root");
  const info = lstatSync(root);
  if (info.isSymbolicLink()) throw new Error("materialization root cannot be a symbolic link");
  if (!info.isDirectory()) throw new Error("materialization root must be a directory");
  const canonicalRoot = realpathSync(root);
  assertNoSymlinkComponents(canonicalRoot, "materialization root");
  return canonicalRoot;
}

function validateDestinationName(value: unknown): string {
  return validatePortableArtifactPath(value, "destination", MAX_DESTINATION_PATH_BYTES);
}

function directoryIdentity(path: string, label: string): DirectoryIdentity {
  assertNoSymlinkComponents(path, label);
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  return {
    canonicalPath: realpathSync(path),
    device: info.dev,
    inode: info.ino,
  };
}

function assertNoSymlinkComponents(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const components: string[] = [];
  let current = resolve(path);
  for (;;) {
    components.push(current);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  for (const component of components.reverse()) {
    const info = lstatSync(component);
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (!info.isDirectory()) throw new Error(`${label} contains a non-directory path component`);
  }
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity, label: string): void {
  let current: DirectoryIdentity;
  try {
    current = directoryIdentity(path, label);
  } catch {
    throw new Error(`${label} identity changed or is not an owned directory`);
  }
  if (current.canonicalPath !== expected.canonicalPath
    || current.device !== expected.device
    || current.inode !== expected.inode) {
    throw new Error(`${label} identity changed`);
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes materialization root`);
  }
}

function assertDestinationAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  throw new Error("materialization destination already exists");
}

function writeTree(
  staging: string,
  stagingIdentity: DirectoryIdentity,
  files: MaterializedFile[],
  hooks: MeshResultArtifactMaterializationHooks,
): Map<string, OwnedOutputFile> {
  const outputFiles = new Map<string, OwnedOutputFile>();
  try {
    files.forEach(({ file, content }, index) => {
      assertDirectoryIdentity(staging, stagingIdentity, "materialization staging");
      const path = join(staging, ...file.path.split("/"));
      ensureDirectoryChain(staging, file.path.split("/").slice(0, -1));
      let descriptor: number | undefined;
      try {
        descriptor = openSync(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
          file.mode,
        );
        writeFileSync(descriptor, content);
        fchmodSync(descriptor, file.mode);
        fsyncSync(descriptor);
        const info = fstatSync(descriptor, { bigint: true });
        const written = readDescriptor(descriptor, info.size);
        if (!info.isFile()
          || info.size !== BigInt(file.size)
          || Number(info.mode & 0o777n) !== file.mode
          || sha256Hex(written) !== file.sha256
          || !written.equals(content)) {
          throw new Error("materialized file verification failed");
        }
        outputFiles.set(file.path, {
          descriptor,
          device: info.dev,
          inode: info.ino,
          size: info.size,
          mode: Number(info.mode & 0o777n),
        });
        descriptor = undefined;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
      hooks.afterFileWrite?.(file.path, index, staging);
    });
    return outputFiles;
  } catch (error) {
    closeOutputFiles(outputFiles);
    throw error;
  }
}

function ensureDirectoryChain(root: string, segments: string[]): void {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
      }
      info = lstatSync(current);
    }
    if (info.isSymbolicLink()) throw new Error("materialization path contains a symbolic link");
    if (!info.isDirectory()) throw new Error("materialization path component is not a directory");
  }
}

function verifyTree(
  staging: string,
  expected: MaterializedTree,
  outputFiles: Map<string, OwnedOutputFile>,
): void {
  const observed = new Set<string>();
  const pending = [staging];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const info = lstatSync(absolute, { bigint: true });
      if (info.isSymbolicLink()) throw new Error("materialized tree contains a symbolic link");
      if (info.isDirectory()) {
        const path = relative(staging, absolute).split(sep).join("/");
        validatePortableArtifactPath(path, "materialized tree directory path");
        if (!expected.directories.has(path)) throw new Error("materialized tree contains an unexpected directory");
        pending.push(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error("materialized tree contains a non-regular file");
      if (info.size > BigInt(MAX_ARTIFACT_FILE_BYTES)) {
        throw new Error("materialized file exceeds size limit");
      }
      totalBytes += Number(info.size);
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        throw new Error("materialized tree exceeds total size limit");
      }
      const path = relative(staging, absolute).split(sep).join("/");
      validatePortableArtifactPath(path, "materialized tree file path");
      const expectedFile = expected.files.get(path);
      const ownedFile = outputFiles.get(path);
      if (!expectedFile || !ownedFile) throw new Error("materialized tree contains an unexpected file");
      if (info.dev !== ownedFile.device
        || info.ino !== ownedFile.inode
        || info.size !== BigInt(expectedFile.file.size)
        || Number(info.mode & 0o777n) !== expectedFile.file.mode) {
        throw new Error("materialized file identity or metadata changed");
      }
      const content = readDescriptor(ownedFile.descriptor, info.size);
      const after = fstatSync(ownedFile.descriptor, { bigint: true });
      if (after.dev !== info.dev
        || after.ino !== info.ino
        || after.size !== info.size
        || sha256Hex(content) !== expectedFile.file.sha256
        || !content.equals(expectedFile.content)) {
        throw new Error("materialized file content changed");
      }
      observed.add(path);
    }
  }
  if (observed.size !== expected.files.size || totalBytes !== expected.totalBytes) {
    throw new Error("materialized tree does not match reconstructed artifact");
  }
}

function snapshotOutputMetadata(outputFiles: Map<string, OwnedOutputFile>): Map<string, OutputFileMetadata> {
  return new Map([...outputFiles].map(([path, output]) => [path, {
    device: output.device,
    inode: output.inode,
    size: output.size,
    mode: output.mode,
  }]));
}

function verifyTreeDescriptorFree(
  staging: string,
  expected: MaterializedTree,
  outputMetadata: Map<string, OutputFileMetadata>,
): void {
  const observed = new Set<string>();
  const pending = [staging];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const info = lstatSync(absolute, { bigint: true });
      if (info.isSymbolicLink()) throw new Error("materialized tree contains a symbolic link");
      if (info.isDirectory()) {
        const path = relative(staging, absolute).split(sep).join("/");
        validatePortableArtifactPath(path, "materialized tree directory path");
        if (!expected.directories.has(path)) throw new Error("materialized tree contains an unexpected directory");
        pending.push(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error("materialized tree contains a non-regular file");
      if (info.size > BigInt(MAX_ARTIFACT_FILE_BYTES)) {
        throw new Error("materialized file exceeds size limit");
      }
      totalBytes += Number(info.size);
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        throw new Error("materialized tree exceeds total size limit");
      }
      const path = relative(staging, absolute).split(sep).join("/");
      validatePortableArtifactPath(path, "materialized tree file path");
      const expectedFile = expected.files.get(path);
      const metadata = outputMetadata.get(path);
      if (!expectedFile || !metadata) throw new Error("materialized tree contains an unexpected file");
      if (info.dev !== metadata.device
        || info.ino !== metadata.inode
        || info.size !== metadata.size
        || Number(info.mode & 0o777n) !== metadata.mode) {
        throw new Error("materialized file identity or metadata changed");
      }
      verifyDescriptorFreeFile(absolute, info, expectedFile, metadata);
      observed.add(path);
    }
  }
  if (observed.size !== expected.files.size || totalBytes !== expected.totalBytes) {
    throw new Error("materialized tree does not match reconstructed artifact");
  }
}

function verifyDescriptorFreeFile(
  path: string,
  pathInfo: {
    isFile(): boolean;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mode: bigint;
  },
  expected: MaterializedFile,
  metadata: OutputFileMetadata,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
    const descriptorInfo = fstatSync(descriptor, { bigint: true });
    if (!descriptorInfo.isFile()
      || descriptorInfo.dev !== pathInfo.dev
      || descriptorInfo.ino !== pathInfo.ino
      || descriptorInfo.dev !== metadata.device
      || descriptorInfo.ino !== metadata.inode
      || descriptorInfo.size !== pathInfo.size
      || descriptorInfo.size !== metadata.size
      || Number(descriptorInfo.mode & 0o777n) !== Number(pathInfo.mode & 0o777n)
      || Number(descriptorInfo.mode & 0o777n) !== metadata.mode) {
      throw new Error("materialized file identity or metadata changed");
    }
    const content = readDescriptor(descriptor, descriptorInfo.size);
    const after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile()
      || after.dev !== descriptorInfo.dev
      || after.ino !== descriptorInfo.ino
      || after.size !== descriptorInfo.size
      || Number(after.mode & 0o777n) !== Number(descriptorInfo.mode & 0o777n)
      || sha256Hex(content) !== expected.file.sha256
      || !content.equals(expected.content)) {
      throw new Error("materialized file content changed");
    }
  } finally {
    if (descriptor !== undefined) {
      const descriptorToClose = descriptor;
      descriptor = undefined;
      closeSync(descriptorToClose);
    }
  }
}

function cleanupOwnedStaging(
  root: string,
  rootIdentity: DirectoryIdentity,
  parent: string,
  parentIdentity: DirectoryIdentity,
  staging: string,
  stagingIdentity: DirectoryIdentity,
): void {
  try {
    assertDirectoryIdentity(root, rootIdentity, "materialization root");
    assertDirectoryIdentity(parent, parentIdentity, "destination parent");
    assertDirectoryIdentity(staging, stagingIdentity, "materialization staging");
    rmSync(staging, { recursive: true, force: true });
  } catch {
    // If an owned path was replaced, leaving it untouched is safer than
    // recursively removing a path that may now refer to another tree.
  }
}

function publishDirectoryNoReplace(
  staging: string,
  destination: string,
  destinationParent: string,
  parentIdentity: DirectoryIdentity,
  stagingIdentity: DirectoryIdentity,
): void {
  if (parentIdentity.device !== stagingIdentity.device) {
    throw new Error("materialization staging and destination must share a filesystem");
  }
  const stagingName = basename(staging);
  const destinationName = basename(destination);
  if (dirname(staging) !== destinationParent || dirname(destination) !== destinationParent) {
    throw new Error("materialization publication paths must share a parent");
  }
  if (process.platform === "darwin") {
    publishUnixDirectoryNoReplace(
      loadDarwinRenameatx(),
      destinationParent,
      parentIdentity,
      stagingName,
      destinationName,
      DARWIN_RENAME_EXCL | DARWIN_RENAME_NOFOLLOW_ANY,
      destination,
    );
    return;
  }
  if (process.platform === "linux") {
    publishUnixDirectoryNoReplace(
      loadLinuxRenameat2(),
      destinationParent,
      parentIdentity,
      stagingName,
      destinationName,
      LINUX_RENAME_NOREPLACE,
      destination,
    );
    return;
  }
  if (process.platform === "win32") {
    const moveFileEx = loadWindowsMoveFileEx();
    // MOVEFILE_REPLACE_EXISTING is intentionally omitted: an existing target
    // must make the OS move fail.
    if (moveFileEx(windowsPath(staging), windowsPath(destination), WINDOWS_MOVEFILE_WRITE_THROUGH) === 0) {
      throwAtomicPublicationError(destination);
    }
    return;
  }
  throw new Error("atomic directory publication is unsupported on this platform");
}

function publishUnixDirectoryNoReplace(
  renameFunction: UnixRenameFunction,
  destinationParent: string,
  parentIdentity: DirectoryIdentity,
  stagingName: string,
  destinationName: string,
  flags: number,
  destination: string,
): void {
  let parentDescriptor: number | undefined;
  try {
    parentDescriptor = openSync(destinationParent, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
    const parent = fstatSync(parentDescriptor, { bigint: true });
    if (!parent.isDirectory() || parent.dev !== parentIdentity.device || parent.ino !== parentIdentity.inode) {
      throw new Error("materialization destination parent identity changed");
    }
    if (renameFunction(
      parentDescriptor,
      nativePath(stagingName),
      parentDescriptor,
      nativePath(destinationName),
      flags,
    ) !== 0) {
      throwAtomicPublicationError(destination);
    }
  } finally {
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
}

type UnixRenameFunction = (
  fromDirFd: number,
  from: Uint8Array,
  toDirFd: number,
  to: Uint8Array,
  flags: number,
) => number;

type WindowsMoveFileFunction = (from: Uint16Array, to: Uint16Array, flags: number) => number;

let darwinRenameatx: UnixRenameFunction | undefined;
let darwinLibrary: { close: () => void } | undefined;
let linuxRenameat2: UnixRenameFunction | undefined;
let linuxLibrary: { close: () => void } | undefined;
let windowsMoveFileEx: WindowsMoveFileFunction | undefined;
let windowsLibrary: { close: () => void } | undefined;
let nativePublicationUnavailable = false;

function loadDarwinRenameatx(): UnixRenameFunction {
  if (darwinRenameatx) return darwinRenameatx;
  if (nativePublicationUnavailable) throw new Error("atomic directory publication is unsupported on this platform");
  try {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renameatx_np: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    const renameatx = library.symbols.renameatx_np;
    darwinLibrary = library;
    darwinRenameatx = renameatx;
    return renameatx;
  } catch {
    nativePublicationUnavailable = true;
    throw new Error("atomic directory publication is unsupported on this platform");
  }
}

function loadLinuxRenameat2(): UnixRenameFunction {
  if (linuxRenameat2) return linuxRenameat2;
  if (nativePublicationUnavailable) throw new Error("atomic directory publication is unsupported on this platform");
  for (const libraryName of ["libc.so.6", "libc.so"]) {
    try {
      const library = dlopen(libraryName, {
        renameat2: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
      });
      const renameat2 = library.symbols.renameat2;
      linuxLibrary = library;
      linuxRenameat2 = renameat2;
      return renameat2;
    } catch {
      // Try the next libc name, then fail closed below.
    }
  }
  nativePublicationUnavailable = true;
  throw new Error("atomic directory publication is unsupported on this platform");
}

function loadWindowsMoveFileEx(): WindowsMoveFileFunction {
  if (windowsMoveFileEx) return windowsMoveFileEx;
  if (nativePublicationUnavailable) throw new Error("atomic directory publication is unsupported on this platform");
  try {
    const library = dlopen("kernel32.dll", {
      MoveFileExW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    windowsLibrary = library;
    windowsMoveFileEx = library.symbols.MoveFileExW;
    return windowsMoveFileEx;
  } catch {
    nativePublicationUnavailable = true;
    throw new Error("atomic directory publication is unsupported on this platform");
  }
}

function windowsPath(path: string): Uint16Array {
  const value = new Uint16Array(path.length + 1);
  for (let index = 0; index < path.length; index++) value[index] = path.charCodeAt(index);
  return value;
}

function nativePath(path: string): Uint8Array {
  return Buffer.from(`${path}\0`, "utf8");
}

function throwAtomicPublicationError(destination: string): never {
  try {
    lstatSync(destination);
    throw new Error("materialization destination already exists");
  } catch (error) {
    if (error instanceof Error && error.message === "materialization destination already exists") throw error;
    if (isMissingPathError(error)) throw new Error("atomic directory publication failed");
    throw new Error("atomic directory publication failed");
  }
}

function closeOutputFiles(outputFiles: Map<string, OwnedOutputFile>, failOnError = false): number[] {
  const descriptors = [...outputFiles.values()].map(({ descriptor }) => descriptor);
  let closeFailed = false;
  for (const { descriptor } of outputFiles.values()) {
    try {
      closeSync(descriptor);
    } catch {
      closeFailed = true;
      // Cleanup errors must not mask the original materialization failure.
    }
  }
  outputFiles.clear();
  if (closeFailed && failOnError) throw new Error("materialized output descriptors could not be closed");
  return descriptors;
}

function readDescriptor(descriptor: number, size: bigint): Buffer {
  if (size > BigInt(MAX_ARTIFACT_FILE_BYTES)) throw new Error("materialized file exceeds size limit");
  const content = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < content.byteLength) {
    const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
    if (count <= 0) throw new Error("materialized file read ended early");
    offset += count;
  }
  return content;
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
