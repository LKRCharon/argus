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
import { MeshRunScopeSchema } from "@agentlink/wire";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MeshTaskLike } from "./executor";
import { MeshExecutor } from "./executor";

const DEFAULT_RUNTIME_MS = 15 * 60_000;
const MAX_RUNTIME_MS = 24 * 60 * 60_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

export interface MeshRunnerSpec {
  id: string;
  resourceId: string;
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
  /** Opt in to returning runner stdout/stderr to the requester. */
  exposeOutput?: boolean;
}

interface RegisteredRunner extends Omit<MeshRunnerSpec, "executable" | "workdir"> {
  executable: string;
  workdir: string;
  fixedArgs: string[];
  env: Record<string, string>;
  maxRuntimeMs: number;
  maxOutputBytes: number;
  exposeOutput: boolean;
}

export interface MeshRunnerResult {
  runnerId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputExposed: boolean;
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

export class MeshRunnerRegistry {
  private readonly runners = new Map<string, RegisteredRunner>();

  constructor(private readonly executor: MeshExecutor, specs: MeshRunnerSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: MeshRunnerSpec): void {
    if (!spec.id.trim() || !spec.resourceId.trim()) throw new Error("runner 缺少 id 或 resourceId");
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
    this.runners.set(spec.id, {
      id: spec.id,
      resourceId: spec.resourceId,
      executable,
      workdir: resolvedWorkdir,
      fixedArgs,
      env,
      maxRuntimeMs,
      maxOutputBytes,
      exposeOutput: spec.exposeOutput === true,
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
      .filter((runner) => runner.resourceId === resourceId)
      .map((runner) => runner.id);
  }

  async run(task: MeshTaskLike): Promise<MeshRunnerResult> {
    if (task.operation !== "run") throw new Error("runner 只接受 run 任务");
    const parsed = MeshRunScopeSchema.safeParse(task.scope ?? {});
    if (!parsed.success) throw new Error("run scope 必须只包含 runnerId、args、input、timeoutMs");
    const runner = this.runners.get(parsed.data.runnerId);
    if (!runner || runner.resourceId !== task.resourceId) throw new Error("runner 与资源不匹配");
    for (const [index, arg] of parsed.data.args.entries()) assertSafeArg(arg, `run args[${index}]`);
    const timeoutMs = Math.min(parsed.data.timeoutMs ?? runner.maxRuntimeMs, runner.maxRuntimeMs);
    const startedAt = Date.now();
    const child = spawn(runner.executable, [...runner.fixedArgs, ...parsed.data.args], {
      cwd: runner.workdir,
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
        resolveResult({
          runnerId: parsed.data.runnerId,
          status: timedOut ? "cancelled" : exitCode === 0 ? "completed" : "failed",
          exitCode,
          signal: signal ? String(signal) : null,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          outputExposed: runner.exposeOutput,
        });
      };

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
      child.stdin.end(parsed.data.input ?? "");
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        stop("SIGTERM");
        killHandle = setTimeout(() => {
          if (!settled) stop("SIGKILL");
        }, 2_000);
      }, timeoutMs);
    });
  }
}
