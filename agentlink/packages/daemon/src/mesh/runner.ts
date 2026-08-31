/**
 * Named, local process runners for Mesh `run` tasks.
 *
 * A runner is configured by the resource owner. The peer can select only the
 * runner ID and data arguments; it cannot select an executable, cwd, env, or
 * shell mode. This keeps GPU/ML jobs extensible without creating a remote
 * shell disguised as an agent prompt.
 */

import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  MeshRunScopeSchema,
  type MeshJsonValue,
  type MeshRunnerMetadata,
  type MeshWorkspaceCapability,
} from "@agentlink/wire";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MeshTaskLike } from "./executor";
import { MeshExecutor } from "./executor";

const DEFAULT_RUNTIME_MS = 15 * 60_000;
const MAX_RUNTIME_MS = 24 * 60 * 60_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const MAX_RESULT_SUMMARY_BYTES = 32 * 1024;
const ARTIFACT_WORKSPACE_CAPABILITIES = [
  "structured-artifact-input",
  "task-scoped-workspace",
  "changed-file-manifest",
] as const;

export interface MeshRunnerSpec {
  id: string;
  resourceId: string;
  /** Status probes and task runners are separate capabilities. */
  purpose?: "task" | "status";
  /** Absolute, owner-configured executable. Never read from a task scope. */
  executable: string;
  /** Fixed arguments owned by the target machine, placed before task args. */
  fixedArgs?: string[];
  /** Relative to the registered resource root; omitted means the resource root. */
  workdir?: string;
  /** Fixed non-secret environment for the runner process. */
  env?: Record<string, string>;
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  /** Allow request-provided data arguments. Defaults to false. */
  allowDynamicArgs?: boolean;
  /** Allow request-provided stdin. Defaults to false. */
  allowInput?: boolean;
  /** Opt in to returning runner stdout/stderr to the requester. */
  exposeOutput?: boolean;
  /** Public metadata. Executable, cwd, fixed args, and env are never included. */
  title?: string;
  inputSchema?: MeshJsonValue;
  resultSchema?: MeshJsonValue;
  approvalRequired?: boolean;
  workspaceCapabilities?: MeshWorkspaceCapability[];
  /** Opt in to returning bounded stderr separately from the result summary. */
  exposeDebugOutput?: boolean;
}

interface RegisteredRunner extends Omit<MeshRunnerSpec, "executable" | "workdir"> {
  executable: string;
  workdir: string;
  fixedArgs: string[];
  env: Record<string, string>;
  maxRuntimeMs: number;
  maxOutputBytes: number;
  exposeDebugOutput: boolean;
  title: string;
  inputSchema: MeshJsonValue;
  resultSchema: MeshJsonValue;
  approvalRequired: boolean;
  workspaceCapabilities: MeshWorkspaceCapability[];
}

export interface MeshRunnerResult {
  runnerId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  resultSummary: string;
  debugOutput?: string;
  resultSummaryTruncated: boolean;
  debugOutputTruncated: boolean;
  debugOutputSuppressed: boolean;
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertSafeArg(value: string, label: string): void {
  if (value.includes("\0")) throw new Error(`${label} 不能包含 NUL 字符`);
  if (value.length > 4096) throw new Error(`${label} 超过长度限制`);
}

function normalizeEnvironment(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {
    PATH: process.env.PATH ?? "",
  };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("runner env 名称无效");
    if (["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV"].includes(key)) {
      throw new Error(`runner env 禁止覆盖 ${key}`);
    }
    assertSafeArg(value, `runner env ${key}`);
    result[key] = value;
  }
  return result;
}

function appendOutput(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return { value: next, truncated: false };
  const bytes = Buffer.from(next, "utf8").subarray(0, maxBytes);
  return { value: bytes.toString("utf8"), truncated: true };
}

