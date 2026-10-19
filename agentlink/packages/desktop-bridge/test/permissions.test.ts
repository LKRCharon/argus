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
    expect(method).toBe("project/read");
    return {project:{roots:[{path:"/project"}]}};
  };
  (bridge as any).creatorFactory = () => ({
    start:async()=>{},
    call:async(method:string,params:Message)=>{calls.push({method,params});return method==="thread/start"?{thread:{id:"new-chat"}}:{};},
    stop:async()=>{calls.push({method:"creator-exited"});},
  });
  try {
    expect(await bridge.create("project-id","creation-id","title")).toMatchObject({state:"created",threadId:"new-chat"});
    expect(calls[1]).toMatchObject({method:"thread/start",params:{approvalPolicy:"never",approvalsReviewer:"user",sandbox:"danger-full-access",projectId:"project-id",cwd:"/project"}});
    expect(calls.slice(-2).map(call=>call.method)).toEqual(["thread/unsubscribe","creator-exited"]);
  } finally { await bridge.close(); }
});

test("a failed creation closes its writer and keeps an uncertain ID from being dispatched twice", async () => {
  const {bridge} = fixture(); let starts=0, exits=0;
  (bridge as any).rpc = async () => ({project:{roots:[{path:"/project"}]}});
  (bridge as any).creatorFactory = () => ({start:async()=>{},call:async()=>{starts++;throw new Error("response timed out");},stop:async()=>{exits++;}});
  try {
    expect(await bridge.create("project-id","uncertain-creation","title")).toMatchObject({state:"unknown"});
    expect(exits).toBe(1);
    expect(await bridge.create("project-id","uncertain-creation","title")).toMatchObject({state:"unknown"});
    expect(starts).toBe(1);
  } finally {await bridge.close();}
});
