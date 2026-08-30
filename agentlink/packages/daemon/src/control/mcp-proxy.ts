import { readFileSync } from "node:fs";
import type { Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolResultSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ReconnectSupervisor,
  type Handshake,
  type ReconnectStatus,
  type ReconnectUpstream,
} from "./reconnect-supervisor";

export const ARGUS_PROXY_STATUS_TOOL = "__argus_mcp_proxy_status";
const MAX_TOOLS = 128;
const MAX_TOOL_NAME = 128;
const MAX_TOOL_DESCRIPTION = 8_192;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_TOOL_PAGES = 128;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_CONTENT = 64;
const MAX_RESULT_TEXT = 256 * 1024;
const MAX_RESULT_BINARY = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_TAIL = 4_096;
const MAX_COMMAND = 256;
const MAX_ARGS = 64;
const MAX_ARG = 4_096;
const MAX_ENV = 32;
const MAX_ENV_KEY = 128;
const MAX_ENV_VALUE = 4_096;

export type ProxyCatalog = Tool[];

export type ProxyUpstream = ReconnectUpstream<ProxyCatalog> & {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  listTools?: (params?: { cursor?: string }, options?: { signal?: AbortSignal }) => Promise<{ tools: Tool[]; nextCursor?: string }>;
};

export type ProxyConnectorUpstream = Omit<ProxyUpstream, "loadCatalog" | "callTool" | "listTools"> & {
  loadCatalog(signal: AbortSignal): Promise<unknown>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools?: (params?: { cursor?: string }, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

export type ProxyConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type ProxyConnector = (signal: AbortSignal) => Promise<ProxyConnectorUpstream>;

export type ProxySdkTransport = Transport & {
  readonly stderr?: Stream | null;
};

export type ProxySdkFactory = {
  createClient(): Client;
  createTransport(parameters: StdioServerParameters): ProxySdkTransport;
};

export type McpProxyOptions = {
  connector?: ProxyConnector;
  config?: ProxyConfig;
  sdk?: ProxySdkFactory;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type ProxyDiagnostic = {
  state: "ready" | "not_ready" | "stopped";
  generation: number;
  attempt: number;
  lastSuccessfulConnectionTime: number | null;
  lastFailureCode: string | null;
  lastFailureStage: string | null;
  reconnectScheduled: boolean;
};

export type McpProxy = {
  server: Server;
  supervisor: ReconnectSupervisor<ProxyCatalog, ProxyUpstream>;
  stop(): Promise<void>;
  diagnostic(): ProxyDiagnostic;
};

export type McpProxyServeOptions = {
  installSignalHandlers?: boolean;
};

export function createMcpProxy(options: McpProxyOptions = {}): McpProxy {
  const catalogState: { tools: ProxyCatalog } = { tools: [] };
  let lastSuccessfulConnectionTime: number | null = null;
  let lastFailureCode: string | null = null;
  let lastFailureStage: string | null = null;
  let localClientInitialized = false;
  const clockNow = options.now ?? Date.now;
  let status: ReconnectStatus = {
    state: "idle",
    attempt: 0,
    generation: 0,
    retryable: true,
    stage: "idle",
  };
  const server = new Server(
    { name: "argus-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  const connector = options.connector ?? ((signal: AbortSignal) => connectStdioUpstream(
    options.config ?? loadConfigFromArgs(),
    signal,
    options.sdk,
  ));

  const supervisor = new ReconnectSupervisor<ProxyCatalog, ProxyUpstream>({
    connect: async signal => {
      const upstream = await connector(signal);
      return {
        handshake: upstream.handshake,
        loadCatalog: async loadSignal => validateCatalog(await loadAllTools(upstream, loadSignal)),
        callTool: async (name, args) => validateCallResult(await upstream.callTool(name, args)),
        close: () => upstream.close(),
        onClose: callback => upstream.onClose(callback),
      };
    },
    validateHandshake: validHandshake,
    baseBackoffMs: options.baseBackoffMs ?? 250,
    maxBackoffMs: options.maxBackoffMs ?? 30_000,
    random: options.random,
    now: options.now,
    sleep: options.sleep,
    onStatusChanged: next => {
      status = next;
      if (next.state === "ready") lastSuccessfulConnectionTime = clockNow();
      if (next.errorCode) {
        lastFailureCode = next.errorCode;
        lastFailureStage = next.stage;
      }
    },
    onCatalogChanged: next => {
      const previous = canonicalJson(catalogState.tools);
      catalogState.tools = next;
      if (localClientInitialized && previous !== canonicalJson(next)) void server.sendToolListChanged().catch(() => undefined);
    },
  });

  server.oninitialized = () => { localClientInitialized = true; };
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [diagnosticTool, ...catalogState.tools],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === ARGUS_PROXY_STATUS_TOOL) {
      return { content: [{ type: "text", text: JSON.stringify(diagnostic()) }] };
    }
    const args = request.params.arguments ?? {};
    if (!isRecord(args)) return unavailableResult("invalid_arguments", "tool arguments must be an object");
    if (!checkSerializedSize(args, MAX_ARGUMENT_BYTES)) return unavailableResult("arguments_too_large", "tool arguments exceed the limit");
    const known = catalogState.tools.some(tool => tool.name === request.params.name);
    if (!known) return unavailableResult("tool_unavailable", "tool is not available");
    let call: Promise<CallToolResult> | undefined;
    const result = supervisor.withReadyUpstream("call", upstream => {
      call = upstream.callTool(request.params.name, args);
    });
    if (!result.ok || !call) return unavailableResult(result.ok ? "upstream_call_unavailable" : result.errorCode, "upstream is not ready");
    try {
      return validateCallResult(await call);
    } catch {
      return unavailableResult("upstream_call_failed", "upstream call failed");
    }
  });

  const diagnostic = (): ProxyDiagnostic => ({
    state: status.state === "ready" ? "ready" : status.state === "stopped" ? "stopped" : "not_ready",
    generation: status.generation,
    attempt: status.attempt,
    lastSuccessfulConnectionTime,
    lastFailureCode,
    lastFailureStage,
    reconnectScheduled: status.state === "backoff" && status.nextRetryAt !== undefined,
  });

  const stop = () => supervisor.stop();
  supervisor.start();
  return { server, supervisor, stop, diagnostic };
}

