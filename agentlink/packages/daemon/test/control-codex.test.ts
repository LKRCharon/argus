import { describe, expect, test } from "bun:test";
import { CodexPeerGateway } from "../src/control/codex";

describe("CodexPeerGateway", () => {
  test("correlates thread requests to the authenticated target peer", async () => {
    const sent: Array<{ targetNodeId: string; payload: Record<string, unknown> }> = [];
    const gateway = new CodexPeerGateway(async (targetNodeId, payload) => {
      sent.push({ targetNodeId, payload });
    }, { requestTimeoutMs: 1_000 });

    const pending = gateway.listThreads("mac-node");
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    const controlRequestId = String(sent[0].payload.controlRequestId);
    expect(sent[0]).toMatchObject({
      targetNodeId: "mac-node",
      payload: { kind: "codex-threads" },
    });

    expect(gateway.handlePayload("other-node", {
      kind: "codex-thread-list",
      controlRequestId,
      threads: [{ id: "wrong-peer" }],
    })).toBe(false);
    expect(gateway.handlePayload("mac-node", {
      kind: "codex-thread-list",
      controlRequestId,
      threads: [{ id: "thread-1", status: "idle" }],
    })).toBe(true);
    expect(await pending).toMatchObject({
      kind: "codex-thread-list",
      threads: [{ id: "thread-1" }],
    });
  });

  test("routes a remote error to the matching request", async () => {
    let sent: Record<string, unknown> | undefined;
    const gateway = new CodexPeerGateway(async (_targetNodeId, payload) => {
      sent = payload;
    }, { requestTimeoutMs: 1_000 });

    const pending = gateway.readThread("mac-node", "thread-1");
    await Promise.resolve();
    gateway.handlePayload("mac-node", {
      kind: "codex-error",
      controlRequestId: sent?.controlRequestId,
      note: "thread/resume failed",
    });
    await expect(pending).rejects.toThrow("thread/resume failed");
  });

  test("stores bounded events and filters them by thread", () => {
    const gateway = new CodexPeerGateway(async () => undefined, { maxEventsPerPeer: 2 });
    gateway.handlePayload("mac-node", {
      kind: "codex-event",
      method: "item/started",
      params: { threadId: "thread-a" },
    });
    gateway.handlePayload("mac-node", {
      kind: "codex-event",
      method: "item/completed",
      params: { threadId: "thread-b" },
    });
    gateway.handlePayload("mac-node", {
      kind: "agent-event",
      agent: "codex",
      sessionId: "thread-a",
      event: { type: "text", text: "done" },
    });

    const page = gateway.listEvents("mac-node", 0, 100);
    expect(page.events).toHaveLength(2);
    expect(page.events[0].payload).toMatchObject({ method: "item/completed" });
    expect(gateway.listEvents("mac-node", 0, 100, "thread-a").events).toHaveLength(1);
  });

  test("requires an observed approval and removes it only after target acknowledgement", async () => {
    const sent: Record<string, unknown>[] = [];
    const gateway = new CodexPeerGateway(async (_targetNodeId, payload) => {
      sent.push(payload);
    }, { requestTimeoutMs: 1_000 });

    gateway.handlePayload("mac-node", {
      kind: "permission-request",
      agent: "codex",
      sessionId: "thread-1",
      requestId: "codex-approval-1",
      toolName: "item/commandExecution/requestApproval",
      summary: "git status",
      options: [
        { id: "allow", label: "允许" },
        { id: "deny", label: "拒绝" },
      ],
    });
    expect(gateway.listApprovals("mac-node")).toHaveLength(1);

    const pending = gateway.respondApproval("mac-node", "codex-approval-1", "allow");
    await Promise.resolve();
    const response = sent.at(-1)!;
    expect(response).toMatchObject({
      kind: "permission-response",
      requestId: "codex-approval-1",
      optionId: "allow",
    });
    gateway.handlePayload("mac-node", {
      kind: "permission-response-ack",
      requestId: "codex-approval-1",
      controlRequestId: response.controlRequestId,
      status: "answered",
    });
    expect(await pending).toMatchObject({ status: "answered" });
    expect(gateway.listApprovals("mac-node")).toEqual([]);
  });

  test("rejects in-flight requests when a peer disconnects", async () => {
    const gateway = new CodexPeerGateway(async () => undefined, { requestTimeoutMs: 1_000 });
    const pending = gateway.sendInput("mac-node", "thread-1", "continue");
    await Promise.resolve();
    gateway.handleDisconnect("mac-node", new Error("relay disconnected"));
    await expect(pending).rejects.toThrow("relay disconnected");
  });
});
