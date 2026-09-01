import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer, type CodexAppServerOptions } from "../src/codex-appserver";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-codex-lifecycle.ts");
const owned = new Set<ChildProcessWithoutNullStreams>();
const originalCodexBin = process.env.CODEX_BIN;

afterEach(async () => {
  for (const child of owned) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        setTimeout(resolve, 500);
      });
    }
  }
  owned.clear();
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
});

test("CodexAppServer prefers an explicit native binary", () => {
  process.env.CODEX_BIN = process.execPath;
  expect(CodexAppServer.binaryPath()).toBe(process.execPath);
});

function harness(
  modes: string[],
  options: Omit<CodexAppServerOptions, "spawnProcess"> = {},
): { server: CodexAppServer; children: ChildProcessWithoutNullStreams[] } {
  const children: ChildProcessWithoutNullStreams[] = [];
  let attempt = 0;
  const server = new CodexAppServer({
    startupTimeoutMs: 250,
    shutdownGraceMs: 30,
    lateResultGraceMs: 40,
    ...options,
    spawnProcess: () => {
      const mode = modes[Math.min(attempt, modes.length - 1)]!;
      attempt += 1;
      const child = spawn(process.execPath, ["run", fixture, mode], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      owned.add(child);
      return child;
    },
  });
  return { server, children };
}

function exited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function pendingCount(server: CodexAppServer): number {
  return (server as unknown as { pending: Map<number, unknown> }).pending.size;
}

describe("owned Codex app-server lifecycle", () => {
  test("frames split UTF-8 JSONL responses and drains child stderr", async () => {
    const { server, children } = harness(["split"]);
    await server.start();
    const threads = await server.listThreads(40, 250);
    expect(threads).toEqual([expect.objectContaining({
      id: "thread-fixture",
      preview: "分片响应",
      source: "vscode",
    })]);
    await server.stop();
    expect(children).toHaveLength(1);
    expect(exited(children[0]!)).toBe(true);
  });

  test("rejects an initialize exit promptly, cleans it up, and retries with a fresh child", async () => {
    const { server, children } = harness(["exit-init", "split"]);
    const startedAt = Date.now();
    await expect(server.start()).rejects.toThrow("app-server");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(exited(children[0]!)).toBe(true);

    await server.start();
    expect((await server.listThreads(40, 250))[0]?.id).toBe("thread-fixture");
    expect(children).toHaveLength(2);
    await server.stop();
    expect(exited(children[1]!)).toBe(true);
  });

  test("bounds initialization timeout, reaps the failed child, and permits retry", async () => {
    const { server, children } = harness(["hang-init", "split"], {
      startupTimeoutMs: 40,
      shutdownGraceMs: 20,
    });
    await expect(server.start()).rejects.toThrow("initialize 超时");
    expect(exited(children[0]!)).toBe(true);
    expect(pendingCount(server)).toBe(0);

    await server.start();
    expect((await server.listThreads(40, 250))[0]?.id).toBe("thread-fixture");
    await server.stop();
  });

  test("removes a timed-out request and lets the same owned server answer a retry", async () => {
    const { server } = harness(["timeout-once"]);
    await server.start();
    await expect(server.listThreads(40, 20)).rejects.toThrow("thread/list 超时");
    expect(pendingCount(server)).toBe(0);
    expect((await server.listThreads(40, 250))[0]?.id).toBe("thread-fixture");
    await server.stop();
  });

  test("resumes input without deprecated full-history hydration", async () => {
    const { server } = harness(["paginated-resume"]);
    await server.start();
    expect(await server.resumeForInput("thread-paginated", 250)).toEqual({
      canAcceptDirectInput: true,
      cwd: "/workspace/paginated",
    });
    await server.stop();
  });

  test("hydrates one bounded full-items turn page in chronological order", async () => {
    const { server } = harness(["paginated-resume"]);
    await server.start();
    const resumed = await server.resume("thread-paginated", 250);

    expect(resumed.turns.map((turn) => turn.id)).toEqual(["turn-old", "turn-new"]);
    expect(resumed.events).toEqual([
      { type: "user-text", text: "old prompt" },
      { type: "turn-done", reason: "completed" },
      { type: "text", text: "new reply" },
    ]);
    expect(resumed.canAcceptDirectInput).toBe(true);
    expect(resumed.cwd).toBe("/workspace/paginated");
    await server.stop();
  });

  test("bounds late-result retention when an operation never answers", async () => {
    const { server } = harness(["never-thread-start"], { lateResultGraceMs: 25 });
    await server.start();
    await expect(server.startThread(undefined, 10, () => {})).rejects.toThrow("thread/start 超时");
    expect(pendingCount(server)).toBe(1);
    await Bun.sleep(60);
    expect(pendingCount(server)).toBe(0);
    await server.stop();
  });

  test("delivers a bounded late thread result without reviving the timed-out request", async () => {
    const { server } = harness(["late-thread-start"], { lateResultGraceMs: 120 });
    const late: string[] = [];
    await server.start();
    await expect(server.startThread(undefined, 10, (threadId) => late.push(threadId)))
      .rejects.toThrow("thread/start 超时");
    await Bun.sleep(90);
    expect(late).toEqual(["thread-late"]);
    expect(pendingCount(server)).toBe(0);
    await server.stop();
  });

  test("escalates shutdown only against its stubborn owned child and completes within a bound", async () => {
    const { server, children } = harness(["stubborn"], { shutdownGraceMs: 25 });
    await server.start();
    const startedAt = Date.now();
    await server.stop();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(exited(children[0]!)).toBe(true);
  });
});
