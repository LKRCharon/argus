import { expect, test } from "bun:test";
import { SecureChannel } from "@agentlink/wire";
import type { WsConn } from "../src/client";
import { CodexAppServer } from "../src/codex-appserver";
import { serveWatch } from "../src/watcher/serve";

type Frame = { op: "chan-data"; data: { enc: string } };

class FakeConn {
  readonly sent: Frame[] = [];
  private readonly queue: Frame[] = [];
  private waiter: ((frame: Frame) => void) | undefined;

  send(frame: Frame): void {
    this.sent.push(frame);
  }

  wait(): Promise<Frame> {
    const frame = this.queue.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  push(frame: Frame): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }
}

function fakeServer(state: { turns: number; stopped: boolean; concurrent: number; maxConcurrent: number }, startThreadDelay = 60): CodexAppServer {
  const server = {
    async start() {},
    async stop() { state.stopped = true; },
    async startThread(
      _cwd: string,
      timeoutMs: number,
      onLateThread?: (threadId: string) => void,
    ): Promise<string> {
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      try {
        if (startThreadDelay > timeoutMs) {
          await Bun.sleep(timeoutMs);
          setTimeout(() => onLateThread?.("late-thread"), 10);
          throw new Error("thread/start 超时");
        }
        await Bun.sleep(startThreadDelay);
        return "new-thread";
      } finally {
        state.concurrent -= 1;
      }
    },
    async startTurn(): Promise<string> {
      state.turns += 1;
      return "unexpected-turn";
    },
    async resume(): Promise<{ canAcceptDirectInput: boolean }> {
      return { canAcceptDirectInput: true };
    },
    async listThreads(): Promise<unknown[]> {
      return [{ id: "following-thread" }];
    },
  } as unknown as CodexAppServer;
  return server;
}

async function waitFor<T>(items: T[], predicate: (item: T) => boolean | Promise<boolean>): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 500) {
    for (const item of items) {
      if (await predicate(item)) return item;
    }
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for watcher response");
}

test("serveWatch releases its receive loop across an ambiguous Codex new-session timeout", async () => {
  const conn = new FakeConn();
  const chan = new SecureChannel(new Uint8Array(32).fill(9));
  const state = { turns: 0, stopped: false, concurrent: 0, maxConcurrent: 0 };
  const server = fakeServer(state);
  const encoded = async (payload: Record<string, unknown>): Promise<Frame> => ({
    op: "chan-data",
    data: { enc: await chan.seal(payload) },
  });
  const decode = async (frame: Frame): Promise<Record<string, unknown>> => chan.open(frame.data.enc);

  const controls = await serveWatch(conn as unknown as WsConn, chan, {
    meshStrict: true,
    meshRemoteCodexControl: true,
    codexServerFactory: () => server,
  });
  const controlRequestId = "codex:watcher-lifecycle";
  conn.push(await encoded({
    kind: "new-session",
    agent: "codex",
    text: "do not send a turn",
    controlRequestId,
    deadlineAt: Date.now() + 25,
  }));
  conn.push(await encoded({
    kind: "codex-threads",
    controlRequestId: "codex:following-request",
    deadlineAt: Date.now() + 300,
  }));

  const following = await waitFor(conn.sent, async (frame) =>
    (await decode(frame)).kind === "codex-thread-list");
  expect(await decode(following)).toMatchObject({
    kind: "codex-thread-list",
    controlRequestId: "codex:following-request",
    threads: [{ id: "following-thread" }],
  });

  const timeout = await waitFor(conn.sent, async (frame) => {
    const payload = await decode(frame);
    return payload.kind === "codex-error" && payload.controlRequestId === controlRequestId;
  });
  expect(await decode(timeout)).toMatchObject({
    kind: "codex-error",
    controlRequestId,
    timedOut: true,
    timedOutStage: "app-server",
  });

  const late = await waitFor(conn.sent, async (frame) => (await decode(frame)).lateAfterTimeout === true);
  expect(await decode(late)).toMatchObject({
    kind: "input-ack",
    controlRequestId,
    sessionId: "late-thread",
    lateAfterTimeout: true,
  });
  expect(state.turns).toBe(0);
  controls.stop();
  expect(state.stopped).toBe(true);
});

