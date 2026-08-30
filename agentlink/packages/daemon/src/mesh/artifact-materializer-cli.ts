import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { MeshBaseArtifactManifest, MeshResultArtifactManifest } from "@agentlink/wire";
import {
  materializeMeshResultArtifact,
  type MeshResultArtifactMaterializationSummary,
} from "./artifact-materializer";

export const MAX_MANIFEST_JSON_BYTES = 12 * 1024 * 1024;
const MAX_CLI_ERROR_BYTES = 512;
const MAX_CLI_OUTPUT_BYTES = 64 * 1024;
const FLAGS = new Set(["--base", "--result", "--root", "--destination", "--task-id"]);
const NO_FOLLOW_FLAG = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export interface ArtifactMaterializerCliArguments {
  baseFile: string;
  resultFile: string;
  materializationRoot: string;
  destination: string;
  expectedTaskId?: string;
}

export interface ArtifactMaterializerCliHooks {
  /** Test-only synchronization point between the first read and final checks. */
  afterManifestRead?: (path: string, label: string) => void;
}

class ManifestInputError extends Error {}

class ManifestInputChangedError extends ManifestInputError {}

export function parseArtifactMaterializerArguments(argv: string[]): ArtifactMaterializerCliArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!FLAGS.has(flag)) throw new Error("unknown flag");
    if (values.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    values.set(flag, value);
    index++;
  }

  for (const flag of ["--base", "--result", "--root", "--destination"]) {
    if (!values.has(flag)) throw new Error(`missing required flag: ${flag}`);
  }
  return {
    baseFile: values.get("--base")!,
    resultFile: values.get("--result")!,
    materializationRoot: values.get("--root")!,
    destination: values.get("--destination")!,
    expectedTaskId: values.get("--task-id"),
  };
}

interface ManifestFileFingerprint {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  modified: bigint;
  changed: bigint;
}

interface ManifestFileStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

export function readManifestJson(
  path: string,
  label: string,
  hooks: ArtifactMaterializerCliHooks = {},
): unknown {
  let descriptor: number | undefined;
  let content: Buffer;
  try {
    const stat = lstatSync(path, { bigint: true }) as unknown as ManifestFileStats;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ManifestInputError(`${label} must be a regular file`);
    if (stat.size > BigInt(MAX_MANIFEST_JSON_BYTES)) throw new ManifestInputError(`${label} exceeds its size limit`);
    const initial = manifestFileFingerprint(stat);
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || !sameManifestFile(initial, manifestFileFingerprint(opened as unknown as ManifestFileStats))
      || opened.size > BigInt(MAX_MANIFEST_JSON_BYTES)) {
      throw new ManifestInputChangedError(`${label} changed while it was being read`);
    }
    content = readDescriptor(descriptor, opened.size, label);
    hooks.afterManifestRead?.(path, label);
    verifyDescriptorContent(descriptor, content, label);
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!afterDescriptor.isFile()
      || !sameManifestFile(initial, manifestFileFingerprint(afterDescriptor as unknown as ManifestFileStats))
      || !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameManifestFile(initial, manifestFileFingerprint(afterPath as unknown as ManifestFileStats))) {
      throw new ManifestInputChangedError(`${label} changed while it was being read`);
    }
  } catch (error) {
    if (error instanceof ManifestInputError) throw error;
    throw new ManifestInputError(`${label} is unreadable`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function manifestFileFingerprint(info: ManifestFileStats): ManifestFileFingerprint {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mode: info.mode & 0o777n,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
  };
}

function sameManifestFile(left: ManifestFileFingerprint, right: ManifestFileFingerprint): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.modified === right.modified
    && left.changed === right.changed;
}

function readDescriptor(descriptor: number, size: bigint, label: string): Buffer {
  if (size > BigInt(MAX_MANIFEST_JSON_BYTES)) throw new Error(`${label} exceeds its size limit`);
  const content = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < content.byteLength) {
    const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
    if (count <= 0) throw new Error(`${label} ended before its declared size`);
    offset += count;
  }
  return content;
}

function verifyDescriptorContent(descriptor: number, expected: Buffer, label: string): void {
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, expected.byteLength)));
  let offset = 0;
  while (offset < expected.byteLength) {
    const requested = Math.min(chunk.byteLength, expected.byteLength - offset);
    const count = readSync(descriptor, chunk, 0, requested, offset);
    if (count <= 0 || !chunk.subarray(0, count).equals(expected.subarray(offset, offset + count))) {
      throw new ManifestInputChangedError(`${label} changed while it was being read`);
    }
    offset += count;
  }
}

export function runArtifactMaterializerCli(
  argv: string[],
  hooks: ArtifactMaterializerCliHooks = {},
): MeshResultArtifactMaterializationSummary {
  const args = parseArtifactMaterializerArguments(argv);
  return materializeMeshResultArtifact({
    materializationRoot: args.materializationRoot,
    destination: args.destination,
    baseArtifact: readManifestJson(args.baseFile, "base manifest", hooks) as MeshBaseArtifactManifest,
    resultArtifact: readManifestJson(args.resultFile, "result manifest", hooks) as MeshResultArtifactManifest,
    expectedTaskId: args.expectedTaskId,
  });
}

function boundedCliMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") return "artifact input is invalid";
  const raw = error instanceof Error ? error.message : "artifact materialization failed";
  const clean = raw
    .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;)'\"]+/g, "[path]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim() || "artifact materialization failed";
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= MAX_CLI_ERROR_BYTES) return clean;
  return bytes.subarray(0, MAX_CLI_ERROR_BYTES).toString("utf8").replace(/\uFFFD$/, "");
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const line = JSON.stringify(runArtifactMaterializerCli(argv));
    if (Buffer.byteLength(line, "utf8") + 1 > MAX_CLI_OUTPUT_BYTES) {
      throw new Error("materialization summary exceeds output limit");
    }
    process.stdout.write(`${line}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${boundedCliMessage(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main();
