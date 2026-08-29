/**
 * Client for `codex app-server` — the JSON-RPC server that owns Codex threads.
 *
 * This is a different class of integration from transcript watching. Watching
 * infers what happened by tailing files; app-server *is* the session owner, so
 * a thread started in the Codex app or VS Code can be resumed here, spoken to,
 * steered mid-turn and interrupted. Verified against 0.146.0-alpha.3.1: a
 * vscode-sourced thread resumed from an outside connection reports
 * `canAcceptDirectInput: true`.
 *
 * Codex's own `remote-control` needs a server-side eligibility flag that most
 * accounts do not have yet. Argus owns one private JSONL-over-stdio child, so
 * it never connects to or terminates an app-server owned by the desktop app.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Where the Codex desktop app keeps its bundled binary. */
const APP_BUNDLED = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_LATE_RESULT_GRACE_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
const MAX_STDOUT_FRAME_BYTES = 16 * 1024 * 1024;

/** Resolve a command from PATH without asking a shell to interpret it. */
function commandOnPath(command: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface CodexThread {
  id: string;
  /** First user message, as Codex itself previews it. */
  preview: string;
  /** Model-generated title, nicer than the preview when present. */
  name?: string | null;
  cwd?: string | null;
  /** "notLoaded" until resumed; then idle / running / … */
  status: string;
  /**
   * cli | vscode | exec | appServer | subAgent | …
   *
   * The Codex desktop app reports `vscode`, not `appServer`: it is a VS Code
   * shell (app-server's own userAgent carries `vscode/1.106.3`, and the app
   * ships a `codex_vscode_copilot` originator for the real extension). This is
   * accurate, not stale data — do not "clean it up" by filtering vscode out.
   *
   * Sub-agent threads report an *object* here, not a string, which is why the
   * three fields below are extracted rather than left to callers.
   */
  source?: string | null;
  /** Set when this thread was spawned by another agent. */
  parentThreadId?: string | null;
  /** The codename the parent gave it ("Pauli", "Hilbert"). */
  agentNickname?: string | null;
  /** Nesting level; 1 means spawned directly by a top-level thread. */
  depth?: number | null;
  updatedAt: number;
  /** False for threads that cannot take input (e.g. sub-agent threads). */
  canAcceptDirectInput: boolean;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  onLateResult?: (value: any) => void;
};

export interface CodexAppServerOptions {
  /** Test injection. Production always spawns the resolved Codex binary. */
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  startupTimeoutMs?: number;
  lateResultGraceMs?: number;
  shutdownGraceMs?: number;
}

/**
 * Pull the spawn details out of a thread's `source`.
 *
 * A top-level thread's source is a plain string ("vscode"); a spawned one is
 * `{ subAgent: { thread_spawn: { parent_thread_id, depth, agent_nickname } } }`.
 * Treating both as strings yielded "[object Object]" and lost the parent link,
 * which is the only thing tying an agent to the work that started it.
 */
function describeSpawn(source: unknown):
  { parentThreadId: string; depth: number; nickname: string | null } | null {
  if (!source || typeof source !== "object") return null;
  const sub = (source as any).subAgent ?? (source as any).subagent;
  const spawn = sub?.thread_spawn ?? sub?.threadSpawn;
  if (!spawn?.parent_thread_id && !spawn?.parentThreadId) return null;
  return {
    parentThreadId: String(spawn.parent_thread_id ?? spawn.parentThreadId),
    depth: Number(spawn.depth ?? 1),
    nickname: spawn.agent_nickname ?? spawn.agentNickname ?? null,
  };
}

/**
 * Turn history -> the phone's event vocabulary (text / user-text / thinking /
 * tool-call / tool-result / turn-done). Anything unrecognised is skipped rather
 * than guessed at, so a new item type shows up as missing content instead of
 * garbage.
 */
function flattenTurns(turns: any[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const turn of turns) {
    for (const item of turn?.items ?? []) {
      switch (item?.type) {
        case "userMessage": {
          const text = (item.content ?? [])
            .filter((c: any) => c?.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("");
          if (text.trim()) out.push({ type: "user-text", text: text.trim() });
          break;
        }
        case "agentMessage":
          if (typeof item.text === "string" && item.text.trim()) {
            out.push({ type: "text", text: item.text });
          }
          break;
        case "reasoning": {
          // `summary` holds the headings Codex shows; `content` is the long form.
          const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
          if (summary.trim()) out.push({ type: "thinking", text: summary });
          break;
        }
        case "commandExecution":
          out.push({
            type: "tool-call",
            name: "shell",
            summary: String(item.command ?? item.parsedCmd ?? "").slice(0, 300),
          });
          break;
        case "fileChange":
          out.push({
            type: "tool-call",
            name: "edit",
            summary: (item.changes ?? []).map((c: any) => c?.path).filter(Boolean).join(", ").slice(0, 300),
          });
          break;
        case "mcpToolCall":
          out.push({
            type: "tool-call",
            name: String(item.server ?? "mcp"),
            summary: String(item.tool ?? "").slice(0, 200),
          });
          break;
        default:
          break;
      }
    }
    // Only closed turns get a marker; an in-flight turn should stay "running".
    const status = typeof turn?.status === "string" ? turn.status : turn?.status?.type;
    if (status && status !== "inProgress" && status !== "running") {
      out.push({ type: "turn-done", reason: String(status) });
    }
  }
  return out;
}

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly startupTimeoutMs: number;
  private readonly lateResultGraceMs: number;
  private readonly shutdownGraceMs: number;

  /** Notifications from the server (thread/*, item/*, turn/*, …). */
  onNotification: ((method: string, params: any) => void) | null = null;
  /** Server-initiated requests — approvals arrive here and must be answered. */
  onServerRequest: ((id: number | string, method: string, params: any) => void) | null = null;

  constructor(private readonly options: CodexAppServerOptions = {}) {
    this.startupTimeoutMs = boundedMs(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.lateResultGraceMs = boundedMs(options.lateResultGraceMs, DEFAULT_LATE_RESULT_GRACE_MS);
    this.shutdownGraceMs = boundedMs(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
  }

  /**
   * Codex binary to drive.
   *
   * Desktop installs keep a bundled binary, but a headless Linux host normally
   * has only a CLI on PATH. `CODEX_BIN` is deliberately first so a user-level
   * service can pin its own binary without relying on a login shell's PATH.
   */
  static binaryPath(): string | null {
    const configured = process.env.CODEX_BIN?.trim();
    if (configured) return configured;
    if (existsSync(APP_BUNDLED)) return APP_BUNDLED;
    const standalone = join(homedir(), ".codex/packages/standalone/current/codex");
    if (existsSync(standalone)) return standalone;
    return commandOnPath("codex");
  }

  /** Spawn app-server (if needed) and complete the JSON-RPC handshake. */
  async start(): Promise<void> {
    if (this.ready) return this.ready;
    const attempt = this.startAttempt();
    this.ready = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.ready === attempt) this.ready = null;
      throw error;
    }
  }

  private async startAttempt(): Promise<void> {
    if (this.stopping) await this.stopping;
    const proc = this.spawnOwnedProcess();
    this.proc = proc;
    this.attachProcess(proc);
    const deadline = Date.now() + this.startupTimeoutMs;
    try {
      await this.waitForSpawn(proc, Math.max(1, deadline - Date.now()));
      if (this.proc !== proc) throw new Error("app-server 在初始化前退出");
      await this.call("initialize", {
        clientInfo: { name: "argus", title: "Argus", version: "0.1.0" },
      }, Math.max(1, deadline - Date.now()));
      this.notify("initialized");
    } catch (error) {
      if (this.proc === proc) this.proc = null;
      this.rejectPending(new Error("app-server 初始化失败"));
      await this.terminateProcess(proc);
      throw error instanceof Error ? error : new Error("app-server 初始化失败");
    }
  }

  private spawnOwnedProcess(): ChildProcessWithoutNullStreams {
    if (this.options.spawnProcess) return this.options.spawnProcess();
    const bin = CodexAppServer.binaryPath();
    if (!bin) throw new Error("未找到 codex 可执行文件（设置 CODEX_BIN 或将 codex 加入 PATH）");
    return spawn(bin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
  }

  private attachProcess(proc: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      if (this.proc !== proc) return;
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_STDOUT_FRAME_BYTES) {
          this.failOwnedProcess(proc, new Error("app-server JSON-RPC frame 超过上限"));
          return;
        }
        if (line) this.dispatch(proc, line);
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_STDOUT_FRAME_BYTES) {
        this.failOwnedProcess(proc, new Error("app-server JSON-RPC frame 超过上限"));
      }
    });
    // An unread stderr pipe can fill and deadlock the child. Diagnostics stay
    // target-local and are deliberately not forwarded to the controller.
    proc.stderr.on("data", () => {});
    proc.once("error", () => {
      this.failOwnedProcess(proc, new Error("app-server 子进程启动失败"));
    });
    proc.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleProcessEnd(proc, new Error(`app-server 子进程已退出（${detail}）`));
    });
  }

  private waitForSpawn(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        proc.off("spawn", onSpawn);
        proc.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("app-server 子进程启动失败"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("app-server 启动超时"));
      }, timeoutMs);
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
    });
  }

  private dispatch(proc: ChildProcessWithoutNullStreams, raw: string): void {
    if (this.proc !== proc) return;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (typeof msg.id !== "undefined" && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (p.timedOut) {
        if (!msg.error) {
          try { p.onLateResult?.(msg.result); } catch {}
        }
        return;
      }
      if (msg.error) p.reject(new Error(msg.error.message ?? "app-server 错误"));
      else p.resolve(msg.result);
      return;
    }
    // A message with both id and method is a server->client request (approvals).
    if (typeof msg.id !== "undefined" && msg.method) {
      this.onServerRequest?.(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) this.onNotification?.(msg.method, msg.params);
  }

  call<T = any>(
    method: string,
    params: unknown = {},
    timeoutMs = 30_000,
    onLateResult?: (value: T) => void,
  ): Promise<T> {
    const proc = this.proc;
    if (!proc || proc.stdin.destroyed || !proc.stdin.writable) {
      return Promise.reject(new Error("app-server 未连接"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        timedOut: false,
        onLateResult,
      };
      const timer = setTimeout(() => {
        if (onLateResult) {
          pending.timedOut = true;
          pending.timer = setTimeout(() => {
            if (this.pending.get(id) === pending) this.pending.delete(id);
          }, this.lateResultGraceMs);
        } else {
          this.pending.delete(id);
        }
        reject(new Error(`${method} 超时`));
      }, boundedMs(timeoutMs, 30_000));
      pending.timer = timer;
      this.pending.set(id, pending);
      try {
        this.writeFrame(proc, { jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("app-server 写入失败"));
      }
    });
  }

  /** Send a JSON-RPC notification; notifications deliberately have no id. */
  private notify(method: string, params?: unknown): void {
    const proc = this.proc;
    if (!proc) throw new Error("app-server 未连接");
    this.writeFrame(proc, params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  /** Answer a server-initiated request (this is how approvals get resolved). */
  respond(id: number | string, result: unknown): void {
    const proc = this.proc;
    if (!proc) throw new Error("app-server 未连接");
    this.writeFrame(proc, { jsonrpc: "2.0", id, result });
  }

  private writeFrame(proc: ChildProcessWithoutNullStreams, value: unknown): void {
    if (this.proc !== proc || proc.stdin.destroyed || !proc.stdin.writable) {
      throw new Error("app-server 未连接");
    }
    const frame = `${JSON.stringify(value)}\n`;
    try {
      proc.stdin.write(frame, "utf8", (error) => {
        if (error) this.failOwnedProcess(proc, new Error("app-server stdin 写入失败"));
      });
    } catch {
      this.failOwnedProcess(proc, new Error("app-server stdin 写入失败"));
      throw new Error("app-server 写入失败");
    }
  }

  private failOwnedProcess(proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.proc !== proc) return;
    this.handleProcessEnd(proc, error);
    this.beginTermination(proc);
  }

  private handleProcessEnd(proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = null;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.timedOut) pending.reject(error);
    }
    this.pending.clear();
  }

  private beginTermination(proc: ChildProcessWithoutNullStreams): void {
    if (this.stopping) return;
    const stopping = this.terminateProcess(proc);
    this.stopping = stopping;
    void stopping.then(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
  }

  private async terminateProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
    if (hasExited(proc)) return;
    try { proc.stdin.end(); } catch {}
    if (await waitForExit(proc, this.shutdownGraceMs)) return;
    try { proc.kill("SIGTERM"); } catch {}
    if (await waitForExit(proc, this.shutdownGraceMs)) return;
    try { proc.kill("SIGKILL"); } catch {}
    await waitForExit(proc, this.shutdownGraceMs);
  }

  // ---- thread operations ----------------------------------------------------

  /**
   * Every thread Codex knows about. `sourceKinds` matters: omitting it returns
   * only interactive sources, which silently hides app and exec threads.
   */
  async listThreads(limit = 40, timeoutMs = 30_000): Promise<CodexThread[]> {
    const res = await this.call<any>("thread/list", {
      // Omitting sourceKinds returns only "interactive sources" and answers
      // with zero rows on a machine full of sessions. `vscode` is what the
      // desktop app's own threads are tagged with, so it has to be in here.
      // The subAgent kinds matter too: without them, agents spawned by another
      // agent are filtered out and their work is invisible.
      sourceKinds: [
        "cli", "vscode", "exec", "appServer",
        "subAgent", "subAgentReview", "subAgentCompact",
        "subAgentThreadSpawn", "subAgentOther",
      ],
      limit,
    }, timeoutMs);
    const rows: any[] = res?.data ?? [];
    return rows.map((t) => {
      const spawn = describeSpawn(t.source);
      return {
        id: String(t.id),
        preview: String(t.preview ?? ""),
        name: t.name ?? null,
        cwd: t.cwd ?? null,
        status: typeof t.status === "object" ? String(t.status?.type ?? "unknown") : String(t.status ?? "unknown"),
        source: spawn ? "subAgent" : (typeof t.source === "string" ? t.source : null),
        parentThreadId: spawn?.parentThreadId ?? t.parentThreadId ?? null,
        agentNickname: spawn?.nickname ?? t.agentNickname ?? null,
        depth: spawn?.depth ?? null,
        updatedAt: Number(t.updatedAt ?? 0) * 1000,
        // Only meaningful once resumed; unresumed threads report null.
        canAcceptDirectInput: t.canAcceptDirectInput === true,
      };
    });
  }

  /**
   * Load a thread into the server so it can take input, and flatten its history
   * into the same event shape the live stream uses.
   *
   * Flattening happens here rather than on the phone: the item taxonomy
   * (userMessage / reasoning / agentMessage / commandExecution / fileChange …)
   * is app-server's, and teaching a second client about it would mean two places
   * to update when it changes.
   */
  async resume(threadId: string, timeoutMs = 30_000): Promise<{
    canAcceptDirectInput: boolean;
    turns: any[];
    events: Record<string, unknown>[];
    cwd?: string;
  }> {
    const res = await this.call<any>("thread/resume", { threadId }, timeoutMs);
    const turns: any[] = res?.initialTurnsPage?.data ?? res?.thread?.turns ?? [];
    return {
      canAcceptDirectInput: res?.thread?.canAcceptDirectInput === true,
      turns,
      events: flattenTurns(turns),
      cwd: res?.cwd,
    };
  }

  /** Send a message, starting a new turn. */
  async startTurn(threadId: string, text: string, timeoutMs = 30_000): Promise<string | null> {
    const res = await this.call<any>("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    }, timeoutMs);
    return res?.turnId ?? res?.turn?.id ?? null;
  }

  /**
   * Redirect a turn that is already running. Needs the active turn id as a
   * precondition, so a stale steer cannot land on the wrong turn.
   */
  async steerTurn(threadId: string, turnId: string, text: string, timeoutMs = 30_000): Promise<void> {
    await this.call("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    }, timeoutMs);
  }

  async interruptTurn(threadId: string, turnId: string, timeoutMs = 30_000): Promise<void> {
    await this.call("turn/interrupt", { threadId, turnId }, timeoutMs);
  }

  /** Start a brand-new thread in `cwd`. */
  async startThread(
    cwd?: string,
    timeoutMs = 30_000,
    onLateThread?: (threadId: string) => void,
  ): Promise<string | null> {
    const res = await this.call<any>("thread/start", cwd ? { cwd } : {}, timeoutMs, (late) => {
      const threadId = late?.thread?.id ?? late?.threadId;
      if (threadId) onLateThread?.(String(threadId));
    });
    return res?.thread?.id ?? res?.threadId ?? null;
  }

  async stop(): Promise<void> {
    if (this.stopping) await this.stopping;
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    this.rejectPending(new Error("app-server 已停止"));
    if (!proc) return;
    const stopping = this.terminateProcess(proc);
    this.stopping = stopping;
    await stopping;
    if (this.stopping === stopping) this.stopping = null;
  }
}

function boundedMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function hasExited(proc: ChildProcessWithoutNullStreams): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(hasExited(proc)), timeoutMs);
    proc.once("exit", onExit);
    if (hasExited(proc)) finish(true);
  });
}