function summarizeRunnerOutput(
  raw: string,
  purpose: "task" | "status",
  sourceTruncated: boolean,
): { value: string; truncated: boolean } {
  const trimmed = raw.trim();
  let value = trimmed;
  let discarded = false;
  if (purpose === "task" && trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.hasOwn(parsed, "resultSummary")) {
        const summary = (parsed as { resultSummary?: unknown }).resultSummary;
        value = typeof summary === "string" ? summary : JSON.stringify(summary ?? null);
        discarded = Object.keys(parsed as Record<string, unknown>).some((key) => key !== "resultSummary");
      } else {
        value = JSON.stringify(parsed);
      }
    } catch {
      const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
      value = lines.at(-1) ?? "";
      discarded = lines.length > 1;
    }
  }
  const bounded = appendOutput("", Buffer.from(value, "utf8"), MAX_RESULT_SUMMARY_BYTES);
  return { value: bounded.value, truncated: sourceTruncated || discarded || bounded.truncated };
}

export class MeshRunnerRegistry {
  private readonly runners = new Map<string, RegisteredRunner>();
  private readonly activeTasks = new Map<string, { cancel: () => void }>();

  constructor(private readonly executor: MeshExecutor, specs: MeshRunnerSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: MeshRunnerSpec): void {
    if (!spec.id.trim() || !spec.resourceId.trim()) throw new Error("runner 缺少 id 或 resourceId");
    if (spec.purpose !== undefined && spec.purpose !== "task" && spec.purpose !== "status") {
      throw new Error("runner purpose 无效");
    }
    if (this.runners.has(spec.id)) throw new Error(`runner id 重复: ${spec.id}`);
    const resource = this.executor.getResource(spec.resourceId);
    if (!resource) throw new Error(`runner 绑定了未知资源: ${spec.resourceId}`);
    if (!isAbsolute(spec.executable)) throw new Error("runner executable 必须是绝对路径");
    if (!existsSync(spec.executable)) throw new Error("runner executable 不存在");
    if (lstatSync(spec.executable).isSymbolicLink()) throw new Error("runner executable 不允许是符号链接");
    const executable = realpathSync(spec.executable);
    if (!statSync(executable).isFile()) throw new Error("runner executable 不是文件");
    if (process.platform !== "win32") accessSync(executable, constants.X_OK);

    const workdir = spec.workdir ?? ".";
    if (isAbsolute(workdir)) throw new Error("runner workdir 必须相对资源根目录");
    const resolvedWorkdir = realpathSync(resolve(resource.root, workdir));
    if (!isWithin(resolvedWorkdir, resource.root) || !statSync(resolvedWorkdir).isDirectory()) {
      throw new Error("runner workdir 不在资源根目录内");
    }

    const fixedArgs = [...(spec.fixedArgs ?? [])];
    if (fixedArgs.length > 64) throw new Error("runner fixedArgs 数量超出限制");
    for (const [index, arg] of fixedArgs.entries()) assertSafeArg(arg, `runner fixedArgs[${index}]`);
    const maxRuntimeMs = spec.maxRuntimeMs ?? DEFAULT_RUNTIME_MS;
    if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1_000 || maxRuntimeMs > MAX_RUNTIME_MS) {
      throw new Error("runner maxRuntimeMs 超出范围");
    }
    const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new Error("runner maxOutputBytes 超出范围");
    }

    const env = normalizeEnvironment(spec.env);
    if (Object.keys(env).length > 64) throw new Error("runner env 数量超出限制");
    const purpose = spec.purpose ?? "task";
    const approvalRequired = spec.approvalRequired ?? purpose === "task";
    if (purpose === "task" && !approvalRequired) throw new Error("task runner 必须要求目标本地审批");
    if (purpose === "status" && (approvalRequired || spec.allowDynamicArgs || spec.allowInput)) {
      throw new Error("status runner 必须只读且不接受动态输入");
    }
    const workspaceCapabilities = [...(spec.workspaceCapabilities ?? (purpose === "status"
      ? ["read-only-status" as const]
      : []))];
    if (new Set(workspaceCapabilities).size !== workspaceCapabilities.length) {
      throw new Error("runner workspaceCapabilities 不允许重复");
    }
    const artifactCapabilityCount = ARTIFACT_WORKSPACE_CAPABILITIES
      .filter((capability) => workspaceCapabilities.includes(capability)).length;
    if (artifactCapabilityCount !== 0 && artifactCapabilityCount !== ARTIFACT_WORKSPACE_CAPABILITIES.length) {
      throw new Error("artifact runner 必须完整声明结构化输入、隔离 workspace 和结果 manifest");
    }
    if (purpose === "status" && (workspaceCapabilities.length !== 1
      || workspaceCapabilities[0] !== "read-only-status")) {
      throw new Error("status runner 只能声明 read-only-status capability");
    }
    if (purpose === "task" && workspaceCapabilities.includes("read-only-status")) {
      throw new Error("task runner 不允许声明 read-only-status capability");
    }
    this.runners.set(spec.id, {
      id: spec.id,
      resourceId: spec.resourceId,
      purpose,
      executable,
      workdir: resolvedWorkdir,
      fixedArgs,
      env,
      maxRuntimeMs,
      maxOutputBytes,
      allowDynamicArgs: spec.allowDynamicArgs === true,
      allowInput: spec.allowInput === true,
      exposeDebugOutput: spec.exposeDebugOutput === true || spec.exposeOutput === true,
      title: spec.title ?? spec.id,
      inputSchema: spec.inputSchema ?? { type: "object" },
      resultSchema: spec.resultSchema ?? { type: "object" },
      approvalRequired,
      workspaceCapabilities,
    });
  }

  unregister(id: string): boolean {
    return this.runners.delete(id);
  }

  unregisterForResource(resourceId: string): void {
    for (const [id, runner] of this.runners) {
      if (runner.resourceId === resourceId) this.runners.delete(id);
    }
  }

  get(id: string): MeshRunnerSpec | undefined {
    const runner = this.runners.get(id);
    return runner ? { ...runner, fixedArgs: [...runner.fixedArgs], env: { ...runner.env } } : undefined;
  }

  forResource(resourceId: string): string[] {
    return [...this.runners.values()]
      .filter((runner) => runner.resourceId === resourceId && runner.purpose === "task")
      .map((runner) => runner.id);
  }

  metadataForResource(resourceId: string): MeshRunnerMetadata[] {
    return [...this.runners.values()]
      .filter((runner) => runner.resourceId === resourceId)
      .map((runner) => ({
        runnerId: runner.id,
        title: runner.title,
        purpose: runner.purpose ?? "task",
        inputSchema: structuredClone(runner.inputSchema),
        resultSchema: structuredClone(runner.resultSchema),
        approvalRequired: runner.approvalRequired,
        maxRuntimeMs: runner.maxRuntimeMs,
        workspaceCapabilities: [...runner.workspaceCapabilities],
      }));
  }

  async run(task: MeshTaskLike, workspace?: string): Promise<MeshRunnerResult> {
    if (task.operation !== "run") throw new Error("runner 只接受 run 任务");
    const parsed = MeshRunScopeSchema.safeParse(task.scope ?? {});
    if (!parsed.success) throw new Error("run scope 必须只包含 runnerId、args、input、timeoutMs");
    const runner = this.runners.get(parsed.data.runnerId);
    if (!runner || runner.resourceId !== task.resourceId || runner.purpose !== "task") {
      throw new Error("runner 与资源或用途不匹配");
    }
    if (runner.workspaceCapabilities.includes("task-scoped-workspace") && !parsed.data.baseArtifactId) {
      throw new Error("该 runner 必须使用 task-scoped artifact workspace");
    }
    if (this.activeTasks.has(task.taskId)) throw new Error("同一 taskId 的 runner 已在执行");
    if (parsed.data.args.length > 0 && !runner.allowDynamicArgs) {
      throw new Error("该 runner 不接受动态参数");
    }
    if (parsed.data.input !== undefined && !runner.allowInput) {
      throw new Error("该 runner 不接受远程 stdin");
    }
    for (const [index, arg] of parsed.data.args.entries()) assertSafeArg(arg, `run args[${index}]`);
    let workdir = runner.workdir;
    if (parsed.data.baseArtifactId) {
      if (!workspace || !runner.workspaceCapabilities.includes("task-scoped-workspace")) {
        throw new Error("runner 不支持 task-scoped artifact workspace");
      }
      if (!isAbsolute(workspace) || !existsSync(workspace) || lstatSync(workspace).isSymbolicLink()) {
        throw new Error("artifact workspace 无效");
      }
      workdir = realpathSync(workspace);
      if (!statSync(workdir).isDirectory()) throw new Error("artifact workspace 不是目录");
    } else if (workspace) {
      throw new Error("没有 baseArtifactId 的任务不能覆盖 runner workdir");
    }
    const timeoutMs = Math.min(parsed.data.timeoutMs ?? runner.maxRuntimeMs, runner.maxRuntimeMs);
    return this.runRegistered(task.taskId, parsed.data.runnerId, runner, parsed.data.args, parsed.data.input, timeoutMs, workdir);
  }

  cancel(taskId: string): boolean {
    const active = this.activeTasks.get(taskId);
    if (!active) return false;
    active.cancel();
    return true;
  }

  /** Run an owner-configured read-only status probe without a task grant. */
  async runStatus(runnerId: string, resourceId: string): Promise<MeshRunnerResult> {
    const runner = this.runners.get(runnerId);
    if (!runner || runner.resourceId !== resourceId || runner.purpose !== "status") {
      throw new Error("status runner 与资源或用途不匹配");
    }
    return this.runRegistered(undefined, runnerId, runner, [], undefined, runner.maxRuntimeMs, runner.workdir);
  }

  private async runRegistered(
    taskId: string | undefined,
    runnerId: string,
    runner: RegisteredRunner,
    args: string[],
    input: string | undefined,
    timeoutMs: number,
    workdir: string,
  ): Promise<MeshRunnerResult> {
    const startedAt = Date.now();
    const child = spawn(runner.executable, [...runner.fixedArgs, ...args], {
      cwd: workdir,
      env: runner.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // On POSIX, put the wrapper in its own process group so a timeout does
      // not leave a forked GPU worker running after the task is cancelled.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    return new Promise<MeshRunnerResult>((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let killHandle: ReturnType<typeof setTimeout> | undefined;
      const stop = (signal: "SIGTERM" | "SIGKILL"): void => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall through to the direct child in case the process group
            // disappeared between the timeout and the signal.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // The process may have exited between the timeout and the signal.
        }
      };
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
        // A successful wrapper can otherwise leave a background descendant
        // racing artifact capture. Node has no portable Windows job-object API,
        // but the dedicated POSIX process group lets us reap that boundary.
        if (process.platform !== "win32") stop("SIGKILL");
        if (taskId) this.activeTasks.delete(taskId);
        const summary = summarizeRunnerOutput(stdout, runner.purpose ?? "task", stdoutTruncated);
        resolveResult({
          runnerId,
          status: timedOut || cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
          exitCode,
          signal: signal ? String(signal) : null,
          timedOut,
          durationMs: Date.now() - startedAt,
          resultSummary: summary.value,
          ...(runner.exposeDebugOutput ? { debugOutput: stderr } : {}),
          resultSummaryTruncated: summary.truncated,
          debugOutputTruncated: stderrTruncated,
          debugOutputSuppressed: !runner.exposeDebugOutput,
        });
      };

      const requestStop = (manual: boolean): void => {
        if (settled) return;
        if (manual) cancelled = true;
        stop("SIGTERM");
        if (!killHandle) {
          killHandle = setTimeout(() => {
            if (!settled) stop("SIGKILL");
          }, 2_000);
        }
      };

      if (taskId) this.activeTasks.set(taskId, { cancel: () => requestStop(true) });

      child.stdout.on("data", (chunk: Buffer) => {
        const next = appendOutput(stdout, chunk, runner.maxOutputBytes);
        stdout = next.value;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const next = appendOutput(stderr, chunk, runner.maxOutputBytes);
        stderr = next.value;
        stderrTruncated ||= next.truncated;
      });
      child.once("error", () => finish(null, "spawn-error"));
      child.once("close", (exitCode, signal) => finish(exitCode, signal));
      child.stdin.once("error", () => undefined);
      child.stdin.end(input ?? "");
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        requestStop(false);
      }, timeoutMs);
    });
  }
}
