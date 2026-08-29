/**
 * Target-side executor for Mesh tasks.
 *
 * This module is deliberately boring: it accepts typed operations only and
 * never turns agent text into a shell command.  The policy decision must be
 * made before calling execute(); the executor is the last local boundary for
 * path and destructive-operation checks.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type MeshOperation =
  | "inspect"
  | "stage"
  | "run"
  | "apply-patch"
  | "quarantine"
  | "deploy"
  | "delete"
  | "sudo"
  | "secret-read"
  | "arbitrary-shell";

export interface LocalMeshResource {
  id: string;
  ownerNodeId: string;
  kind: "repo" | "directory" | "artifact" | "gpu";
  displayName: string;
  /** Local path. Never accept this value from an untrusted task request. */
  root: string;
  /** Owner-configured read-only probe used for status discovery. */
  statusRunnerId?: string;
}

export interface MeshTaskLike {
  groupId?: string;
  taskId: string;
  requesterNodeId: string;
  targetNodeId: string;
  resourceId: string;
  operation: MeshOperation;
  scope?: unknown;
}

export interface MeshExecutionPermit {
  allowed: boolean;
  resourceId: string;
  operation: MeshOperation;
  taskId: string;
  grantId?: string;
}

export interface MeshExecutorOptions {
  /** Roots that may contain registered resources. Empty means no resources. */
  allowedRoots?: string[];
  /** Where quarantined resources are moved. Defaults to ~/.agentlink/quarantine. */
  quarantineRoot?: string;
  /** Bound directory enumeration so a hostile tree cannot consume the daemon. */
  maxEntries?: number;
}

export interface ResourcePreview {
  resourceId: string;
  kind: LocalMeshResource["kind"];
  displayName: string;
  entryCount: number;
  truncated: boolean;
  bytes: number;
}

export interface QuarantineResult extends ResourcePreview {
  quarantinePath: string;
  manifestPath: string;
}

const DEFAULT_MAX_ENTRIES = 10_000;

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalExisting(path: string): string {
  if (!isAbsolute(path)) throw new Error("资源路径必须是绝对路径");
  if (!existsSync(path)) throw new Error("资源路径不存在");
  return realpathSync(path);
}

function safeName(input: string): string {
  const value = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return value.slice(0, 80) || "resource";
}

function assertNotDangerousRoot(path: string): void {
  const root = resolve(path);
  const home = resolve(homedir());
  if (root === parse(root).root || root === home || root === dirname(home)) {
    throw new Error("拒绝把系统根目录、用户目录或其父目录作为 Mesh 资源");
  }
}

function scanTree(root: string, maxEntries: number): Pick<ResourcePreview, "entryCount" | "truncated" | "bytes"> {
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink()) return { entryCount: 0, truncated: false, bytes: 0 };
  if (!rootInfo.isDirectory()) {
    return { entryCount: 1, truncated: false, bytes: rootInfo.isFile() ? rootInfo.size : 0 };
  }
  const pending = [root];
  let entryCount = 0;
  let bytes = 0;
  let truncated = false;

  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable subtree is not a reason to follow a guessed path or to
      // continue with a destructive operation. Report it as bounded preview.
      truncated = true;
      continue;
    }
    for (const entry of entries) {
      entryCount++;
      if (entryCount > maxEntries) {
        truncated = true;
        return { entryCount: maxEntries, truncated, bytes };
      }
      const child = join(current, entry.name);
      try {
        const info = lstatSync(child);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) pending.push(child);
        else if (info.isFile()) bytes += info.size;
      } catch {
        truncated = true;
      }
    }
  }
  return { entryCount, truncated, bytes };
}

export class MeshExecutor {
  private readonly resources = new Map<string, LocalMeshResource>();
  private readonly allowedRoots: string[];
  private readonly quarantineRoot: string;
  private readonly maxEntries: number;

  constructor(options: MeshExecutorOptions = {}) {
    this.allowedRoots = (options.allowedRoots ?? []).map((root) => {
      if (!isAbsolute(root)) throw new Error("allowedRoots 必须是绝对路径");
      const resolved = existsSync(root) ? realpathSync(root) : resolve(root);
      assertNotDangerousRoot(resolved);
      return resolved;
    });
    this.quarantineRoot = resolve(options.quarantineRoot ?? join(homedir(), ".agentlink", "quarantine"));
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    assertNotDangerousRoot(this.quarantineRoot);
  }

