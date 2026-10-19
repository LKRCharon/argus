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

test("stream bursts coalesce without losing text, delivery completion or revision continuity", async () => {
  const deliveries = new Deliveries(":memory:"), bridge = new DesktopBridge(deliveries);
  bridge.ipc.follow = async () => {};
  const events: any[] = []; bridge.on("event", event => events.push(event));
  const emit = (change: any) => bridge.ipc.emit("broadcast", { method: "thread-stream-state-changed", version: 11, sourceClientId: "app", params: { hostId: "local", conversationId: "thread", change } });
  try {
    await bridge.subscribe("thread");
    deliveries.claim("message", "thread", "hi", "send");
    emit({ type: "snapshot", revision: 0, conversationState: { id: "thread", turns: [{ id: "turn", status: "inProgress", params: { clientUserMessageId: "message" }, items: [{ type: "agentMessage", id: "reply", text: "" }] }] } });
    for (let revision = 1; revision <= 1000; revision++) emit({ type: "patches", baseRevision: revision - 1, revision, patches: [{ op: "replace", path: ["turns", 0, "items", 0, "text"], value: "a".repeat(revision) }] });
    emit({ type: "patches", baseRevision: 1000, revision: 1001, patches: [{ op: "replace", path: ["turns", 0, "status"], value: "completed" }] });
    expect(bridge.snapshot("thread")!.revision).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 70));
    const patches = events.filter(event => event.type === "patches");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ baseRevision: 0, revision: 1001 });
    expect(bridge.snapshot("thread")!.view.turns[0].messages[0].text).toBe("a".repeat(1000));
    expect(deliveries.get("message")!.state).toBe("completed");
  } finally { await bridge.close(); }
});
