import { describe, expect, test } from "bun:test";
import {
  __defaultReconnectSleep,
  ReconnectSupervisor,
  type Handshake,
  type ReconnectUpstream,
} from "../src/control/reconnect-supervisor";

const handshake: Handshake = { name: "agent", version: "1", protocolVersion: "1" };

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Bun.sleep(0);
};

function deferredSleep() {
  const pending: Array<() => void> = [];
  return {
    sleep: async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", finish);
          const index = pending.indexOf(finish);
          if (index >= 0) pending.splice(index, 1);
          resolve();
        };
        pending.push(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    },
    release: () => pending.shift()?.(),
  };
}

type FakeOptions = {
  close?: () => void | Promise<void>;
  loadCatalog?: () => Promise<string>;
  closeOnRegistration?: boolean;
  throwOnRegistration?: boolean;
};

type FakeUpstream = ReconnectUpstream<string> & {
  emitClose: () => void;
  closeCount: () => number;
  unsubscribeCount: () => number;
};

function fakeUpstream(catalog: string, options: FakeOptions = {}): FakeUpstream {
  let onClose: (() => void) | undefined;
  let closes = 0;
  let unsubscribes = 0;
  return {
    handshake,
    loadCatalog: options.loadCatalog ?? (async () => catalog),
    close: async () => {
      closes++;
      await options.close?.();
    },
    onClose: callback => {
      if (options.throwOnRegistration) throw new Error("registration failed");
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
}

async function readySupervisor(
  upstream: FakeUpstream,
  overrides: Partial<ConstructorParameters<typeof ReconnectSupervisor<string>>[0]> = {},
) {
  const backoff = deferredSleep();
  const supervisor = new ReconnectSupervisor<string>({
    connect: async () => upstream,
    validateHandshake: () => true,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    sleep: backoff.sleep,
    ...overrides,
  });
  supervisor.start();
  await flush();
  return supervisor;
}

describe("ReconnectSupervisor", () => {
  test("publishes a loaded generation atomically", async () => {
    const upstream = fakeUpstream("new");
    let connects = 0;
    const observations: string[] = [];
    let supervisor!: ReconnectSupervisor<string>;
    supervisor = new ReconnectSupervisor({
      connect: async () => {
        connects++;
        return upstream;
      },
      validateHandshake: () => true,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      sleep: deferredSleep().sleep,
      onStatusChanged: status => {
        if (status.state === "ready") observations.push(`status:${supervisor.currentCatalog}:${status.generation}`);
      },
      onCatalogChanged: catalog => observations.push(`catalog:${catalog}:${supervisor.currentStatus.state}`),
    });
    supervisor.start();
    supervisor.start();
    await flush();
    expect(connects).toBe(1);
    expect(observations).toEqual(["status:new:1", "catalog:new:ready"]);
    await supervisor.stop();
  });

  test("returns bounded unavailable results without queueing or replaying", async () => {
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => fakeUpstream("catalog"),
      validateHandshake: () => true,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      sleep: deferredSleep().sleep,
    });
    let calls = 0;
    expect(supervisor.withReadyUpstream("send", () => { calls++; })).toEqual({ ok: false, errorCode: "not_ready" });
    supervisor.start();
    await flush();
    expect(calls).toBe(0);
    await supervisor.stop();
    expect(supervisor.withReadyUpstream("send", () => { calls++; })).toEqual({ ok: false, errorCode: "stopped" });
    expect(calls).toBe(0);
  });

  test("allows duplicate callback invocations and contains callback exceptions", async () => {
    const supervisor = await readySupervisor(fakeUpstream("catalog"));
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
      sleep: deferredSleep().sleep,
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

  for (const [name, options] of [
    ["synchronous close", { closeOnRegistration: true }],
    ["registration failure", { throwOnRegistration: true }],
  ] as const) {
    test(`rejects a candidate with ${name} without publishing it`, async () => {
      const stable = fakeUpstream("stable");
      const candidate = fakeUpstream("candidate", options);
      let connects = 0;
      let closedStatus!: () => void;
      const closed = new Promise<void>(resolve => { closedStatus = resolve; });
      const catalogs: string[] = [];
      const statuses: string[] = [];
      const backoff = deferredSleep();
      const supervisor = await readySupervisor(stable, {
        connect: async () => (++connects === 1 ? stable : candidate),
        sleep: backoff.sleep,
        onStatusChanged: status => {
          statuses.push(`${status.state}:${status.generation}:${status.stage}`);
          if (connects > 1 && status.state === "backoff") {
            closedStatus();
            void supervisor.stop();
          }
        },
        onCatalogChanged: catalog => catalogs.push(catalog),
      });
      stable.emitClose();
      await flush();
      backoff.release();
      await closed;
      await supervisor.stop();
      expect(supervisor.currentCatalog).toBe("stable");
      expect(supervisor.currentStatus.generation).toBe(1);
      expect(catalogs).toEqual(["stable"]);
      expect(statuses).not.toContain("ready:2:ready");
      expect(candidate.closeCount()).toBe(1);
      expect(candidate.unsubscribeCount()).toBe(options.closeOnRegistration ? 1 : 0);
    });
  }

  test("makes ready-status reentrant stop calls share completed cleanup", async () => {
    const candidate = fakeUpstream("candidate");
    const catalogs: string[] = [];
    let releaseCatalog!: () => void;
    let catalogStarted!: () => void;
    const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
    const catalogStart = new Promise<void>(resolve => { catalogStarted = resolve; });
    let firstStop!: Promise<void>;
    let nestedStop!: Promise<void>;
    let resolveStopStarted!: () => void;
    const stopStarted = new Promise<void>(resolve => { resolveStopStarted = resolve; });
    let readyObserved = false;
    let supervisor!: ReconnectSupervisor<string>;
    supervisor = new ReconnectSupervisor({
      connect: async () => candidate,
      validateHandshake: () => true,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      sleep: deferredSleep().sleep,
      onCatalogChanged: catalog => catalogs.push(catalog),
      onStatusChanged: status => {
        if (status.state === "ready") {
          readyObserved = true;
          firstStop = supervisor.stop();
          resolveStopStarted();
        }
        if (status.state === "stopped") nestedStop = supervisor.close();
      },
    });
    candidate.loadCatalog = async () => {
      catalogStarted();
      await catalogGate;
      return "candidate";
    };
    supervisor.start();
    await catalogStart;
    releaseCatalog();
    await stopStarted;
    await firstStop;
    expect(firstStop).toBe(supervisor.stop());
    expect(nestedStop).toBe(firstStop);
    expect(readyObserved).toBe(true);
    expect(catalogs).toEqual([]);
    expect(candidate.unsubscribeCount()).toBe(1);
    expect(candidate.closeCount()).toBe(1);
    expect(supervisor.currentStatus.state).toBe("stopped");
  });

  test("remote close waits for one backoff despite repeated notifications", async () => {
    const first = fakeUpstream("first");
    const second = fakeUpstream("second");
    let connects = 0;
    let releaseSleep!: () => void;
    let sleepEntered!: () => void;
    const sleepGate = new Promise<void>(resolve => { releaseSleep = resolve; });
    const supervisor = await readySupervisor(first, {
      connect: async () => (++connects === 1 ? first : second),
      random: () => 1,
      sleep: async () => {
        sleepEntered();
        await sleepGate;
      },
    });
    const entered = new Promise<void>(resolve => { sleepEntered = resolve; });
    first.emitClose();
    first.emitClose();
    await entered;
    expect(connects).toBe(1);
    releaseSleep();
    await flush();
    expect(connects).toBe(2);
    await supervisor.stop();
  });

  test("stop and close share one promise and await delayed cleanup", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const upstream = fakeUpstream("catalog", { close: async () => await closeGate });
    const supervisor = await readySupervisor(upstream);
    const first = supervisor.stop();
    const second = supervisor.stop();
    const alias = supervisor.close();
    expect(second).toBe(first);
    expect(alias).toBe(first);
    let resolved = false;
    void second.then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    expect(upstream.unsubscribeCount()).toBe(1);
    releaseClose();
    await first;
    expect(resolved).toBe(true);
    expect(upstream.closeCount()).toBe(1);
  });

  test("records exact bounded exponential delays and retry times", async () => {
    const delays: number[] = [];
    const retryTimes: number[] = [];
    const releases: Array<() => void> = [];
    const entered: Array<Promise<void>> = [];
    let connects = 0;
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => {
        connects++;
        throw new Error("offline");
      },
      validateHandshake: () => true,
      baseBackoffMs: 10,
      maxBackoffMs: 25,
      random: () => 1,
      now: () => 100,
      sleep: async (milliseconds, signal) => {
        delays.push(milliseconds);
        const gate = new Promise<void>(resolve => releases.push(resolve));
        entered.push(gate);
        await Promise.race([gate, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      },
      onStatusChanged: status => {
        if (status.state === "backoff") retryTimes.push(status.nextRetryAt!);
      },
    });
    supervisor.start();
    await flush();
    expect(delays).toEqual([10]);
    releases.shift()!();
    await flush();
    expect(delays).toEqual([10, 20]);
    releases.shift()!();
    await flush();
    expect(delays).toEqual([10, 20, 25]);
    expect(retryTimes).toEqual([110, 120, 125]);
    await supervisor.stop();
    expect(connects).toBe(3);
  });

  test("terminates with a fixed error when custom sleep fails", async () => {
    let connects = 0;
    const statuses: string[] = [];
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => {
        connects++;
        throw new Error("offline");
      },
      validateHandshake: () => true,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      sleep: async () => { throw new Error("raw sleep failure"); },
      onStatusChanged: status => statuses.push(`${status.state}:${status.errorCode ?? "none"}`),
    });
    supervisor.start();
    await flush();
    expect(connects).toBe(1);
    expect(supervisor.currentStatus).toMatchObject({ state: "backoff", retryable: false, errorCode: "sleep_failed" });
    expect(statuses).not.toContain("backoff:raw sleep failure");
    await supervisor.stop();
  });

  test("validates each handshake once and treats false or throw as terminal", async () => {
    const candidate = fakeUpstream("discarded");
    let validations = 0;
    const supervisor = new ReconnectSupervisor<string>({
      connect: async () => candidate,
      validateHandshake: () => {
        validations++;
        throw new Error("invalid");
      },
      baseBackoffMs: 1,
      maxBackoffMs: 2,
    });
    supervisor.start();
    await flush();
    expect(validations).toBe(1);
    expect(supervisor.currentStatus).toMatchObject({ state: "incompatible", errorCode: "handshake_invalid" });
    await supervisor.stop();
  });

  test("default sleep removes its listener after resolution and abort", async () => {
    const makeSignal = () => {
      let aborted = false;
      const listeners = new Set<() => void>();
      let addCount = 0;
      let removeCount = 0;
      return {
        get aborted() { return aborted; },
        get addCount() { return addCount; },
        get removeCount() { return removeCount; },
        addEventListener(_type: string, listener: () => void) {
          addCount++;
          listeners.add(listener);
        },
        removeEventListener(_type: string, listener: () => void) {
          removeCount++;
          listeners.delete(listener);
        },
        abort() {
          aborted = true;
          for (const listener of listeners) listener();
        },
      } as unknown as AbortSignal & { addCount: number; removeCount: number; abort: () => void };
    };
    const resolvedSignal = makeSignal();
    await __defaultReconnectSleep(0, resolvedSignal);
    expect(resolvedSignal.addCount).toBe(1);
    expect(resolvedSignal.removeCount).toBe(1);
    resolvedSignal.abort();
    expect(resolvedSignal.removeCount).toBe(1);

    const abortedSignal = makeSignal();
    const pending = __defaultReconnectSleep(100, abortedSignal);
    abortedSignal.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedSignal.addCount).toBe(1);
    expect(abortedSignal.removeCount).toBe(1);
  });
});