  registerResource(resource: LocalMeshResource): void {
    if (!resource.id || !resource.ownerNodeId || !resource.displayName) {
      throw new Error("资源缺少 id、ownerNodeId 或 displayName");
    }
    const root = canonicalExisting(resource.root);
    assertNotDangerousRoot(root);
    if (this.allowedRoots.length === 0 || !this.allowedRoots.some((allowed) => isWithin(root, allowed))) {
      throw new Error("资源路径不在允许的资源根目录内");
    }
    this.resources.set(resource.id, { ...resource, root });
  }

  unregisterResource(resourceId: string): boolean {
    return this.resources.delete(resourceId);
  }

  getResource(resourceId: string): LocalMeshResource | undefined {
    const resource = this.resources.get(resourceId);
    return resource ? { ...resource } : undefined;
  }

  preview(resourceId: string): ResourcePreview {
    const resource = this.requireResource(resourceId);
    const root = canonicalExisting(resource.root);
    const stats = scanTree(root, this.maxEntries);
    return {
      resourceId: resource.id,
      kind: resource.kind,
      displayName: resource.displayName,
      ...stats,
    };
  }

  /**
   * Execute only the safe destructive substitute: move to quarantine and
   * leave a manifest. There is intentionally no delete() implementation.
   */
  execute(request: MeshTaskLike, permit: MeshExecutionPermit): ResourcePreview | QuarantineResult {
    if (!permit.allowed || permit.resourceId !== request.resourceId
      || permit.taskId !== request.taskId || permit.operation !== request.operation) {
      throw new Error("执行许可与任务不匹配");
    }
    if (request.operation === "delete") {
      throw new Error("硬删除已在 Mesh 执行器中永久禁用，请使用 quarantine");
    }
    if (request.operation === "arbitrary-shell" || request.operation === "sudo" || request.operation === "secret-read") {
      throw new Error(`高风险操作 ${request.operation} 不受支持`);
    }
    if (request.operation === "inspect") return this.preview(request.resourceId);
    if (request.operation !== "quarantine") {
      throw new Error(`操作 ${request.operation} 尚未接入 typed executor`);
    }
    return this.quarantine(request.resourceId, request.taskId);
  }

  private requireResource(resourceId: string): LocalMeshResource {
    if (!resourceId) throw new Error("缺少 resourceId");
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("未知资源");
    return resource;
  }

  private quarantine(resourceId: string, taskId: string): QuarantineResult {
    const resource = this.requireResource(resourceId);
    const preview = this.preview(resourceId);
    const source = canonicalExisting(resource.root);
    const quarantineRoot = resolve(this.quarantineRoot);
    assertNotDangerousRoot(quarantineRoot);
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    const canonicalQuarantineRoot = realpathSync(quarantineRoot);
    assertNotDangerousRoot(canonicalQuarantineRoot);
    if (isWithin(canonicalQuarantineRoot, source) || isWithin(source, canonicalQuarantineRoot)) {
      throw new Error("资源目录与 quarantine 目录不能互相包含");
    }
    const destination = join(canonicalQuarantineRoot, `${safeName(resource.displayName)}-${Date.now()}-${safeName(taskId)}`);
    if (existsSync(destination)) throw new Error("quarantine 目标已存在");
    const manifestPath = `${destination}.json`;
    const tempManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
    const manifest = JSON.stringify(
      {
        version: 1,
        resourceId: resource.id,
        displayName: resource.displayName,
        kind: resource.kind,
        ownerNodeId: resource.ownerNodeId,
        taskId,
        quarantinedAt: Date.now(),
        originalBaseName: basename(source),
      },
      null,
      2,
    ) + "\n";
    writeFileSync(tempManifestPath, manifest,
      { mode: 0o600, flag: "wx" });
    try {
      renameSync(source, destination);
      renameSync(tempManifestPath, manifestPath);
    } catch (error) {
      try { if (existsSync(tempManifestPath)) unlinkSync(tempManifestPath); } catch { /* best effort */ }
      // If the source move succeeded but the manifest did not, roll back the
      // move. A quarantine without a recovery manifest is not an acceptable
      // successful result.
      try {
        if (!existsSync(source) && existsSync(destination)) renameSync(destination, source);
      } catch { /* surface the original error; audit must mark it failed */ }
      throw error;
    }
    this.resources.set(resource.id, { ...resource, root: destination });
    return { ...preview, quarantinePath: destination, manifestPath };
  }
}
