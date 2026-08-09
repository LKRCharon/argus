import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTIONS, RelayCore, type Client } from "../src/relay";

/** Records what the relay sent to one side. */
function fakeClient(id: number, ip = "1.2.3.4"): Client & { sent: any[]; closes: Array<[number | undefined, string | undefined]> } {
  const sent: any[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  return {
    id,
    ip,
    sent,
    closes,
    send: (data: string) => {
      try {
        sent.push(JSON.parse(data));
      } catch {
        sent.push(data);
      }
    },
    close: (code, reason) => closes.push([code, reason]),
  };
}

const TOKEN = "0123456789abcdef0123";

describe("relay channel buffering", () => {
  test("a reconnecting client is not handed its own backlog", () => {
    // The bug: the buffer did not record who queued a frame, so it went to
    // whoever joined next. A phone that reconnected after a blip got its own
    // messages back — and since delivery drains the buffer, the daemon never
    // saw them at all.
    const core = new RelayCore();
    const phone = fakeClient(1);

    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN }));
    core.handleMessage(phone, JSON.stringify({ op: "chan-data", data: { from: "phone" } }));

    // Phone drops and comes back.
    core.handleClose(phone);
    const phoneAgain = fakeClient(2);
    core.handleMessage(phoneAgain, JSON.stringify({ op: "join-chan", token: TOKEN }));

    const echoed = phoneAgain.sent.filter((m) => m.op === "chan-data");
    expect(echoed).toHaveLength(0);

    // And the message is still waiting for the other side.
    const mac = fakeClient(3, "5.6.7.8");
    core.handleMessage(mac, JSON.stringify({ op: "join-chan", token: TOKEN }));
    const delivered = mac.sent.filter((m) => m.op === "chan-data");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].data).toEqual({ from: "phone" });
    expect(delivered[0].buffered).toBe(true);
  });

  test("the other side still receives what was buffered for it", () => {
    const core = new RelayCore();
    const mac = fakeClient(1, "5.6.7.8");
    core.handleMessage(mac, JSON.stringify({ op: "join-chan", token: TOKEN }));
    core.handleMessage(mac, JSON.stringify({ op: "chan-data", data: { event: 1 } }));

    const phone = fakeClient(2);
    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN }));
    expect(phone.sent.filter((m) => m.op === "chan-data")).toHaveLength(1);
  });

  test("named endpoints keep buffered direction when both sides reconnect", () => {
    // Arrival order alone is insufficient: after both transports go away, the
    // phone can reconnect before the Host. The relay must still know that the
    // Host's backlog belongs to Android, not hand it back to the Host later.
    const core = new RelayCore();
    const host = fakeClient(1, "5.6.7.8");
    core.handleMessage(host, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "host" }));
    core.handleMessage(host, JSON.stringify({ op: "chan-data", data: { from: "host" } }));
    core.handleClose(host);

    const phone = fakeClient(2);
    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "android" }));
    expect(phone.sent.filter((m) => m.op === "chan-data").map((m) => m.data)).toEqual([{ from: "host" }]);
    core.handleMessage(phone, JSON.stringify({ op: "chan-data", data: { from: "android" } }));
    core.handleClose(phone);

    const hostAgain = fakeClient(3, "5.6.7.8");
    core.handleMessage(hostAgain, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "host" }));
    expect(hostAgain.sent.filter((m) => m.op === "chan-data").map((m) => m.data)).toEqual([{ from: "android" }]);
  });

  test("a reconnect replaces a stale transport for the same named endpoint", () => {
    const core = new RelayCore();
    const oldHost = fakeClient(1, "5.6.7.8");
    const phone = fakeClient(2);
    core.handleMessage(oldHost, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "host" }));
    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "android" }));

    const hostAgain = fakeClient(3, "5.6.7.8");
    core.handleMessage(hostAgain, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "host" }));
    expect(oldHost.closes).toEqual([[4001, "replaced by reconnect"]]);
    core.handleMessage(phone, JSON.stringify({ op: "chan-data", data: { to: "host" } }));
    expect(hostAgain.sent.filter((m) => m.op === "chan-data").map((m) => m.data)).toEqual([{ to: "host" }]);
    expect(oldHost.sent.filter((m) => m.op === "chan-data")).toHaveLength(0);
  });

  test("peer departure is announced without exposing channel data in stats", () => {
    const core = new RelayCore();
    const host = fakeClient(1, "5.6.7.8");
    const phone = fakeClient(2);
    core.handleMessage(host, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "host" }));
    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "android" }));

    core.handleClose(phone);

    expect(host.sent.filter((m) => m.op === "chan-peer-left")).toHaveLength(1);
    const stats = core.stats();
    expect(stats).toMatchObject({
      channels: 1,
      connectedClients: 1,
      bufferedFrames: 0,
      receivedMessages: 2,
    });
    expect(Object.keys(stats)).not.toContain("token");
    expect(Object.keys(stats)).not.toContain("payload");
  });

  test("join-chan is rate limited", () => {
    // Unmetered, one connection could mint an unbounded number of channels.
    const core = new RelayCore({ ...DEFAULT_OPTIONS, pairLimitPerMin: 3 });
    const client = fakeClient(1);
    for (let i = 0; i < 5; i++) {
      core.handleMessage(client, JSON.stringify({ op: "join-chan", token: `${TOKEN}${i}` }));
    }
    const limited = client.sent.filter((m) => m.op === "error" && m.code === "rate-limited");
    expect(limited.length).toBeGreaterThan(0);
  });

  test("rejoining an existing channel is not rate limited", () => {
    const core = new RelayCore({ ...DEFAULT_OPTIONS, pairLimitPerMin: 1 });
    const first = fakeClient(1);
    core.handleMessage(first, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "android" }));
    core.handleClose(first);

    for (let id = 2; id < 8; id++) {
      const phone = fakeClient(id);
      core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN, endpoint: "android" }));
      expect(phone.sent.some((m) => m.op === "error" && m.code === "rate-limited")).toBe(false);
      core.handleClose(phone);
    }
  });

  test("a full channel rejects a third member", () => {
    const core = new RelayCore();
    const a = fakeClient(1);
    const b = fakeClient(2, "2.2.2.2");
    const c = fakeClient(3, "3.3.3.3");
    for (const cl of [a, b, c]) {
      core.handleMessage(cl, JSON.stringify({ op: "join-chan", token: TOKEN }));
    }
    expect(c.sent.some((m) => m.op === "error" && m.code === "chan-full")).toBe(true);
  });

});
