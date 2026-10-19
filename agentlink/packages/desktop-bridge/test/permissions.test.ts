import { expect, test } from "bun:test";
import { DesktopBridge } from "../src/bridge";
import { Deliveries } from "../src/delivery";
import type { Message } from "../src/ipc";

function fixture(active = false, applied = true) {
  const bridge = new DesktopBridge(new Deliveries(":memory:"));
  const calls: Message[] = [];
  (bridge as any).states.set("thread", {owner:"native-owner",revision:1,state:{id:"thread",turns:active?[{turnId:"active-turn",status:"inProgress"}]:[]},view:{}});
  bridge.ipc.follow = async () => {};
  bridge.ipc.request = async (method, params, options) => {
    calls.push({method,params,options});
    if (method === "thread-owner-discovery") return {handledByClientId:"native-owner"};
    if (method === "thread-follower-update-thread-settings") return {result:{applied}};
    if (method === "thread-follower-start-turn" || method === "thread-follower-steer-turn") return {result:{result:{turnId:"new-turn"}}};
    throw new Error("Unexpected operation");
  };
  return {bridge,calls};
}

test("existing-thread send first applies native Full Access and disables model review", async () => {
  const {bridge,calls} = fixture();
  try {
    expect(await bridge.send("thread","instruction","message-id","send")).toMatchObject({state:"started"});
    expect(calls.map(call=>call.method)).toEqual(["thread-owner-discovery","thread-follower-update-thread-settings","thread-follower-start-turn"]);
    expect(calls[1]).toMatchObject({params:{threadSettings:{approvalPolicy:"never",approvalsReviewer:"user",permissions:":danger-full-access"}},options:{targetClientId:"native-owner"}});
    expect(calls[1].params.threadSettings.sandboxPolicy).toBeUndefined();
    expect(calls[2].params.turnStart.context.inheritThreadSettings).toBe(true);
  } finally { await bridge.close(); }
});

test("steer changes native active reviewer using the observed turn ID without interrupting", async () => {
  const {bridge,calls} = fixture(true);
  try {
    expect(await bridge.send("thread","additional instruction","steer-id","steer")).toMatchObject({state:"started"});
    expect(calls[1].params.activeTurnId).toBe("active-turn");
    expect(calls[2].method).toBe("thread-follower-steer-turn");
    expect(calls.some(call => /interrupt/.test(call.method))).toBe(false);
  } finally { await bridge.close(); }
});

test("permission update failure blocks delivery before any turn or model starts", async () => {
  const {bridge,calls} = fixture(false,false);
  try {
    expect(await bridge.send("thread","instruction","blocked-id","send")).toMatchObject({state:"blocked"});
    expect(calls).toHaveLength(2);
    expect(calls.some(call => call.method === "thread-follower-start-turn")).toBe(false);
  } finally { await bridge.close(); }
});

test("new project chats start with native Full Access before desktop takeover", async () => {
  const {bridge} = fixture(); const calls: Message[] = [];
  (bridge as any).rpc = async (method: string, params: Message) => {
    calls.push({method,params});
    if (method === "project/read") return {project:{roots:[{path:"/project"}]}};
    if (method === "thread/start") return {thread:{id:"new-chat"}};
    return {};
  };
  try {
    expect(await bridge.create("project-id","creation-id","title")).toMatchObject({state:"created",threadId:"new-chat"});
    expect(calls[1]).toMatchObject({method:"thread/start",params:{approvalPolicy:"never",approvalsReviewer:"user",sandbox:"danger-full-access",projectId:"project-id",cwd:"/project"}});
    expect(calls.at(-1)?.method).toBe("thread/unsubscribe");
  } finally { await bridge.close(); }
});
