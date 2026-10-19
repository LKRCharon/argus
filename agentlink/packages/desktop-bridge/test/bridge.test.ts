import { expect, test } from "bun:test";
import { DesktopBridge } from "../src/bridge";
import { Deliveries } from "../src/delivery";

test("closing or failing one subscription cannot detach another browser", async () => {
  const bridge = new DesktopBridge(new Deliveries(":memory:"));
  const events: boolean[] = [];
  Object.defineProperty(bridge.ipc, "connected", { get: () => true });
  bridge.ipc.follow = async (_id, following) => { events.push(following); };
  try {
    const first = await bridge.subscribe("thread");
    const second = await bridge.subscribe("thread");
    first(); first();
    expect(events).toEqual([true, true]);
    bridge.ipc.follow = async (_id, following) => { if (following) throw new Error("disconnected"); events.push(false); };
    await expect(bridge.subscribe("thread")).rejects.toThrow("disconnected");
    expect(events).toEqual([true, true]);
    // The remaining browser still owns its lease after the failed attempt.
    bridge.ipc.follow = async (_id, following) => { events.push(following); };
    second(); second();
    expect(events).toEqual([true, true, false]);
    const third = await bridge.subscribe("thread");
    third();
    expect(events).toEqual([true, true, false, true, false]);
  } finally { await bridge.close(); }
});
