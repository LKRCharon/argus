import { afterAll, describe, expect, test } from "bun:test";
import { createRelayServer } from "../../relay/src/server";
import { WsConn, joinChan } from "../src/client";

const server = createRelayServer(0, "127.0.0.1");
const relayUrl = `ws://127.0.0.1:${server.port}/ws`;

afterAll(() => server.stop(true));

describe("daemon relay transport", () => {
  const pythonTransportTest = process.platform === "win32" ? test.skip : test;
  pythonTransportTest("sends encrypted frames in both directions after joining", async () => {
    const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
    const host = await WsConn.connect(relayUrl, {
      transport: "python",
      pythonBin: process.env.PYTHON_BIN ?? "python3",
    });
    const hostChannel = await joinChan(host, key, "host");
    const controller = await WsConn.connect(relayUrl);
    const controllerChannel = await joinChan(controller, key, "controller");

    try {
      // Exercise the production order: a Host waits for a controller request,
      // then writes its larger status response while the WSS read stays active.
      controller.send({
        op: "chan-data",
        data: { enc: await controllerChannel.seal({ kind: "controller-frame", text: "ready" }) },
      });
      const controllerFrame = await host.wait((message) => message.op === "chan-data");
      expect(await hostChannel.open<{ kind: string; text: string }>(controllerFrame.data?.enc)).toEqual({
        kind: "controller-frame",
        text: "ready",
      });

      const largeText = "x".repeat(2_048);
      host.send({
        op: "chan-data",
        data: { enc: await hostChannel.seal({ kind: "host-frame", text: largeText }) },
      });
      const hostFrame = await controller.wait((message) => message.op === "chan-data");
      expect(await controllerChannel.open<{ kind: string; text: string }>(hostFrame.data?.enc)).toEqual({
        kind: "host-frame",
        text: largeText,
      });
    } finally {
      host.close();
      controller.close();
    }
  });
});
