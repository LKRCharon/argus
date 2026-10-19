import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type Message = Record<string, any>;
const MAX_FRAME = 64 * 1024 * 1024;

export function encodeFrame(message: Message): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_FRAME) throw new Error("IPC frame exceeds 64 MiB");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

/** The desktop transport uses a four-byte little-endian UTF-8 byte length. */
export class FrameReader {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private length = 0;
  private received = 0;
  private parts: Buffer[] = [];

  push(chunk: Buffer, deliver: (message: Message) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.length) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 4) return;
        this.length = this.header.readUInt32LE();
        this.headerBytes = 0;
        if (!this.length || this.length > MAX_FRAME) throw new Error("Invalid desktop IPC frame size");
      }
      const count = Math.min(this.length - this.received, chunk.length - offset);
      this.parts.push(chunk.subarray(offset, offset + count));
      this.received += count;
      offset += count;
      if (this.received === this.length) {
        const message = JSON.parse(Buffer.concat(this.parts, this.length).toString("utf8"));
        this.length = this.received = 0;
        this.parts = [];
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid IPC message");
        deliver(message);
      }
    }
  }
}

const versions: Record<string, number> = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-load-complete-history": 1,
  "thread-follower-read-model-settings": 1,
  "thread-follower-update-thread-settings": 2,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
};

/** Connects as a follower. It never starts a router, claims ownership, or kills the App. */
export class DesktopIpc extends EventEmitter {
  private socket: Socket | null = null;
  private opening: Promise<void> | null = null;
  private clientId = "initializing-client";
  private pending = new Map<string, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly path: string;

  constructor(path = join(homedir(), ".codex", "ipc", "ipc.sock")) {
    super();
    this.path = path;
  }

  get connected(): boolean { return this.socket?.writable === true && this.clientId !== "initializing-client"; }

  async ready(): Promise<void> {
    if (this.connected) return;
    if (this.opening) return this.opening;
    const opening = this.open();
    this.opening = opening;
    try { await opening; } finally { if (this.opening === opening) this.opening = null; }
  }

  private async open(): Promise<void> {
    if (process.platform !== "win32") {
      const socket = statSync(this.path);
      const parent = statSync(dirname(this.path));
      const uid = process.getuid?.();
      if (!socket.isSocket() || socket.uid !== uid || parent.uid !== uid || (parent.mode & 0o022)) {
        throw new Error("Desktop IPC socket must belong to the current user in a private directory");
      }
    }
    const socket = connect(this.path);
    this.socket = socket;
    this.clientId = "initializing-client";
    const frames = new FrameReader();
    socket.on("data", chunk => {
      try { frames.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, message => this.receive(message)); }
      catch (error) { socket.destroy(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clientId = "initializing-client";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Desktop connection closed; delivery may be unknown"));
      }
      this.pending.clear();
      this.emit("disconnect");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Desktop socket connect timed out")); }, 5000);
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("error", error => { clearTimeout(timer); reject(error); });
      });
      const initialized = await this.sendRequest("initialize", { clientType: "argus-desktop-web" }, 0, undefined, 5000);
      if (typeof initialized.result?.clientId !== "string") throw new Error("Invalid desktop initialization");
      this.clientId = initialized.result.clientId;
      this.emit("connected");
    } catch (error) { socket.destroy(); throw error; }
  }

  private write(message: Message): void {
    if (!this.socket?.writable) throw new Error("Mac desktop is disconnected");
    this.socket.write(encodeFrame(message));
  }

  private receive(message: Message): void {
    if (message.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === "success") pending.resolve(message);
      else pending.reject(new Error(String(message.error ?? "Desktop request failed")));
    } else if (message.type === "client-discovery-request") {
      this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === "request") {
      this.write({ type: "response", requestId: message.requestId, resultType: "error", error: "no-handler-for-request" });
    } else if (message.type === "broadcast") this.emit("broadcast", message);
  }

  private sendRequest(method: string, params: Message, version: number, targetClientId?: string, timeoutMs = 20000, hostId?: string): Promise<Message> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Desktop response timed out; do not resend a mutation automatically"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: "request", requestId, sourceClientId: this.clientId, version, method, params, targetClientId, hostId, timeoutMs }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async request(method: string, params: Message, options: { targetClientId?: string; hostId?: string; timeoutMs?: number } = {}): Promise<Message> {
    if (!(method in versions)) throw new Error("Unsupported desktop operation");
    await this.ready();
    const hostId = options.hostId && options.hostId !== "local" ? options.hostId : undefined;
    const version = versions[method] + (hostId && method.startsWith("thread-follower-") ? 1 : 0);
    return this.sendRequest(method, params, version, options.targetClientId, options.timeoutMs, hostId);
  }

  async follow(conversationId: string, following: boolean, hostId = "local"): Promise<void> {
    await this.ready();
    this.write({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: this.clientId, version: 1, params: { conversationId, hostId, following } });
  }

  close(): void { this.socket?.destroy(); }
}