class ClosingStdioServerTransport extends StdioServerTransport {
  private closed = false;
  private listeningForInputClose = false;

  private readonly onInputClosed = () => {
    void this.close();
  };

  override async start(): Promise<void> {
    await super.start();
    this.listeningForInputClose = true;
    process.stdin.once("end", this.onInputClosed);
    process.stdin.once("close", this.onInputClosed);
    if (process.stdin.readableEnded) void this.close();
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.listeningForInputClose) {
      process.stdin.off("end", this.onInputClosed);
      process.stdin.off("close", this.onInputClosed);
      this.listeningForInputClose = false;
    }
    await super.close();
  }
}

export async function serveMcpProxy(
  proxy: McpProxy,
  transport: Transport,
  options: McpProxyServeOptions = {},
): Promise<void> {
  let localClosed = false;
  let localClosureResolved = false;
  let resolveLocalClosure!: () => void;
  const localClosure = new Promise<void>(resolve => { resolveLocalClosure = resolve; });
  const resolveLocalClosureOnce = () => {
    if (localClosureResolved) return;
    localClosureResolved = true;
    resolveLocalClosure();
  };
  const markLocalClosed = () => {
    if (localClosed) return;
    localClosed = true;
    resolveLocalClosureOnce();
  };
  const previousServerClose = proxy.server.onclose;
  proxy.server.onclose = () => {
    try {
      previousServerClose?.();
    } finally {
      markLocalClosed();
    }
  };

  let connectStarted = false;
  let stopPromise: Promise<void> | undefined;
  let handleSignal: (() => void) | undefined;
  const removeSignalHandlers = () => {
    if (!handleSignal) return;
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    handleSignal = undefined;
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      removeSignalHandlers();
      resolveLocalClosureOnce();
      await proxy.stop();
      if (connectStarted && !localClosed) await proxy.server.close();
    })();
    return stopPromise;
  };

  if (options.installSignalHandlers) {
    handleSignal = () => { void stop(); };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }

  try {
    connectStarted = true;
    await proxy.server.connect(transport);
    await localClosure;
  } finally {
    try {
      await stop();
    } finally {
      proxy.server.onclose = previousServerClose;
    }
  }
}

export async function startMcpProxy(options: McpProxyOptions = {}): Promise<void> {
  const proxy = createMcpProxy(options);
  await serveMcpProxy(proxy, new ClosingStdioServerTransport(), { installSignalHandlers: true });
}

