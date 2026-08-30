import { describe, expect, test } from "bun:test";
import {
  ReconnectSupervisor,
  type Handshake,
  type ReconnectUpstream,
} from "../src/control/reconnect-supervisor";

const handshake: Handshake = {
  name: "agent",
  version: "1",
  protocolVersion: "1",
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Bun.sleep(0);
};

type FakeUpstream = ReconnectUpstream<string> & {
  emitClose: () => void;
  closeCount: () => number;
  unsubscribeCount: () => number;
};

function fakeUpstream(
  catalog: string,
  options: {
    close?: () => void | Promise<void>;
    loadCatalog?: () => Promise<string>;
    closeOnRegistration?: boolean;
  } = {},
): FakeUpstream {
  let onClose: (() => void) | undefined;
  let closes = 0;
  let unsubscribes = 0;
  const value: FakeUpstream = {
    handshake,
    loadCatalog: options.loadCatalog ?? (async () => catalog),
    close: async () => {
      closes++;
      await options.close?.();
    },
    onClose: callback => {
      onClose = callback;
      if (options.closeOnRegistration) callback();
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        unsubscribes++;
        onClose = undefined;
      };
    },
    emitClose: () => onClose?.(),
    closeCount: () => closes,
    unsubscribeCount: () => unsubscribes,
  };
  return value;
}

async function readySupervisor(
  upstream: FakeUpstream,
  overrides: Partial<ConstructorParameters<typeof ReconnectSupervisor<string>>[0]> = {},
) {
  const supervisor = new ReconnectSupervisor<string>({
    connect: async () => upstream,
    validateHandshake: () => true,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    sleep: async () => {},
    ...overrides,
  });
  supervisor.start();
  await flush();
  return supervisor;
}

