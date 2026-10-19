import { expect, test } from "bun:test";
import { applyPatches, desktopTurns, publicState, textInput, viewDiff } from "../src/state";
import { Deliveries } from "../src/delivery";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("canonical history preserves island order and updates streamed text", () => {
  const state = { id: "test", turnHistory: { kind: "canonical", history: { entitiesByKey: { b: { turnId: "new", items: [{ id: "a", type: "agentMessage", text: "初" }] }, a: { turnId: "old", items: [] } }, islands: [{ entries: [{ value: "a" }, { value: "b" }] }] } } };
  applyPatches(state, [{ op: "replace", path: ["turnHistory", "history", "entitiesByKey", "b", "items", 0, "text"], value: "初始回复" }]);
  expect(desktopTurns(state).map(turn => turn.turnId)).toEqual(["old", "new"]);
  expect(publicState(state).turns.at(-1).messages[0].text).toBe("初始回复");
  expect(() => applyPatches(state, [{ op: "add", path: ["__proto__", "polluted"], value: true }])).toThrow();
});

test("desktop text input includes spans required by optimistic rendering", () => {
  expect(textInput("你好")[0].text_elements.some((span: unknown) => Boolean(span))).toBe(false);
});

test("persistent delivery IDs reject a changed payload and never dispatch duplicates", () => {
  const journal = new Deliveries(":memory:");
  expect(journal.claim("one", "thread", "你好", "send").fresh).toBe(true);
  journal.update("one", "started", "turn-one");
  expect(journal.claim("one", "thread", "你好", "send")).toMatchObject({ fresh: false, delivery: { state: "started", turnId: "turn-one" } });
  expect(() => journal.claim("one", "different-thread", "你好", "send")).toThrow();
  journal.close();
});

test("streaming replies transmit only appended text", () => {
  const text = "已有回复内容".repeat(1000);
  const patches = viewDiff({ text }, { text: text + "新内容" });
  expect(patches).toEqual([{ op: "append", path: ["text"], value: "新内容" }]);
  expect(JSON.stringify(patches).length).toBeLessThan(100);
});

test("steering is shown once and only confirmed submissions update delivery", () => {
  const input = textInput("new instruction");
  const pending = {id:"optimistic",type:"steeringUserMessage",clientUserMessageId:"steer-id",input,status:"pending"};
  const state = {turns:[{turnId:"active-turn",status:"inProgress",items:[pending]}]};
  expect(publicState(state).turns[0].messages.map((message: any) => message.text)).toEqual(["new instruction"]);
  const journal = new Deliveries(":memory:");
  try {
    journal.claim("steer-id","thread","new instruction","steer"); journal.update("steer-id","dispatching");
    journal.observe(state.turns);
    expect(journal.get("steer-id")!.state).toBe("dispatching");
    const confirmed = {id:"server",type:"userMessage",clientId:"steer-id",content:input};
    state.turns[0].items.push(confirmed as any);
    expect(publicState(state).turns[0].messages.length).toBe(1);
    journal.observe(state.turns);
    expect(journal.get("steer-id")).toMatchObject({state:"started",turnId:"active-turn"});
  } finally { journal.close(); }
});

test("a restarted bridge preserves uncertain deliveries and creation identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "argus-delivery-test-"));
  try {
    const path = join(directory, "deliveries.sqlite");
    let journal = new Deliveries(path);
    journal.claim("uncertain", "thread", "message", "send"); journal.update("uncertain", "dispatching");
    journal.claimCreation("creating", "project"); journal.updateCreation("creating", "creating", "allocated-thread");
    journal.claimCreation("created", "project"); journal.updateCreation("created", "created", "ready-thread");
    journal.close(); journal = new Deliveries(path);
    expect(journal.claim("uncertain", "thread", "message", "send")).toMatchObject({fresh:false,delivery:{state:"unknown"}});
    expect(journal.claimCreation("creating", "project")).toMatchObject({fresh:false,creation:{state:"unknown",threadId:"allocated-thread"}});
    expect(journal.claimCreation("created", "project")).toMatchObject({fresh:false,creation:{state:"created",threadId:"ready-thread"}});
    expect(() => journal.claimCreation("created", "other-project")).toThrow(); journal.close();
  } finally { rmSync(directory, {recursive:true,force:true}); }
});

test("only a delivery blocked before dispatch can be explicitly retried", () => {
  const journal = new Deliveries(":memory:");
  journal.claim("blocked", "thread", "message", "send"); journal.update("blocked", "blocked");
  expect(journal.claim("blocked", "thread", "message", "send").fresh).toBe(true);
  expect(journal.claim("blocked", "thread", "message", "send").fresh).toBe(false);
  journal.update("blocked", "unknown");
  expect(journal.claim("blocked", "thread", "message", "send").fresh).toBe(false);
  journal.close();
});