export function validateProxyConfig(value: unknown): ProxyConfig {
  if (!isRecord(value) || typeof value.command !== "string" || !value.command.trim() || value.command.length > MAX_COMMAND) {
    throw new Error("invalid upstream command");
  }
  const args: string[] = [];
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > MAX_ARGS) throw new Error("invalid upstream args");
    for (const item of value.args) {
      if (typeof item !== "string" || item.length > MAX_ARG) throw new Error("invalid upstream args");
      args.push(item);
    }
  }
  const rawEnv = value.env === undefined ? undefined : value.env;
  if (rawEnv !== undefined && (!isRecord(rawEnv) || Object.keys(rawEnv).length > MAX_ENV)) throw new Error("invalid upstream environment");
  let env: Record<string, string> | undefined;
  if (rawEnv) {
    env = {};
    for (const [key, item] of Object.entries(rawEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > MAX_ENV_KEY || typeof item !== "string" || item.length > MAX_ENV_VALUE) {
        throw new Error("invalid upstream environment");
      }
      env[key] = item;
    }
  }
  let cwd: string | undefined;
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd.length > MAX_ARG) throw new Error("invalid upstream cwd");
    cwd = value.cwd;
  }
  return { command: value.command, args, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
}

function loadConfigFromArgs(): ProxyConfig {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") throw new Error("use --config <json-file>");
  return validateProxyConfig(JSON.parse(readFileSync(args[1], "utf8")));
}

const defaultProxySdkFactory: ProxySdkFactory = {
  createClient: () => new Client({ name: "argus-mcp-proxy", version: "1.0.0" }),
  createTransport: parameters => new StdioClientTransport(parameters),
};

async function connectStdioUpstream(
  config: ProxyConfig,
  signal: AbortSignal,
  sdk: ProxySdkFactory = defaultProxySdkFactory,
): Promise<ProxyConnectorUpstream> {
  signal.throwIfAborted();
  const params: StdioServerParameters = {
    command: config.command,
    args: config.args ?? [],
    ...(config.env ? { env: { ...config.env } } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    stderr: "pipe",
    maxBufferSize: MAX_SCHEMA_BYTES,
  };
  const transport = sdk.createTransport(params);
  const stderr = transport.stderr;
  let diagnosticTail = "";
  const onStderrData = (chunk: Buffer | string) => {
    diagnosticTail = appendBoundedStderrTail(diagnosticTail, chunk);
  };
  stderr?.on("data", onStderrData);
  const client = sdk.createClient();
  const onClose = new Set<() => void>();
  let closed = false;
  let transportNotified = false;
  const notify = () => {
    if (closed || transportNotified) return;
    transportNotified = true;
    for (const callback of onClose) {
      try {
        callback();
      } catch {
        // A consumer callback must not break the SDK transport callback.
      }
    }
  };
  const priorClose = client.onclose;
  const priorError = client.onerror;
  client.onclose = () => {
    try {
      priorClose?.();
    } finally {
      notify();
    }
  };
  client.onerror = error => {
    try {
      priorError?.(error);
    } finally {
      notify();
    }
  };
  const detachSetupListeners = () => {
    signal.removeEventListener("abort", closeForAbort);
    stderr?.off("data", onStderrData);
  };
  let closePromise: Promise<void> | undefined;
  const closeOwned = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    detachSetupListeners();
    const wasAttached = client.transport === transport;
    closePromise = (async () => {
      try {
        await client.close();
      } finally {
        if (!transportNotified && (!wasAttached || client.transport === transport)) {
          await transport.close();
        }
      }
    })();
    return closePromise;
  };
  const closeForAbort = () => {
    void closeOwned().catch(() => undefined);
  };
  signal.addEventListener("abort", closeForAbort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal });
    signal.throwIfAborted();
    const handshake: Handshake = {
      name: boundedText(client.getServerVersion()?.name ?? "mcp", 128),
      version: boundedText(client.getServerVersion()?.version ?? "unknown", 128),
      protocolVersion: "mcp",
    };
    return {
      handshake,
      loadCatalog: async loadSignal => loadAllTools({
        listTools: (params, requestOptions) => client.listTools(params, requestOptions),
      }, loadSignal),
      listTools: (params, requestOptions) => client.listTools(params, requestOptions),
      callTool: async (name, args) => validateCallResult(await client.callTool({ name, arguments: args }, CallToolResultSchema)),
      close: closeOwned,
      onClose: callback => {
        if (closed || transportNotified) {
          callback();
          return () => undefined;
        }
        onClose.add(callback);
        return () => onClose.delete(callback);
      },
    };
  } catch (error) {
    try {
      await closeOwned();
    } catch {
      // Setup cleanup is best effort; preserve the original failure.
    }
    throw error;
  }
}