describe("ReconnectSupervisor", () => {
  test("coalesces starts and publishes a fully loaded generation atomically", async () => {
    const upstream = fakeUpstream("new");
    let connects = 0;
    const observations: string[] = [];
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => {
        connects++;
        return upstream;
      },
      validateHandshake: () => true,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      sleep: async () => {},
      onStatusChanged: status => {
        if (status.state === "ready") {
          observations.push(`status:${supervisor.currentCatalog}:${supervisor.currentStatus.state}`);
        }
      },
      onCatalogChanged: catalog => {
        observations.push(`catalog:${catalog}:${supervisor.currentStatus.state}`);
      },
    });

    supervisor.start();
    supervisor.start();
    await flush();

    expect(connects).toBe(1);
    expect(observations).toEqual(["status:new:ready", "catalog:new:ready"]);
    await supervisor.stop();
  });

  test("returns immediately while unavailable and never replays an operation", async () => {
    const upstream = fakeUpstream("catalog");
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => upstream,
      validateHandshake: () => true,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      sleep: async () => {},
    });
    let calls = 0;
    expect(supervisor.withReadyUpstream("send", () => { calls++; })).toEqual({
      ok: false,
      errorCode: "not_ready",
    });

    supervisor.start();
    await flush();
    expect(calls).toBe(0);
    await supervisor.stop();
    expect(supervisor.withReadyUpstream("send", () => { calls++; })).toEqual({
      ok: false,
      errorCode: "stopped",
    });
    expect(calls).toBe(0);
  });

  test("duplicate callback invocations are independent and exceptions are contained", async () => {
    const upstream = fakeUpstream("catalog");
    const supervisor = await readySupervisor(upstream);
    let calls = 0;
    const callback = () => {
      calls++;
      throw new Error("consumer failure");
    };

    expect(supervisor.withReadyUpstream("send", callback)).toEqual({ ok: true, generation: 1 });
    expect(supervisor.withReadyUpstream("send", callback)).toEqual({ ok: true, generation: 1 });
    expect(calls).toBe(2);
    await supervisor.stop();
  });

  test("does not replay after generation loss during callback execution", async () => {
    const first = fakeUpstream("first");
    const second = fakeUpstream("second");
    let connects = 0;
    const supervisor = await readySupervisor(first, {
      connect: async () => (++connects === 1 ? first : second),
      sleep: async () => {},
    });
    let calls = 0;
    const result = supervisor.withReadyUpstream("send", active => {
      calls++;
      active.close();
      first.emitClose();
    });

    expect(result).toEqual({ ok: true, generation: 1 });
    expect(calls).toBe(1);
    await flush();
    expect(calls).toBe(1);
    await supervisor.stop();
  });

  test("registers synchronous close safely and follows one reconnect path", async () => {
    const first = fakeUpstream("first", { closeOnRegistration: true });
    const second = fakeUpstream("second");
    let connects = 0;
    let sleeps = 0;
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => (++connects === 1 ? first : second),
      validateHandshake: () => true,
      baseBackoffMs: 10,
      maxBackoffMs: 20,
      random: () => 1,
      sleep: async () => { sleeps++; },
    });
    supervisor.start();
    await flush();
    expect(connects).toBe(2);
    expect(sleeps).toBe(1);
    expect(supervisor.currentCatalog).toBe("second");
    await supervisor.stop();
  });

  test("remote close waits for backoff and duplicate notifications schedule once", async () => {
    const first = fakeUpstream("first");
    const second = fakeUpstream("second");
    let connects = 0;
    let releaseSleep!: () => void;
    let sleepStarted!: () => void;
    const sleepGate = new Promise<void>(resolve => { releaseSleep = resolve; });
    const supervisor = await readySupervisor(first, {
      connect: async () => (++connects === 1 ? first : second),
      random: () => 1,
      sleep: async () => {
        sleepStarted();
        await sleepGate;
      },
    });
    const started = new Promise<void>(resolve => { sleepStarted = resolve; });
    first.emitClose();
    first.emitClose();
    await started;
    expect(connects).toBe(1);
    releaseSleep();
    await flush();
    expect(connects).toBe(2);
    await supervisor.stop();
  });

  test("cleans close, unsubscribe, and abort paths exactly once", async () => {
    let aborts = 0;
    const upstream = fakeUpstream("catalog", {
      close: async () => {},
    });
    const supervisor = await readySupervisor(upstream, {
      sleep: async (_milliseconds, signal) => {
        signal.addEventListener("abort", () => { aborts++; }, { once: true });
        if (signal.aborted) return;
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    upstream.emitClose();
    upstream.emitClose();
    await flush();
    await supervisor.stop();
    expect(upstream.closeCount()).toBe(1);
    expect(upstream.unsubscribeCount()).toBe(1);
    expect(aborts).toBe(1);
  });

  test("preserves the last known-good catalog through reconnect and catalog failure", async () => {
    const first = fakeUpstream("stable");
    let connects = 0;
    let sleeps = 0;
    const errors: string[] = [];
    let catalogFailure!: () => void;
    const catalogFailureSeen = new Promise<void>(resolve => { catalogFailure = resolve; });
    const supervisor = await readySupervisor(first, {
      connect: async () => {
        connects++;
        if (connects === 1) return first;
        return fakeUpstream("discarded", {
          loadCatalog: async () => { throw new Error("raw failure must stay hidden"); },
        });
      },
      sleep: async (_milliseconds, signal) => {
        sleeps++;
        if (sleeps === 1) return;
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      onStatusChanged: status => {
        if (status.errorCode) {
          errors.push(status.errorCode);
          if (status.errorCode === "catalog_load_failed") catalogFailure();
        }
      },
    });
    expect(supervisor.currentCatalog).toBe("stable");
    first.emitClose();
    await catalogFailureSeen;
    expect(supervisor.currentCatalog).toBe("stable");
    expect(errors).toContain("catalog_load_failed");
    await supervisor.stop();
  });

  test("bounds jitter and exponential backoff", async () => {
    const delays: number[] = [];
    let connects = 0;
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => {
        connects++;
        throw new Error("offline");
      },
      validateHandshake: () => true,
      baseBackoffMs: 10,
      maxBackoffMs: 25,
      random: () => 2,
      now: () => 100,
      sleep: async (milliseconds, signal) => {
        delays.push(milliseconds);
        if (connects >= 3) supervisor.stop();
        signal.throwIfAborted();
      },
    });
    supervisor.start();
    await supervisor.stop();
    expect(delays.every(delay => delay >= 0 && delay <= 25)).toBe(true);
  });

  test("stop during an active backoff cancels sleep and prevents connect", async () => {
    let connects = 0;
    let sleepStarted!: () => void;
    let aborted = 0;
    const started = new Promise<void>(resolve => { sleepStarted = resolve; });
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => {
        connects++;
        throw new Error("offline");
      },
      validateHandshake: () => true,
      baseBackoffMs: 100,
      maxBackoffMs: 100,
      random: () => 1,
      sleep: async (_milliseconds, signal) => {
        sleepStarted();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => {
          aborted++;
          resolve();
        }, { once: true }));
      },
    });
    supervisor.start();
    await started;
    await supervisor.stop();
    expect(supervisor.currentStatus.state).toBe("stopped");
    expect(connects).toBe(1);
    expect(aborted).toBe(1);
  });

  test("incompatible handshake is terminal and exposes only a fixed error code", async () => {
    const upstream = fakeUpstream("discarded");
    let closeCount = 0;
    upstream.close = () => { closeCount++; };
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => upstream,
      validateHandshake: () => false,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
    });
    supervisor.start();
    await flush();
    expect(supervisor.currentStatus).toMatchObject({
      state: "incompatible",
      retryable: false,
      errorCode: "handshake_invalid",
    });
    expect(supervisor.currentStatus.stage).toBe("handshake");
    expect(closeCount).toBe(1);
    await supervisor.stop();
  });
});
