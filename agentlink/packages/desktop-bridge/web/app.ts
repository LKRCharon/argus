import { marked } from "marked";
import DOMPurify from "dompurify";

type Row = Record<string, any>;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = element<HTMLTextAreaElement>("input");
const form = element<HTMLFormElement>("composer");
let token = "", selected = "", socket: WebSocket | null = null, busy = false, canSend = false, running = false;
let threadCursor: string | null = null, historyCursor: string | null = null, generation = 0;
let threads: Row[] = [], turns = new Map<string, Row>(), activeTurn = "", reconnectTimer: number | undefined;
let liveView: Row | null = null, liveRevision = -1;
let projects: Row[] = [], draftProject = "", desktopReady = false, listGeneration = 0;
const projectSelect = element<HTMLSelectElement>("project");
const nodes = new Map<string, { element: HTMLElement; signature: string }>();
const storageKey = "argus-desktop-web:";
const currentSlot = () => selected || (draftProject ? "draft:" + draftProject : "");
function stored(key: string): Row | null { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } }
function saveDraft() { const slot = currentSlot(); if (slot) localStorage.setItem(storageKey + "draft:" + slot, input.value); }

function notice(text = "") { element("notice").textContent = text; element("notice").hidden = !text; }
async function api(path: string, body?: Row, retry = true): Promise<Row> {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Argus-Token": token }, body: JSON.stringify(body) } : { cache: "no-store" });
  if (response.status === 403 && body && retry) { token = (await api("/api/session")).token; return api(path, body, false); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
function connection(ready: boolean, text?: string) {
  desktopReady = ready;
  element("connection").textContent = text ?? (ready ? "已连接 Mac" : "正在重新连接");
  element("dot").classList.toggle("ready", ready);
  if (selected || draftProject) { canSend = ready; controls(); }
}
function controls() {
  input.disabled = !canSend;
  element<HTMLButtonElement>("send").disabled = busy || !canSend || !input.value.trim();
  element("send").textContent = running ? "追加指令" : "发送";
  element("stop").hidden = !running || !activeTurn;
  element("hint").textContent = running ? "执行中 · 发送会向当前任务追加指令" : "Enter 发送 · Shift + Enter 换行";
}
function pathLabel(path: string) { return path?.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ") ?? ""; }
function renderThreads() {
  const query = element<HTMLInputElement>("search").value.toLowerCase();
  const list = element("threads"); list.replaceChildren();
  for (const thread of threads.filter(thread => `${thread.title} ${thread.cwd}`.toLowerCase().includes(query))) {
    const button = document.createElement("button"); button.className = "thread"; button.classList.toggle("selected", thread.id === selected);
    const title = document.createElement("span"); title.textContent = thread.title;
    const cwd = document.createElement("small"); cwd.textContent = pathLabel(thread.cwd); button.append(title, cwd);
    button.onclick = () => { void select(thread.id); if (innerWidth < 800) element("sidebar").classList.add("collapsed"); };
    list.append(button);
  }
  element("more-threads").hidden = !threadCursor;
}
async function loadThreads(more = false) {
  const requestGeneration = ++listGeneration;
  const params = new URLSearchParams();
  if (more && threadCursor) params.set("cursor", threadCursor);
  if (projectSelect.value) params.set("projectId", projectSelect.value);
  const result = await api(`/api/threads?${params}`);
  if (requestGeneration !== listGeneration) return;
  const byId = new Map((more ? threads : []).map(thread => [thread.id, thread]));
  for (const thread of result.threads) byId.set(thread.id, thread);
  threads = [...byId.values()]; threadCursor = result.nextCursor; renderThreads();
  const current = threads.find(thread => thread.id === selected);
  if (current) { element("title").textContent = current.title; element("workspace").textContent = current.cwd; }
}
async function loadProjects() {
  const result = await api("/api/projects"); projects = result.projects;
  const previous = projectSelect.value || localStorage.getItem(storageKey + "project") || "";
  projectSelect.replaceChildren(new Option("全部会话", ""), ...projects.map(project => new Option(project.name, project.id)));
  if (projects.some(project => project.id === previous)) projectSelect.value = previous;
}
function newChat(projectId = projectSelect.value) {
  const project = projects.find(project => project.id === projectId);
  if (!project) { notice("请先选择一个 Mac 项目，再新建对话。"); projectSelect.focus(); return; }
  saveDraft(); generation++; selected = ""; draftProject = projectId;
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  clearTimeout(reconnectTimer);
  running = false; activeTurn = ""; turns = new Map(); liveView = null; nodes.clear(); historyCursor = null;
  element("messages").replaceChildren(); element("requests").hidden = true; element("older").hidden = true;
  element("title").textContent = "新对话 · " + project.name; element("workspace").textContent = project.roots.join(" · ");
  element("runtime").textContent = "草稿"; element("empty").hidden = false;
  element("model").textContent = "项目默认模型与权限";
  element("empty-title").textContent = "在 " + project.name + " 开始工作";
  element("empty-text").textContent = "发送后会在 Mac 原 App 中创建并执行。草稿自动保存在本浏览器。";
  input.value = localStorage.getItem(storageKey + "draft:" + currentSlot()) ?? "";
  localStorage.setItem(storageKey + "selected", currentSlot()); canSend = desktopReady; renderThreads(); controls(); notice(); input.focus();
}
function renderMessage(message: Row): HTMLElement {
  if (message.type === "activity" || message.type === "reasoning") {
    const details = document.createElement("details"); details.className = "activity";
    const summary = document.createElement("summary"); summary.textContent = message.title ?? "思考过程";
    const text = document.createElement("pre"); text.textContent = [message.text, message.detail].filter(Boolean).join("\n"); details.append(summary, text); return details;
  }
  const div = document.createElement("div"); div.className = `message ${message.type}`;
  if (message.type === "user") div.textContent = message.text;
  else {
    div.innerHTML = DOMPurify.sanitize(marked.parse(message.text ?? "", { async: false }) as string, { FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe"], FORBID_ATTR: ["style"] });
    for (const link of div.querySelectorAll("a")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }
  return div;
}
function renderTurns() {
  const scroll = element("conversation"), atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 110;
  const list = element("messages");
  for (const turn of turns.values()) {
    if (!turn.id) continue;
    const signature = JSON.stringify(turn); const old = nodes.get(turn.id);
    if (old?.signature === signature) continue;
    const section = old?.element ?? document.createElement("article"); section.className = "turn";
    section.replaceChildren(...turn.messages.map(renderMessage));
    const status = document.createElement("div"); status.className = "turn-status";
    status.textContent = turn.error || ({ inProgress: "正在执行…", interrupted: "已停止", failed: "执行失败" } as Row)[turn.status] || "";
    if (status.textContent) section.append(status);
    nodes.set(turn.id, { element: section, signature });
    if (!old) list.append(section);
  }
  // Reorder existing nodes when an older history page is prepended.
  const order = [...turns.keys()]; let cursor = list.firstElementChild;
  for (const id of order) {
    const node = nodes.get(id)?.element;
    if (!node) continue;
    if (node !== cursor) list.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
  element("empty").hidden = turns.size > 0;
  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}
function mergeTurns(incoming: Row[], prepend = false) {
  const byClient = new Map<string, string>();
  for (const turn of incoming) for (const message of turn.messages ?? []) if (message.clientId) byClient.set(message.clientId, turn.id);
  for (const [id, turn] of turns) {
    if (turn.messages?.some((message: Row) => message.clientId && byClient.has(message.clientId) && byClient.get(message.clientId) !== id)) {
      turns.delete(id); nodes.get(id)?.element.remove(); nodes.delete(id);
    }
  }
  if (prepend) turns = new Map([...incoming.map(turn => [turn.id, turn] as [string, Row]), ...turns]);
  else for (const turn of incoming) turns.set(turn.id, turn);
  renderTurns();
}
function renderRequests(requests: Row[]) {
  const root = element("requests"); root.replaceChildren(); root.hidden = requests.length === 0;
  for (const request of requests) {
    const section = document.createElement("div"); section.className = "request";
    const title = document.createElement("strong"); title.textContent = "Mac 上的任务需要处理";
    const content = document.createElement("p"); content.textContent = request.params?.reason ?? request.params?.command ?? request.method ?? "请查看原 App";
    section.append(title, content);
    const method = request.method ?? request.request?.method;
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
      for (const [decision, label] of [["accept", "允许本次"], ["decline", "拒绝"]]) {
        const button = document.createElement("button"); button.textContent = label;
        button.onclick = () => { button.disabled = true; void api("/api/approval", { threadId: selected, requestId: request.id ?? request.requestId, decision }).catch(error => { notice(error.message); button.disabled = false; }); };
        section.append(button);
      }
    } else {
      const link = document.createElement("a"); link.href = "http://127.0.0.1:18942/"; link.target = "_blank"; link.rel = "noopener"; link.textContent = "在原窗口处理"; section.append(link);
    }
    root.append(section);
  }
}
function renderLiveView() {
  if (!liveView) return;
  const view = liveView;
  connection(true);
  element("model").textContent = [view.model, view.effort].filter(Boolean).join(" · ");
  running = view.status === "active" || view.turns.some((turn: Row) => turn.status === "inProgress");
  activeTurn = view.turns.filter((turn: Row) => turn.status === "inProgress").at(-1)?.id ?? "";
  element("runtime").textContent = running ? "Mac 正在执行" : "已同步";
  mergeTurns(view.turns); renderRequests([...(view.requests ?? []), ...(view.externalRequests ?? [])]); controls();
}
function applyViewPatch(patch: Row) {
  if (!liveView || !Array.isArray(patch.path) || patch.path.some((key: unknown) => ["__proto__", "prototype", "constructor"].includes(String(key)))) throw new Error("Invalid view patch");
  if (!patch.path.length) { liveView = patch.value; return; }
  let target: any = liveView;
  for (const key of patch.path.slice(0, -1)) target = target[key];
  const key = patch.path.at(-1);
  if (patch.op === "append") target[key] += patch.value;
  else if (patch.op === "remove") { if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key]; }
  else target[key] = patch.value;
}
function connectStream(id: string, currentGeneration: number) {
  if (socket) { socket.onclose = null; socket.close(); }
  clearTimeout(reconnectTimer);
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events`); socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", threadId: id, token }));
  ws.onmessage = event => {
    if (generation !== currentGeneration) return;
    const message = JSON.parse(event.data);
    if (message.type === "connection") connection(message.connected);
    if (message.type === "error") notice(message.error);
    if (message.type === "snapshot" && message.threadId === selected) {
      liveView = message.view; liveRevision = message.revision; renderLiveView();
    }
    if (message.type === "patches" && message.threadId === selected) {
      try {
        if (!liveView || liveRevision !== message.baseRevision) throw new Error("Stream revision changed");
        for (const patch of message.patches) applyViewPatch(patch);
        liveRevision = message.revision; renderLiveView();
      } catch { ws.close(); }
    }
    if (message.type === "resync") void loadHistory(false).catch(error => notice(error.message));
  };
  ws.onclose = () => {
    if (generation !== currentGeneration) return;
    connection(false);
    reconnectTimer = window.setTimeout(async () => {
      try { token = (await api("/api/session")).token; connectStream(id, currentGeneration); await loadHistory(false); }
      catch { if (generation === currentGeneration) connectStream(id, currentGeneration); }
    }, 2500);
  };
}
async function loadHistory(older: boolean) {
  const id = selected, currentGeneration = generation;
  const result = await api(`/api/history?threadId=${encodeURIComponent(id)}${older && historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ""}`);
  if (selected !== id || generation !== currentGeneration) return;
  const scroll = element("conversation"), oldHeight = scroll.scrollHeight, oldTop = scroll.scrollTop;
  if (older || !historyCursor) historyCursor = result.nextCursor;
  mergeTurns(result.turns, older); element("older").hidden = !historyCursor;
  if (older) scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
  else scroll.scrollTop = scroll.scrollHeight;
}
async function select(id: string) {
  saveDraft();
  const currentGeneration = ++generation; selected = id; draftProject = ""; canSend = false; running = false; activeTurn = ""; historyCursor = null; turns = new Map(); liveView = null; liveRevision = -1; nodes.clear();
  element("messages").replaceChildren(); element("requests").hidden = true; input.value = localStorage.getItem(storageKey + "draft:" + id) ?? "";
  localStorage.setItem(storageKey + "selected", id);
  const thread = threads.find(thread => thread.id === id); element("title").textContent = thread?.title ?? "Mac 会话"; element("workspace").textContent = thread?.cwd ?? "";
  renderThreads(); controls(); notice("正在加载并连接 Mac 上的会话…");
  element("empty-title").textContent = "继续 Mac 上的工作"; element("empty-text").textContent = "正在读取会话…";
  try {
    await api("/api/select", { threadId: id });
    if (generation !== currentGeneration) return;
    canSend = true; notice(); connectStream(id, currentGeneration); controls();
    await loadHistory(false).catch(error => { if (generation === currentGeneration) notice("历史暂未就绪：" + error.message); });
    const settings = (await api(`/api/settings?threadId=${id}`)).settings;
    if (generation === currentGeneration && settings) element("model").textContent = [settings.model, settings.reasoningEffort].filter(Boolean).join(" · ");
  } catch (error) { if (generation === currentGeneration) notice((error as Error).message); }
}

form.onsubmit = async event => {
  event.preventDefault(); if (busy || !canSend || !input.value.trim()) return;
  let id = selected;
  const slot = currentSlot(), projectId = draftProject, text = input.value;
  const prior = stored(storageKey + "pending:" + slot);
  const mode = prior?.text === text ? prior.mode : running ? "steer" : "send";
  const messageId = prior?.text === text ? prior.id : crypto.randomUUID();
  const creationId = projectId ? prior?.creationId ?? crypto.randomUUID() : undefined;
  localStorage.setItem(storageKey + "pending:" + slot, JSON.stringify({ id: messageId, text, mode, creationId })); saveDraft();
  busy = true; controls(); notice("正在提交到 Mac…");
  try {
    if (projectId) {
      const { creation } = await api("/api/new", { projectId, clientCreationId: creationId, title: text });
      if (!creation.threadId) throw new Error(`新建状态：${creation.state}。${creation.note ?? ""} 创建编号 ${creationId} 已保存；不会自动重复创建。`);
      id = creation.threadId;
      localStorage.setItem(storageKey + "draft:" + id, text);
      localStorage.setItem(storageKey + "pending:" + id, JSON.stringify({ id: messageId, text, mode }));
      await loadThreads();
      if (!threads.some(thread => thread.id === id)) {
        const project = projects.find(project => project.id === projectId);
        threads.unshift({id, title: text.split("\n")[0].slice(0,60), cwd: project?.roots[0] ?? "", projectId});
      }
      await select(id);
      if (!canSend || selected !== id) throw new Error("对话已创建，原 App 尚未就绪；请刷新后继续。草稿和编号已保留。");
    }
    const { delivery } = await api("/api/input", { threadId: id, text, mode, clientMessageId: messageId });
    if (["started", "completed"].includes(delivery.state)) {
      if (selected === id && input.value === text) input.value = "";
      for (const key of new Set([slot, id])) {
        if (localStorage.getItem(storageKey + "draft:" + key) === text) localStorage.removeItem(storageKey + "draft:" + key);
        if (stored(storageKey + "pending:" + key)?.id === messageId) localStorage.removeItem(storageKey + "pending:" + key);
      }
      notice(); void loadThreads().catch(() => {});
    } else notice(`投递状态：${delivery.state}。${delivery.note ?? ""} 消息编号 ${messageId} 已保存，再次提交同一消息不会重复执行。`);
  } catch (error) { notice(`连接中断，暂不能确定执行结果。消息编号 ${messageId} 已保存；请先检查回复。${(error as Error).message}`); }
  finally { busy = false; controls(); }
};
input.oninput = () => { saveDraft(); controls(); };
input.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); form.requestSubmit(); } };
element("stop").onclick = () => { void api("/api/interrupt", { threadId: selected, turnId: activeTurn }).catch(error => notice(error.message)); };
element<HTMLInputElement>("search").oninput = renderThreads;
element("refresh").onclick = () => { void loadProjects().then(() => loadThreads()).catch(error => notice(error.message)); };
projectSelect.onchange = () => { localStorage.setItem(storageKey + "project", projectSelect.value); void loadThreads().catch(error => notice(error.message)); };
element("new-chat").onclick = () => newChat();
element("more-threads").onclick = () => { void loadThreads(true).catch(error => notice(error.message)); };
element("older").onclick = () => { void loadHistory(true).catch(error => notice(error.message)); };
element("menu").onclick = () => element("sidebar").classList.toggle("collapsed");
if (innerWidth < 800) element("sidebar").classList.add("collapsed");
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, 20000);
setInterval(() => {
  if (!selected) void api("/api/status").then(status => connection(status.desktopConnected)).catch(() => connection(false));
}, 5000);
async function start() {
  try {
    token = (await api("/api/session")).token; await loadProjects(); await loadThreads();
    const status = await api("/api/status"); desktopReady = status.desktopConnected;
    const previous = localStorage.getItem(storageKey + "selected");
    if (previous?.startsWith("draft:")) newChat(previous.slice(6));
    else if (previous && threads.some(thread => thread.id === previous)) await select(previous);
    else connection(desktopReady, desktopReady ? "Mac 已连接 · 选择会话" : "等待 Mac App");
  } catch (error) { connection(false); notice((error as Error).message); setTimeout(start, 5000); }
}
void start();
