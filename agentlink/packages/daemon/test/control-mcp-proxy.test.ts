import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ARGUS_PROXY_STATUS_TOOL,
  appendBoundedStderrTail,
  createMcpProxy,
  serveMcpProxy,
  validateProxyConfig,
  type McpProxy,
  type ProxyConnectorUpstream,
  type ProxySdkFactory,
  type ProxySdkTransport,
} from "../src/control/mcp-proxy";

const handshake = { name: "fake-upstream", version: "1", protocolVersion: "mcp" };

const tool = (name: string, description = "fake tool", schemaChanged = false): Tool => ({
  name,
  description,
  inputSchema: schemaChanged ? { type: "object", required: ["value"] } : { type: "object" },
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Bun.sleep(0);
};

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function controlledBackoff() {
  const pending: Array<() => void> = [];
  return {
    sleep: async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", finish);
          const index = pending.indexOf(finish);
          if (index >= 0) pending.splice(index, 1);
          resolve();
        };
        pending.push(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    },
    release: () => pending.shift()?.(),
    pendingCount: () => pending.length,
  };
}

type FakeUpstream = ProxyConnectorUpstream & {
  emitClose(): void;
  closeCount(): number;
};

function fakeUpstream(
  catalog: unknown,
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({
    content: [{ type: "text", text: "ok" }],
  }),
  listTools?: (params?: { cursor?: string }, options?: { signal?: AbortSignal }) => Promise<unknown>,
): FakeUpstream {
  const listeners = new Set<() => void>();
  let closes = 0;
  const upstream: FakeUpstream = {
    handshake,
    loadCatalog: async () => catalog,
    callTool,
    close: async () => { closes++; },
    onClose: callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emitClose: () => {
      for (const listener of [...listeners]) listener();
    },
    closeCount: () => closes,
  };
  if (listTools) upstream.listTools = listTools;
  return upstream;
}

async function connectedProxy(proxy: McpProxy) {
  const client = new Client({ name: "proxy-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  await client.connect(clientTransport);
  let closePromise: Promise<void> | undefined;
  return {
    client,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await client.close();
        await proxy.stop();
      })();
      return closePromise;
    },
  };
}

function text(result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("missing result");
  const content = "content" in result ? result.content : undefined;
  const item = Array.isArray(content) ? content[0] : undefined;
  if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string") {
    throw new Error("missing text");
  }
  return item.text;
}

async function waitForReady(proxy: McpProxy, generation = 1): Promise<void> {
  await waitFor(
    () => proxy.diagnostic().state === "ready" && proxy.diagnostic().generation === generation,
    `generation ${generation}`,
  );
}

async function reconnect(
  proxy: McpProxy,
  previous: FakeUpstream,
  backoff: ReturnType<typeof controlledBackoff>,
  generation: number,
): Promise<void> {
  previous.emitClose();
  await waitFor(() => backoff.pendingCount() === 1, "controlled reconnect backoff");
  backoff.release();
  await waitForReady(proxy, generation);
}

type SdkHarness = {
  sdk: ProxySdkFactory;
  transport: ProxySdkTransport;
  stderr: PassThrough;
  closeCount(): number;
};

