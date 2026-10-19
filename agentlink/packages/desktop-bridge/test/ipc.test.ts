import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameReader } from "../src/ipc";

describe("desktop IPC framing", () => {
  test("decodes fragmented Chinese and consecutive frames without losing byte boundaries", () => {
    const messages = [{ type: "broadcast", params: { text: "Mac 执行，网页显示" } }, { type: "response", requestId: "two" }];
    const bytes = Buffer.concat(messages.map(encodeFrame));
    const reader = new FrameReader();
    const received: unknown[] = [];
    for (const byte of bytes) reader.push(Buffer.from([byte]), message => received.push(message));
    expect(received).toEqual(messages);
  });

  test("rejects excessive frame lengths before buffering their bodies", () => {
    const header = Buffer.alloc(4); header.writeUInt32LE(64 * 1024 * 1024 + 1);
    expect(() => new FrameReader().push(header, () => {})).toThrow("frame size");
  });
});
