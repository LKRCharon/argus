import { describe, expect, test } from "bun:test";
import { ReconnectSupervisor, type Handshake, type ReconnectUpstream } from "../src/control/reconnect-supervisor";

const handshake: Handshake = { name: "agent", version: "1", protocolVersion: "1" };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };

function upstream(catalog: string, onClose = () => {}, close = () => {}) : ReconnectUpstream<string> {
  return { handshake, loadCatalog: async () => catalog, close, onClose: callback => { onClose = callback; return () => { onClose = () => {}; }; } };
}

describe("ReconnectSupervisor", () => {
  test("coalesces concurrent starts and publishes atomically", async () => {
    const gate = deferred<ReconnectUpstream<string>>(); let connects = 0; const catalogs: string[] = [];
    const supervisor = new ReconnectSupervisor({ connect: async () => { connects++; return gate.promise; }, validateHandshake: () => true, baseBackoffMs: 10, maxBackoffMs: 100, sleep: async () => {}, onCatalogChanged: c => catalogs.push(c) });
    supervisor.start(); supervisor.start(); gate.resolve(upstream("new"));
    await Bun.sleep(0); await Bun.sleep(0);
    expect(connects).toBe(1); expect(catalogs).toEqual(["new"]); await supervisor.stop();
  });

  test("bounds jittered retry and reaches incompatible", async () => {
    const delays: number[] = []; let calls = 0;
    const supervisor = new ReconnectSupervisor({ connect: async () => { calls++; throw new Error("offline"); }, validateHandshake: () => false, baseBackoffMs: 10, maxBackoffMs: 25, random: () => 1, now: () => 100, sleep: async (ms, signal) => { delays.push(ms); signal.throwIfAborted(); if (calls > 2) supervisor.stop(); } });
    supervisor.start(); await Bun.sleep(0); await Bun.sleep(0); expect(delays[0]).toBe(10); expect(delays[1]).toBe(20); expect(delays[2]).toBe(25); await supervisor.stop();
    const incompatible = new ReconnectSupervisor({ connect: async () => upstream("x"), validateHandshake: () => false, baseBackoffMs: 1, maxBackoffMs: 2 }); incompatible.start(); await Bun.sleep(0); expect(incompatible.currentStatus.state).toBe("incompatible"); await incompatible.stop();
  });

  test("reconnects once after close, no replay, and contains callback exceptions", async () => {
    let close!: () => void; let connects = 0; let statusCalls = 0; const seen: string[] = [];
    const supervisor = new ReconnectSupervisor({ connect: async () => { connects++; return { ...upstream(String(connects)), onClose: callback => { close = callback; return () => {}; } }; }, validateHandshake: () => true, baseBackoffMs: 1, maxBackoffMs: 2, sleep: async () => {}, onCatalogChanged: c => { seen.push(c); throw new Error("observer"); }, onStatusChanged: () => { statusCalls++; throw new Error("observer"); } });
    supervisor.start(); await Bun.sleep(0); await Bun.sleep(0); let callbacks = 0; const callback = () => { callbacks++; throw new Error("consumer"); }; supervisor.withReadyUpstream("send", callback); supervisor.withReadyUpstream("send", callback); expect(callbacks).toBe(1); close(); close(); await Bun.sleep(0); await Bun.sleep(0); expect(connects).toBe(2); expect(seen).toEqual(["1", "2"]); expect(statusCalls).toBeGreaterThan(0); await supervisor.stop();
  });

  test("preserves the published catalog when a reconnect cannot load one", async () => {
    let close!: () => void; let connects = 0; let stop!: () => Promise<void>; const errors: string[] = [];
    const supervisor = new ReconnectSupervisor({ connect: async () => {
      connects++;
      if (connects === 1) return { ...upstream("stable"), onClose: callback => { close = callback; return () => {}; } };
      return { ...upstream("discarded"), loadCatalog: async () => { throw new Error("load failed"); } };
    }, validateHandshake: () => true, baseBackoffMs: 1, maxBackoffMs: 1, sleep: async (_milliseconds, signal) => await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })), onStatusChanged: status => { if (status.errorCode) errors.push(status.errorCode); } });
    stop = supervisor.stop.bind(supervisor); supervisor.start(); await Bun.sleep(0); await Bun.sleep(0); expect(supervisor.currentCatalog).toBe("stable"); close(); await Bun.sleep(0); await Bun.sleep(0); expect(supervisor.currentCatalog).toBe("stable"); expect(errors).toContain("catalog_load_failed"); await supervisor.stop();
  });

  test("stop during backoff closes and unsubscribes exactly once", async () => {
    let closed = 0; let unsubscribed = 0; const supervisor = new ReconnectSupervisor({ connect: async () => ({ ...upstream("x", undefined, () => closed++), onClose: () => () => { unsubscribed++; } }), validateHandshake: () => true, baseBackoffMs: 10, maxBackoffMs: 20, sleep: async (_ms, signal) => await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) });
    supervisor.start(); await Bun.sleep(0); await supervisor.stop(); expect(supervisor.currentStatus.state).toBe("stopped"); expect(closed).toBe(1); expect(unsubscribed).toBe(1);
  });
});
