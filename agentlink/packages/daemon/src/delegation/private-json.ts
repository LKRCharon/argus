import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export function readPrivateJson(file: string, label: string, maxBytes: number): unknown {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad; expected 0600`);
  }
  if (stat.size > maxBytes) throw new Error(`${label} exceeds its size limit`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} is unreadable or invalid JSON`);
  }
}

export function atomicWritePrivateJson(
  file: string,
  value: unknown,
  label: string,
  maxBytes: number,
): void {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its size limit`);
  }

  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(parent, 0o700);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }

  const temp = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