async function sdkHarness(
  tools: Tool[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> = async () => ({
    content: [{ type: "text", text: "ok" }],
  }),
): Promise<SdkHarness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stderr = new PassThrough();
  const transport = Object.assign(clientTransport, { stderr });
  let closes = 0;
  let transportClosed = false;
  const originalClose = transport.close.bind(transport);
  transport.close = async () => {
    if (transportClosed) return;
    transportClosed = true;
    closes++;
    await originalClose();
  };

  const server = new Server(
    { name: "sdk-test-upstream", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, request => callTool(request.params.name, request.params.arguments ?? {}));
  await server.connect(serverTransport);

  const sdk: ProxySdkFactory = {
    createClient: () => new Client({ name: "sdk-test-proxy", version: "1" }),
    createTransport: () => transport,
  };
  return { sdk, transport, stderr, closeCount: () => closes };
}

async function expectCatalogFailure(catalog: unknown): Promise<void> {
  const upstream = fakeUpstream(catalog);
  const backoff = controlledBackoff();
  const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
  const connected = await connectedProxy(proxy);
  try {
    await waitFor(() => proxy.diagnostic().lastFailureCode === "catalog_load_failed", "catalog failure");
    expect(proxy.diagnostic()).toMatchObject({ state: "not_ready", lastFailureStage: "catalog" });
    expect((await connected.client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL]);
  } finally {
    await connected.close();
  }
}

describe("long-lived MCP proxy", () => {
  test("publishes the initial catalog and a bounded local status", async () => {
    const upstream = fakeUpstream([tool("one")]);
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      expect((await connected.client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL, "one"]);
      const statusText = text(await connected.client.callTool({ name: ARGUS_PROXY_STATUS_TOOL, arguments: {} }));
      const status = JSON.parse(statusText) as Record<string, unknown>;
      expect(Object.keys(status).sort()).toEqual([
        "attempt",
        "generation",
        "lastFailureCode",
        "lastFailureStage",
        "lastSuccessfulConnectionTime",
        "reconnectScheduled",
        "state",
      ]);
      expect(status).toMatchObject({ state: "ready", generation: 1, attempt: 0, reconnectScheduled: false });
      expect(Buffer.byteLength(statusText, "utf8")).toBeLessThan(512);
    } finally {
      await connected.close();
    }
  });

  test("rejects calls immediately before the first catalog is ready", async () => {
    let releaseCatalog!: () => void;
    let catalogSignal: AbortSignal | undefined;
    const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
    let calls = 0;
    const upstream = fakeUpstream([tool("one")]);
    upstream.loadCatalog = async signal => {
      catalogSignal = signal;
      await catalogGate;
      return [tool("one")];
    };
    upstream.callTool = async () => {
      calls++;
      return { content: [{ type: "text", text: "unexpected" }] };
    };
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitFor(() => catalogSignal !== undefined, "catalog request");
      const result = await settleWithin(connected.client.callTool({ name: "one", arguments: {} }), "pre-ready call");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("tool_unavailable");
      expect(calls).toBe(0);
      releaseCatalog();
      await waitForReady(proxy);
    } finally {
      releaseCatalog();
      await connected.close();
    }
  });

  test("keeps the last valid catalog visible while disconnected", async () => {
    const first = fakeUpstream([tool("one")]);
    const second = fakeUpstream([tool("one")]);
    let connects = 0;
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({
      connector: async () => (++connects === 1 ? first : second),
      sleep: backoff.sleep,
    });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      first.emitClose();
      await waitFor(() => backoff.pendingCount() === 1, "disconnect backoff");
      expect((await connected.client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL, "one"]);
      const unavailable = await connected.client.callTool({ name: "one", arguments: {} });
      expect(unavailable.isError).toBe(true);
      expect(text(unavailable)).toContain("not_ready");
      backoff.release();
      await waitForReady(proxy, 2);
      expect((await connected.client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL, "one"]);
    } finally {
      await connected.close();
    }
  });

  test("does not queue or replay an in-flight call", async () => {
    let rejectCall!: (error: Error) => void;
    let calls = 0;
    const inFlight = new Promise<CallToolResult>((_, reject) => { rejectCall = reject; });
    const first = fakeUpstream([tool("one")], async () => {
      calls++;
      return inFlight;
    });
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => first, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      const pending = connected.client.callTool({ name: "one", arguments: {} });
      await waitFor(() => calls === 1, "upstream call");
      first.emitClose();
      await waitFor(() => backoff.pendingCount() === 1, "disconnect backoff");
      const unavailable = await connected.client.callTool({ name: "one", arguments: {} });
      expect(unavailable.isError).toBe(true);
      expect(text(unavailable)).toContain("not_ready");
      rejectCall(new Error("transport closed"));
      const failed = await settleWithin(pending, "in-flight call");
      expect(failed.isError).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await connected.close();
    }
  });

  test("settles a real SDK pending call once after transport loss", async () => {
    let resolveCallStarted!: () => void;
    const callStarted = new Promise<void>(resolve => { resolveCallStarted = resolve; });
    const callGate = new Promise<void>(() => undefined);
    const harness = await sdkHarness([tool("one")], async () => {
      resolveCallStarted();
      await callGate;
      return { content: [{ type: "text", text: "late" }] };
    });
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ config: { command: "in-memory" }, sdk: harness.sdk, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      let settlements = 0;
      const pending = connected.client.callTool({ name: "one", arguments: {} }).then(
        result => { settlements++; return result; },
        error => { settlements++; throw error; },
      );
      await settleWithin(callStarted, "SDK call dispatch");
      await harness.transport.close();
      const result = await settleWithin(pending, "SDK pending call");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("upstream_call_failed");
      expect(settlements).toBe(1);
      expect(harness.closeCount()).toBe(1);
    } finally {
      await connected.close();
    }
  });

  test("sends one list-changed notification for add, remove, and schema-only changes", async () => {
    const generations = [
      fakeUpstream([tool("one")]),
      fakeUpstream([tool("one"), tool("two")]),
      fakeUpstream([tool("one")]),
      fakeUpstream([tool("one", "fake tool", true)]),
    ];
    let index = 0;
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => generations[index++]!, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    const notifications: number[] = [];
    connected.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notifications.push(1); });
    try {
      await waitForReady(proxy);
      await reconnect(proxy, generations[0]!, backoff, 2);
      await waitFor(() => notifications.length === 1, "add notification");
      await reconnect(proxy, generations[1]!, backoff, 3);
      await waitFor(() => notifications.length === 2, "remove notification");
      await reconnect(proxy, generations[2]!, backoff, 4);
      await waitFor(() => notifications.length === 3, "schema notification");
      expect(notifications).toHaveLength(3);
    } finally {
      await connected.close();
    }
  });

  test("sends no notification for a semantically unchanged catalog with reordered keys", async () => {
    const first = fakeUpstream([tool("one")]);
    const reordered = fakeUpstream([{
      inputSchema: { type: "object" },
      description: "fake tool",
      name: "one",
    }]);
    const backoff = controlledBackoff();
    let connects = 0;
    const proxy = createMcpProxy({
      connector: async () => (++connects === 1 ? first : reordered),
      sleep: backoff.sleep,
    });
    const connected = await connectedProxy(proxy);
    let notifications = 0;
    connected.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notifications++; });
    try {
      await waitForReady(proxy);
      await reconnect(proxy, first, backoff, 2);
      await flush();
      expect(notifications).toBe(0);
    } finally {
      await connected.close();
    }
  });

  const invalidCatalogs: Array<[string, unknown]> = [
    ["malformed tools", { tools: [{ name: "one", inputSchema: { type: "array" } }] }],
    ["duplicate names", [tool("one"), tool("one")]],
    ["the reserved status name", [tool(ARGUS_PROXY_STATUS_TOOL)]],
    ["too many tools", Array.from({ length: 129 }, (_, index) => tool(`tool-${index}`))],
    ["an oversized full catalog", Array.from({ length: 70 }, (_, index) => tool(`tool-${index}`, "x".repeat(8_192)))],
    ["an oversized schema", [{ name: "one", inputSchema: { type: "object", metadata: "x".repeat(140_000) } }]],
    ["an oversized description", [{ name: "one", description: "x".repeat(8_193), inputSchema: { type: "object" } }]],
  ];

  for (const [name, catalog] of invalidCatalogs) {
    test(`rejects ${name}`, async () => {
      await expectCatalogFailure(catalog);
    });
  }

  test("rejects oversized arguments before invoking the upstream", async () => {
    let calls = 0;
    const upstream = fakeUpstream([tool("one")], async () => {
      calls++;
      return { content: [{ type: "text", text: "unexpected" }] };
    });
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      const result = await connected.client.callTool({ name: "one", arguments: { payload: "x".repeat(140_000) } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("arguments_too_large");
      expect(calls).toBe(0);
    } finally {
      await connected.close();
    }
  });

  test("rejects oversized complete results including structured and content metadata", async () => {
    const results: Record<string, CallToolResult> = {
      structured: { content: [], structuredContent: { payload: "x".repeat(2 * 1024 * 1024) } },
      meta: { content: [], _meta: { payload: "x".repeat(2 * 1024 * 1024) } },
      embedded: {
        content: [{ type: "resource", resource: { uri: "urn:test", text: "x".repeat(300_000) } }],
      },
      resourceLink: {
        content: [{ type: "resource_link", uri: "urn:test", name: "large", description: "x".repeat(2 * 1024 * 1024) }],
      },
      icon: {
        content: [{
          type: "resource_link",
          uri: "urn:test",
          name: "large",
          icons: [{ src: "x".repeat(2 * 1024 * 1024), mimeType: "image/png", sizes: ["any"], theme: "light" }],
        }],
      },
    };
    const upstream = fakeUpstream(
      Object.keys(results).map(name => tool(name)),
      async name => results[name]!,
    );
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      for (const name of Object.keys(results)) {
        const result = await connected.client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("upstream_call_failed");
      }
    } finally {
      await connected.close();
    }
  });

  test("aggregates paginated tools and passes the catalog signal to every page", async () => {
    const seenSignals: AbortSignal[] = [];
    const upstream = fakeUpstream(
      [],
      undefined,
      async (params, options) => {
        if (options?.signal) seenSignals.push(options.signal);
        return params?.cursor === "page-2"
          ? { tools: [tool("two")] }
          : { tools: [tool("one")], nextCursor: "page-2" };
      },
    );
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      expect((await connected.client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL, "one", "two"]);
      expect(seenSignals).toHaveLength(2);
    } finally {
      await connected.close();
    }
  });

  test("rejects a cursor loop and too many paginated tools or pages", async () => {
    const loop = fakeUpstream([], undefined, async () => ({ tools: [], nextCursor: "same" }));
    const loopBackoff = controlledBackoff();
    const loopProxy = createMcpProxy({ connector: async () => loop, sleep: loopBackoff.sleep });
    await waitFor(() => loopProxy.diagnostic().lastFailureCode === "catalog_load_failed", "cursor loop failure");
    await loopProxy.stop();

    const tooManyTools = fakeUpstream([], undefined, async () => ({
      tools: Array.from({ length: 129 }, (_, index) => tool(`tool-${index}`)),
    }));
    const toolsBackoff = controlledBackoff();
    const toolsProxy = createMcpProxy({ connector: async () => tooManyTools, sleep: toolsBackoff.sleep });
    await waitFor(() => toolsProxy.diagnostic().lastFailureCode === "catalog_load_failed", "paginated tool limit");
    await toolsProxy.stop();

    let page = 0;
    const tooManyPages = fakeUpstream([], undefined, async () => {
      page++;
      return { tools: [], nextCursor: `page-${page}` };
    });
    const pagesBackoff = controlledBackoff();
    const pagesProxy = createMcpProxy({ connector: async () => tooManyPages, sleep: pagesBackoff.sleep });
    await waitFor(() => pagesProxy.diagnostic().lastFailureCode === "catalog_load_failed", "paginated page limit");
    expect(page).toBe(128);
    await pagesProxy.stop();
  });

  test("propagates initialization and catalog AbortSignals", async () => {
    class RecordingClient extends Client {
      initSignal: AbortSignal | undefined;
      catalogSignals: Array<AbortSignal | undefined> = [];

      override connect(transport: Transport, options?: RequestOptions): Promise<void> {
        this.initSignal = options?.signal;
        return super.connect(transport, options);
      }

      override listTools(
        params?: Parameters<Client["listTools"]>[0],
        options?: RequestOptions,
      ) {
        this.catalogSignals.push(options?.signal);
        return super.listTools(params, options);
      }
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const upstreamServer = new Server(
      { name: "recording-upstream", version: "1" },
      { capabilities: { tools: { listChanged: true } } },
    );
    upstreamServer.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool("one")] }));
    await upstreamServer.connect(serverTransport);
    let recordingClient: RecordingClient | undefined;
    const sdk: ProxySdkFactory = {
      createClient: () => {
        recordingClient = new RecordingClient({ name: "recording-client", version: "1" });
        return recordingClient;
      },
      createTransport: () => clientTransport,
    };
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ config: { command: "in-memory" }, sdk, sleep: backoff.sleep });
    try {
      await waitForReady(proxy);
      expect(recordingClient?.initSignal).toBeDefined();
      expect(recordingClient?.catalogSignals[0]).toBeDefined();
      const initializationSignal = recordingClient!.initSignal!;
      await proxy.stop();
      expect(initializationSignal.aborted).toBe(true);
    } finally {
      await proxy.stop();
    }

    let releaseCatalog!: () => void;
    let catalogSignal: AbortSignal | undefined;
    const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
    const catalogUpstream = fakeUpstream([tool("one")], undefined, async (_params, options) => {
      catalogSignal = options?.signal;
      await catalogGate;
      return { tools: [tool("one")] };
    });
    const catalogProxy = createMcpProxy({ connector: async () => catalogUpstream, sleep: controlledBackoff().sleep });
    try {
      await waitFor(() => catalogSignal !== undefined, "catalog AbortSignal");
      const stopping = catalogProxy.stop();
      expect(catalogSignal?.aborted).toBe(true);
      releaseCatalog();
      await stopping;
      expect(catalogUpstream.closeCount()).toBe(1);
    } finally {
      releaseCatalog();
      await catalogProxy.stop();
    }
  });

  test("cleans up the owned transport when initialization fails", async () => {
    let closes = 0;
    const failingTransport: ProxySdkTransport = {
      stderr: null,
      start: async () => { throw new Error("initialization transport failed"); },
      send: async () => undefined,
      close: async () => {
        closes++;
        failingTransport.onclose?.();
      },
    };
    const sdk: ProxySdkFactory = {
      createClient: () => new Client({ name: "failing-client", version: "1" }),
      createTransport: () => failingTransport,
    };
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ config: { command: "failing" }, sdk, sleep: backoff.sleep });
    try {
      await waitFor(() => proxy.diagnostic().lastFailureCode === "connect_failed", "initialization failure");
      expect(closes).toBe(1);
    } finally {
      await proxy.stop();
    }
  });

  test("cleans up the owned SDK transport when catalog loading fails", async () => {
    const oversized = tool("one", "x".repeat(9_000));
    const harness = await sdkHarness([oversized]);
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ config: { command: "in-memory" }, sdk: harness.sdk, sleep: backoff.sleep });
    try {
      await waitFor(() => proxy.diagnostic().lastFailureCode === "catalog_load_failed", "SDK catalog failure");
      expect(harness.closeCount()).toBe(1);
    } finally {
      await proxy.stop();
    }
  });

  test("bounds UTF-8 stderr and never exposes the tail in public status", async () => {
    const tail = appendBoundedStderrTail("prefix", "ok\u0000\n" + "甲".repeat(32), 12);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(12);
    expect(tail).not.toContain("\u0000");
    expect(appendBoundedStderrTail("", "甲".repeat(4), 5)).toBe("甲");
    expect(appendBoundedStderrTail("ignored", "data", 0)).toBe("");

    const harness = await sdkHarness([tool("one")]);
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ config: { command: "sensitive-command" }, sdk: harness.sdk, sleep: backoff.sleep });
    const connected = await connectedProxy(proxy);
    try {
      await waitForReady(proxy);
      const rawTail = "argv=/private/path and credential-like diagnostic text";
      harness.stderr.write(rawTail);
      await flush();
      expect(harness.stderr.listenerCount("data")).toBeGreaterThan(0);
      const status = text(await connected.client.callTool({ name: ARGUS_PROXY_STATUS_TOOL, arguments: {} }));
      expect(status).not.toContain(rawTail);
      expect(status).not.toContain("sensitive-command");
      expect(status).not.toContain("/private/path");
    } finally {
      await connected.close();
    }
    expect(harness.stderr.listenerCount("data")).toBe(0);
  });

  test("stop is idempotent and closes one upstream generation", async () => {
    const upstream = fakeUpstream([]);
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    await waitForReady(proxy);
    const first = proxy.stop();
    expect(proxy.stop()).toBe(first);
    await first;
    expect(proxy.stop()).toBe(first);
    expect(upstream.closeCount()).toBe(1);
    expect(proxy.diagnostic().state).toBe("stopped");
  });

  test("keeps the local server open across upstream reconnects and stops on local client close", async () => {
    const first = fakeUpstream([tool("one")]);
    const second = fakeUpstream([tool("one")]);
    let connects = 0;
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({
      connector: async () => (++connects === 1 ? first : second),
      sleep: backoff.sleep,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const serving = serveMcpProxy(proxy, serverTransport);
    const client = new Client({ name: "local-client", version: "1" });
    await client.connect(clientTransport);
    try {
      await waitForReady(proxy);
      first.emitClose();
      await waitFor(() => backoff.pendingCount() === 1, "serve reconnect backoff");
      expect((await client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL, "one"]);
      backoff.release();
      await waitForReady(proxy, 2);
      expect((await client.listTools()).tools.map(item => item.name)).toEqual([ARGUS_PROXY_STATUS_TOOL, "one"]);
      await client.close();
      await settleWithin(serving, "serve loop after local client close");
      expect(first.closeCount()).toBe(1);
      expect(second.closeCount()).toBe(1);
    } finally {
      await client.close();
      await settleWithin(serving, "serve cleanup");
    }
  });

  test("resolves the serve loop when the local transport closes and removes signal handlers", async () => {
    const upstream = fakeUpstream([]);
    const backoff = controlledBackoff();
    const proxy = createMcpProxy({ connector: async () => upstream, sleep: backoff.sleep });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const beforeInterrupt = process.listenerCount("SIGINT");
    const beforeTerminate = process.listenerCount("SIGTERM");
    const serving = serveMcpProxy(proxy, serverTransport, { installSignalHandlers: true });
    const client = new Client({ name: "local-client", version: "1" });
    await client.connect(clientTransport);
    try {
      await waitForReady(proxy);
      expect(process.listenerCount("SIGINT")).toBe(beforeInterrupt + 1);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerminate + 1);
      await serverTransport.close();
      await settleWithin(serving, "serve loop after local transport close");
      expect(upstream.closeCount()).toBe(1);
      expect(process.listenerCount("SIGINT")).toBe(beforeInterrupt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerminate);
    } finally {
      await client.close();
      await settleWithin(serving, "serve cleanup");
    }
  });

  test("validates proxy configuration without unsafe coercion", () => {
    expect(validateProxyConfig({ command: "ssh", args: ["-T"], env: { ARGUS_CONTROL_URL: "http://127.0.0.1:8790" } })).toEqual({
      command: "ssh",
      args: ["-T"],
      env: { ARGUS_CONTROL_URL: "http://127.0.0.1:8790" },
    });
    expect(() => validateProxyConfig({ command: "ssh", args: Array(65).fill("x") })).toThrow();
    expect(() => validateProxyConfig({ command: "ssh", env: { "BAD-KEY": "x" } })).toThrow();
    expect(() => validateProxyConfig({ command: "ssh", args: [1] })).toThrow();
  });
});