function validateCatalog(value: unknown): ProxyCatalog {
  const parsed = ListToolsResultSchema.parse(Array.isArray(value) ? { tools: value } : value);
  if (parsed.tools.length > MAX_TOOLS) throw new Error("catalog_too_large");
  if (!checkSerializedSize(parsed.tools, MAX_CATALOG_BYTES)) throw new Error("catalog_serialized_too_large");
  const names = new Set<string>();
  for (const tool of parsed.tools) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) || tool.name.length > MAX_TOOL_NAME || tool.name === ARGUS_PROXY_STATUS_TOOL || names.has(tool.name)) throw new Error("catalog_invalid_tool");
    names.add(tool.name);
    if (tool.description && Buffer.byteLength(tool.description, "utf8") > MAX_TOOL_DESCRIPTION) throw new Error("catalog_tool_description_too_large");
    if (!checkSerializedSize(tool.inputSchema, MAX_SCHEMA_BYTES) || (tool.outputSchema && !checkSerializedSize(tool.outputSchema, MAX_SCHEMA_BYTES))) throw new Error("catalog_schema_too_large");
  }
  return parsed.tools;
}

function validateCallResult(value: unknown): CallToolResult {
  const result = CallToolResultSchema.parse(value);
  if (!checkSerializedSize(result, MAX_RESULT_BYTES)) throw new Error("result_serialized_too_large");
  if (result.content.length > MAX_RESULT_CONTENT) throw new Error("result_too_large");
  let textBytes = 0;
  let binaryBytes = 0;
  for (const item of result.content) {
    if (item.type === "text") textBytes += Buffer.byteLength(item.text, "utf8");
    else if (item.type === "image" || item.type === "audio") binaryBytes += Buffer.byteLength(item.data, "utf8");
    else if (item.type === "resource") {
      if ("text" in item.resource) textBytes += Buffer.byteLength(item.resource.text, "utf8");
      else binaryBytes += Buffer.byteLength(item.resource.blob, "utf8");
    }
    if (textBytes > MAX_RESULT_TEXT || binaryBytes > MAX_RESULT_BINARY) throw new Error("result_content_too_large");
  }
  return result;
}

function unavailableResult(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
}

function validHandshake(handshake: Handshake): boolean {
  return Boolean(handshake.name && handshake.version && handshake.protocolVersion)
    && handshake.name.length <= 128 && handshake.version.length <= 128 && handshake.protocolVersion.length <= 128;
}

function boundedText(value: string, max: number): string { return value.slice(0, max); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function appendBoundedStderrTail(current: string, chunk: Buffer | string, maxBytes = MAX_DIAGNOSTIC_TAIL): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return "";
  const safeCurrent = current.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
  const safeChunk = (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
  const combined = Buffer.from(safeCurrent + safeChunk, "utf8");
  if (combined.length <= maxBytes) return combined.toString("utf8");
  let tail = combined.subarray(combined.length - maxBytes);
  while (tail.length > 0 && (tail[0] & 0xc0) === 0x80) tail = tail.subarray(1);
  return tail.toString("utf8");
}

function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (ancestors.has(item)) return "[Circular]";
    ancestors.add(item);
    const result = Array.isArray(item)
      ? item.map(visit)
      : isRecord(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key])]))
        : item;
    ancestors.delete(item);
    return result;
  };
  return JSON.stringify(visit(value));
}

function checkSerializedSize(value: unknown, maxBytes: number): boolean {
  try { return Buffer.byteLength(canonicalJson(value), "utf8") <= maxBytes; } catch { return false; }
}

async function loadAllTools(upstream: {
  listTools?: (params?: { cursor?: string }, options?: { signal?: AbortSignal }) => Promise<unknown>;
  loadCatalog?: (signal: AbortSignal) => Promise<unknown>;
}, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!upstream.listTools) {
    const catalog = await upstream.loadCatalog!(signal);
    signal.throwIfAborted();
    return catalog;
  }
  const tools: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await upstream.listTools(cursor ? { cursor } : undefined, { signal });
    signal.throwIfAborted();
    if (!isRecord(page) || !Array.isArray(page.tools)) throw new Error("catalog_page_invalid");
    tools.push(...page.tools);
    if (tools.length > MAX_TOOLS) throw new Error("catalog_too_large");
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || nextCursor === null || nextCursor === "") return { tools };
    if (typeof nextCursor !== "string") throw new Error("catalog_cursor_invalid");
    if (cursors.has(nextCursor)) throw new Error("catalog_cursor_loop");
    cursors.add(nextCursor);
    if (cursors.size >= MAX_TOOL_PAGES) throw new Error("catalog_cursor_overflow");
    cursor = nextCursor;
  }
}

const diagnosticTool: Tool = {
  name: ARGUS_PROXY_STATUS_TOOL,
  description: "Return bounded local proxy connection state.",
  inputSchema: { type: "object", properties: {} },
};

if (import.meta.main) {
  void startMcpProxy().catch(() => {
    process.stderr.write("Argus MCP proxy failed to start.\n");
    process.exitCode = 1;
  });
}
