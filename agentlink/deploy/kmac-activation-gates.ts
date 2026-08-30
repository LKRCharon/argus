import { normalize, posix } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const MAX_PATH_LENGTH = 4096;

export interface ManifestVerificationSummary {
  ok?: unknown;
  manifestValid?: unknown;
  treeMatchesManifest?: unknown;
  gitCommit?: unknown;
}

export interface FixedFileMetadata {
  regular: boolean;
  symlink: boolean;
  executable: boolean;
}

export function candidateMeshHashMatches(actual: string, expected: string): boolean {
  return SHA256.test(expected) && SHA256.test(actual) && actual === expected;
}

export function reversePlistHashMatches(actual: string, expected: string): boolean {
  return candidateMeshHashMatches(actual, expected);
}

export function manifestMatchesReviewedCommit(
  value: ManifestVerificationSummary,
  reviewedCommit: string,
): boolean {
  return value.ok === true
    && value.manifestValid === true
    && value.treeMatchesManifest === true
    && typeof value.gitCommit === "string"
    && COMMIT.test(value.gitCommit)
    && COMMIT.test(reviewedCommit)
    && value.gitCommit === reviewedCommit;
}

export function isPersistentAbsolutePath(value: string): boolean {
  return value.length <= MAX_PATH_LENGTH
    && value.startsWith("/")
    && !value.includes("\0")
    && !value.includes("\n")
    && !value.includes("\r")
    && value !== "/tmp"
    && value !== "/private/tmp"
    && !value.startsWith("/tmp/")
    && !value.startsWith("/private/tmp/");
}

export function canonicalPathWithin(
  base: string,
  candidate: string,
  childDirectory: string,
): boolean {
  if (!isPersistentAbsolutePath(base) || !isPersistentAbsolutePath(candidate)) return false;
  const normalizedBase = posix.normalize(base);
  const normalizedCandidate = posix.normalize(candidate);
  const allowedRoot = posix.join(normalizedBase, childDirectory);
  return normalizedCandidate.startsWith(`${allowedRoot}/`);
}

export function handoffResultPathWithin(base: string, candidate: string): boolean {
  if (!isPersistentAbsolutePath(base) || !isPersistentAbsolutePath(candidate)) return false;
  const normalizedBase = posix.normalize(base);
  const normalizedCandidate = posix.normalize(candidate);
  const resultRoot = posix.join(normalizedBase, "activation", "handoff", "results");
  const name = posix.basename(normalizedCandidate);
  return normalizedCandidate.startsWith(`${resultRoot}/`)
    && /^handoff-[A-Za-z0-9._-]{1,80}\.result$/.test(name)
    && !candidate.includes("/../")
    && !candidate.endsWith("/..");
}

export function fixedFileIsReady(
  scriptDirectory: string,
  candidate: string,
  metadata: FixedFileMetadata,
): boolean {
  if (!metadata.regular || metadata.symlink || !metadata.executable) return false;
  return candidate.length <= MAX_PATH_LENGTH
    && posix.dirname(posix.normalize(candidate)) === posix.normalize(scriptDirectory);
}

/** Fixed, audited argv used only when restoring the manual reverse tunnel. */
export const MANUAL_RESTORE_ARGS = Object.freeze([
  "/usr/bin/ssh",
  "-fNT",
  "-o",
  "BatchMode=yes",
  "-o",
  "ClearAllForwardings=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ConnectTimeout=10",
  "-R",
  "127.0.0.1:22022:127.0.0.1:22",
  "seoul",
] as const);

export function normalizedPath(value: string): string {
  return normalize(value).split("\\").join("/");
}
