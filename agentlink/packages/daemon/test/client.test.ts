import { expect, test } from "bun:test";
import { joinChan, type WsConn } from "../src/client";

function recordingConnection(frames: Record<string, unknown>[]): WsConn {
  return {
    send(frame: Record<string, unknown>) {
      frames.push(frame);
    },
    async wait() {
      return { op: "chan-joined" };
    },
  } as unknown as WsConn;
}

test("joinChan distinguishes host and Android endpoints", async () => {
  const frames: Record<string, unknown>[] = [];
  const key = new Uint8Array(32).fill(7);

  await joinChan(recordingConnection(frames), key);
  await joinChan(recordingConnection(frames), key, "android");

  expect(frames.map((frame) => frame.endpoint)).toEqual(["host", "android"]);
});
