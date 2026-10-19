import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { CodexAppServer } from "../../daemon/src/codex-appserver";
import { DesktopIpc, type Message } from "./ipc";
import { Deliveries, type Delivery, type Creation } from "./delivery";
import { applyPatches, desktopTurns, publicState, publicTurn, textInput, viewDiff } from "./state";
import { DesktopProjects } from "./projects";
import { fullAccessThreadSettings, fullAccessThreadStart } from "./permissions";
import { approvalTarget } from "./requests";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class DesktopBridge extends EventEmitter {
  readonly ipc: DesktopIpc;
  private catalogue = new CodexAppServer();
  private states = new Map<string, { owner: string; revision: number; state: Message; view: Message }>();
  private subscriptions = new Map<string, number>();
  private selections = new Map<string, Promise<Message>>();
  private approving = new Set<string>();
  private desktopProjects = new DesktopProjects();
  private timer: ReturnType<typeof setInterval>;

  constructor(readonly deliveries: Deliveries, socketPath?: string) {
    super();
    this.ipc = new DesktopIpc(socketPath);
    this.ipc.on("broadcast", message => this.onBroadcast(message));
    this.ipc.on("disconnect", () => { this.states.clear(); this.emit("event", { type: "connection", connected: false }); });
    this.ipc.on("connected", () => {
      this.emit("event", { type: "connection", connected: true });
      for (const id of this.subscriptions.keys()) void this.ipc.follow(id, true).catch(() => {});
    });
    this.timer = setInterval(() => { void this.ipc.ready().catch(() => {}); }, 5000);
  }

  private async rpc(method: string, params: Message): Promise<Message> {
    await this.catalogue.start();
    return this.catalogue.call(method, params, 25000);
  }

  async projects(): Promise<Message> {
    const projects: Message[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.rpc("project/list", { cursor, limit: 100 });
      projects.push(...(result.data ?? []).map((project: Message) => ({ id: project.id, name: project.name, roots: project.roots?.map((root: Message) => root.path) ?? [] })));
      cursor = result.nextCursor ?? null;
    } while (cursor && projects.length < 2000);
    return { projects };
  }

  async list(cursor: string | null, projectId?: string | null): Promise<Message> {
    const assignments = this.desktopProjects.read(), threads: Message[] = [];
    let nextCursor = cursor, pages = 0;
    do {
      const result = await this.rpc("thread/list", { limit: 60, cursor: nextCursor, sortKey: "updated_at", useStateDbOnly: true, sourceKinds: ["cli", "vscode", "exec", "appServer"] });
      for (const thread of result.data ?? []) {
        const membership = assignments.get(thread.id) ?? thread.projectId ?? null;
        if (projectId && membership !== projectId) continue;
        threads.push({ id: thread.id, projectId: membership, title: thread.name || thread.preview?.split("\n")[0] || "未命名会话", cwd: thread.cwd, updatedAt: thread.updatedAt });
      }
      nextCursor = result.nextCursor ?? null; pages++;
    } while (projectId && nextCursor && threads.length < 30 && pages < 8);
    return { threads, nextCursor };
  }

  /** Create an empty durable chat, release its writer, then let the original App own execution. */
  async create(projectId: string, id: string, title: string): Promise<Creation> {
    const claimed = this.deliveries.claimCreation(id, projectId);
    if (!claimed.fresh) return claimed.creation;
    let dispatched = false;
    try {
      const { project } = await this.rpc("project/read", { projectId });
      const roots = project.roots?.map((root: Message) => root.path) ?? [];
      if (!roots.length) throw new Error("此项目没有本机工作目录，请在原 App 中处理");
      dispatched = true;
      const { thread } = await this.rpc("thread/start", { projectId, cwd: roots[0], runtimeWorkspaceRoots: roots, historyMode: "paginated", threadSource: "vscode", ...fullAccessThreadStart });
      this.deliveries.updateCreation(id, "creating", thread.id);
      try { await this.rpc("thread/name/set", { threadId: thread.id, name: title.split("\n")[0].slice(0, 60) || "新对话" }); }
      finally { await this.rpc("thread/unsubscribe", { threadId: thread.id }); }
      return this.deliveries.updateCreation(id, "created", thread.id);
    } catch (error) {
      const previous = this.deliveries.creation(id)!;
      return this.deliveries.updateCreation(id, previous.threadId ? "created" : dispatched ? "unknown" : "blocked", null, error instanceof Error ? error.message : String(error));
    }
  }

  async history(threadId: string, cursor: string | null): Promise<Message> {
    const result = await this.rpc("thread/turns/list", { threadId, cursor, limit: 6, sortDirection: "desc", itemsView: "full" });
    this.deliveries.observe(result.data ?? []);
    return { turns: (result.data ?? []).slice().reverse().map(publicTurn), nextCursor: result.nextCursor ?? null };
  }

  snapshot(threadId: string): Message | null {
    const snapshot = this.states.get(threadId);
    return snapshot ? { type: "snapshot", threadId, revision: snapshot.revision, view: snapshot.view } : null;
  }

  private onBroadcast(message: Message): void {
    if (message.method !== "thread-stream-state-changed" || message.version !== 11 || message.params?.hostId !== "local") return;
    const { conversationId: id, change } = message.params;
    if (!this.subscriptions.has(id)) return;
    const previous = this.states.get(id);
    try {
      if (change.type === "snapshot") {
        if (change.conversationState?.id !== id) throw new Error("Desktop snapshot thread mismatch");
        this.states.set(id, { owner: message.sourceClientId, revision: change.revision, state: change.conversationState, view: publicState(change.conversationState) });
      } else if (change.type === "patches") {
        if (!previous || previous.owner !== message.sourceClientId || previous.revision !== change.baseRevision) {
          void this.ipc.follow(id, true).catch(() => {});
          return;
        }
        previous.state = applyPatches(previous.state, change.patches);
        previous.revision = change.revision;
      } else return;
      const current = this.states.get(id)!;
      this.deliveries.observe(desktopTurns(current.state));
      if (change.type === "snapshot") this.emit("event", this.snapshot(id));
      else {
        const view = publicState(current.state);
        const patches = viewDiff(current.view, view);
        current.view = view;
        this.emit("event", { type: "patches", threadId: id, baseRevision: change.baseRevision, revision: change.revision, patches });
      }
    } catch {
      this.states.delete(id);
      this.emit("event", { type: "resync", threadId: id });
      void this.ipc.follow(id, true).catch(() => {});
    }
  }

  async subscribe(threadId: string): Promise<() => void> {
    this.subscriptions.set(threadId, (this.subscriptions.get(threadId) ?? 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; this.unsubscribe(threadId); } };
    try { await this.ipc.follow(threadId, true); }
    catch (error) { release(); throw error; }
    return release;
  }

  unsubscribe(threadId: string): void {
    const count = (this.subscriptions.get(threadId) ?? 1) - 1;
    if (count > 0) this.subscriptions.set(threadId, count);
    else {
      this.subscriptions.delete(threadId); this.states.delete(threadId);
      if (this.ipc.connected) void this.ipc.follow(threadId, false).catch(() => {});
    }
  }

  async owner(threadId: string, timeoutMs = 5000): Promise<Message> {
    return this.ipc.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, { timeoutMs });
  }

  /** Only an explicit web selection opens an unloaded conversation in the real App. */
  async select(threadId: string): Promise<Message> {
    const pending = this.selections.get(threadId);
    if (pending) return pending;
    const selection = (async () => {
      // Validate the stored ID before asking the desktop to open anything.
      await this.rpc("thread/read", { threadId, includeTurns: false });
      try { return await this.owner(threadId, 1000); }
      catch { /* An explicit selection may ask the App to load an unowned chat. */ }
      if (process.platform !== "darwin") throw new Error("This adapter controls a Mac desktop App");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/open", ["-b", "com.openai.codex", `codex://threads/${encodeURIComponent(threadId)}`], { stdio: "ignore" });
        child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("Cannot open the Mac thread")));
      });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await pause(300);
        try { return await this.owner(threadId, 1000); }
        catch { /* Wait for the original desktop owner, never execute in the reader. */ }
      }
      throw new Error("原 App 尚未接管此会话；请在 Mac 打开该会话后重试");
    })();
    this.selections.set(threadId, selection);
    try { return await selection; } finally { this.selections.delete(threadId); }
  }

  async settings(threadId: string): Promise<Message | null> {
    const owner = await this.owner(threadId);
    const result = await this.ipc.request("thread-follower-read-model-settings", { conversationId: threadId }, { targetClientId: owner.handledByClientId });
    return result.result?.settings ?? null;
  }

  /** Change native thread defaults; an existing turn keeps its sandbox until it ends. */
  async useFullAccess(threadId: string, owner?: Message): Promise<Message> {
    owner ??= await this.owner(threadId);
    const release = await this.subscribe(threadId);
    try {
      const deadline = Date.now() + 5000;
      while (this.states.get(threadId)?.owner !== owner.handledByClientId) {
        if (Date.now() >= deadline) throw new Error("权限状态尚未同步，请稍后重试");
        await pause(50);
      }
      const state = this.states.get(threadId)!.state;
      const active = desktopTurns(state).slice().reverse().find(turn => turn.status === "inProgress");
      const activeTurnId = active?.turnId ?? active?.id;
      const response = await this.ipc.request("thread-follower-update-thread-settings", {
        conversationId: threadId, threadSettings: fullAccessThreadSettings(), ...(activeTurnId ? { activeTurnId } : {}),
      }, { targetClientId: owner.handledByClientId });
      if (response.result?.applied !== true) throw new Error("Mac 未接受完全访问设置，消息尚未发送");
      return { applied: true, activeTurnId: activeTurnId ?? null };
    } finally { release(); }
  }

  async send(threadId: string, text: string, id: string, mode: "send" | "steer"): Promise<Delivery> {
    const claimed = this.deliveries.claim(id, threadId, text, mode);
    if (!claimed.fresh) return claimed.delivery;
    let dispatched = false;
    try {
      const owner = await this.owner(threadId);
      await this.useFullAccess(threadId, owner);
      const input = textInput(text);
      this.deliveries.update(id, "dispatching");
      dispatched = true;
      const result = mode === "steer"
        ? await this.ipc.request("thread-follower-steer-turn", { conversationId: threadId, input, clientUserMessageId: id, attachments: [], restoreMessage: { text, context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] } } }, { targetClientId: owner.handledByClientId })
        : await this.ipc.request("thread-follower-start-turn", { conversationId: threadId, turnStart: { request: { threadId, input, clientUserMessageId: id, turnTrigger: "composer" }, context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] } } }, { targetClientId: owner.handledByClientId });
      const turnId = result.result?.result?.turn?.id ?? result.result?.result?.turnId ?? null;
      const observed = this.deliveries.get(id)!;
      if (observed.state === "completed") return observed;
      return this.deliveries.update(id, "started", turnId);
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      const observed = this.deliveries.get(id)!;
      if (observed.turnId && ["started", "completed", "interrupted", "failed"].includes(observed.state)) return observed;
      return this.deliveries.update(id, dispatched ? "unknown" : "blocked", null, note);
    }
  }

  async interrupt(threadId: string, expectedTurnId: string): Promise<Message> {
    const owner = await this.owner(threadId);
    const response = await this.ipc.request("thread-follower-interrupt-turn", { conversationId: threadId, expectedTurnId, mode: "user-stop" }, { targetClientId: owner.handledByClientId });
    return response.result;
  }

  async approval(threadId: string, requestId: string | number, method: string, decision: unknown): Promise<Message> {
    const owner = await this.owner(threadId);
    const state = this.states.get(threadId);
    if (!state || state.owner !== owner.handledByClientId) throw new Error("审批状态尚未同步，请刷新会话");
    const { request, kind } = approvalTarget(state.state, requestId, method, decision);
    const key = JSON.stringify([threadId, method, request.id]);
    if (this.approving.has(key)) throw new Error("此审批正在发送，请等待 Mac 同步");
    this.approving.add(key);
    try {
      const response = await this.ipc.request(`thread-follower-${kind}-approval-decision`, { conversationId: threadId, requestId: request.id, decision }, { targetClientId: owner.handledByClientId });
      return response.result;
    } finally { this.approving.delete(key); }
  }

  async close(): Promise<void> {
    clearInterval(this.timer); this.ipc.close(); await this.catalogue.stop(); this.deliveries.close();
  }
}