test("serveWatch returns a correlated new-session acknowledgement with its thread id", async () => {
  const conn = new FakeConn();
  const chan = new SecureChannel(new Uint8Array(32).fill(8));
  const state = { turns: 0, stopped: false, concurrent: 0, maxConcurrent: 0 };
  const server = fakeServer(state, 0);
  const controls = await serveWatch(conn as unknown as WsConn, chan, {
    meshStrict: true,
    meshRemoteCodexControl: true,
    codexServerFactory: () => server,
  });
  conn.push({
    op: "chan-data",
    data: { enc: await chan.seal({
      kind: "new-session",
      agent: "codex",
      text: "start",
      controlRequestId: "codex:new-session",
      deadlineAt: Date.now() + 300,
    }) },
  });
  const ack = await waitFor(conn.sent, async (frame) => {
    const payload = await chan.open<Record<string, unknown>>(frame.data.enc);
    return payload.kind === "input-ack" && payload.controlRequestId === "codex:new-session";
  });
  expect(await chan.open(ack.data.enc)).toMatchObject({
    kind: "input-ack",
    controlRequestId: "codex:new-session",
    sessionId: "new-thread",
    status: "running",
  });
  expect(state.turns).toBe(1);
  controls.stop();
});

test("serveWatch keeps non-start Codex commands ordered", async () => {
  const conn = new FakeConn();
  const chan = new SecureChannel(new Uint8Array(32).fill(7));
  const state = { turns: 0, stopped: false, concurrent: 0, maxConcurrent: 0 };
  const server = fakeServer(state, 20);
  const controls = await serveWatch(conn as unknown as WsConn, chan, {
    meshStrict: true,
    meshRemoteCodexControl: true,
    codexServerFactory: () => server,
  });
  const request = async (controlRequestId: string, text: string): Promise<void> => {
    conn.push({ op: "chan-data", data: { enc: await chan.seal({
      kind: "codex-input",
      sessionId: "thread-ordered",
      text,
      controlRequestId,
      deadlineAt: Date.now() + 500,
    }) } });
  };
  await request("codex:input-1", "first");
  await request("codex:input-2", "second");
  const acks = new Set<string>();
  await waitFor(conn.sent, async (frame) => {
    const payload = await chan.open<Record<string, unknown>>(frame.data.enc);
    if (payload.kind === "input-ack" && payload.controlRequestId) acks.add(String(payload.controlRequestId));
    return acks.size === 2;
  });
  expect([...acks]).toEqual(["codex:input-1", "codex:input-2"]);
  expect(state.turns).toBe(2);
  controls.stop();
});

test("serveWatch bounds background Codex starts and handles stop without rejection", async () => {
  const conn = new FakeConn();
  const chan = new SecureChannel(new Uint8Array(32).fill(6));
  const state = { turns: 0, stopped: false, concurrent: 0, maxConcurrent: 0 };
  const server = fakeServer(state, 80);
  const controls = await serveWatch(conn as unknown as WsConn, chan, {
    meshStrict: true,
    meshRemoteCodexControl: true,
    codexServerFactory: () => server,
  });
  for (let index = 1; index <= 3; index += 1) {
    conn.push({ op: "chan-data", data: { enc: await chan.seal({
      kind: "new-session",
      agent: "codex",
      text: `start-${index}`,
      controlRequestId: `codex:start-${index}`,
      deadlineAt: Date.now() + 500,
    }) } });
  }
  const overloaded = await waitFor(conn.sent, async (frame) => {
    const payload = await chan.open<Record<string, unknown>>(frame.data.enc);
    return payload.code === "codex-start-overloaded";
  });
  expect(await chan.open(overloaded.data.enc)).toMatchObject({
    kind: "codex-error",
    controlRequestId: "codex:start-3",
    timedOut: false,
    retryable: true,
  });
  expect(state.maxConcurrent).toBe(2);
  controls.stop();
  await Bun.sleep(120);
  expect(state.stopped).toBe(true);
});
