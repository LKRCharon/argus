import type { Message } from "./ipc";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Apply only data patches; never traverse prototypes received from another process. */
export function applyPatches(state: Message, patches: Message[]): Message {
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some((key: unknown) => typeof key !== "number" && typeof key !== "string" || forbidden.has(String(key)))) {
      throw new Error("Invalid desktop patch path");
    }
    if (!patch.path.length) {
      if (patch.op !== "replace" || !patch.value || typeof patch.value !== "object") throw new Error("Invalid root patch");
      state = structuredClone(patch.value);
      continue;
    }
    let parent: any = state;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) throw new Error("Desktop patch does not match snapshot");
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (!parent || typeof parent !== "object") throw new Error("Invalid desktop patch target");
    if (patch.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (patch.op === "add" || patch.op === "replace") {
      if (Array.isArray(parent) && patch.op === "add") parent.splice(Number(key), 0, structuredClone(patch.value));
      else parent[key] = structuredClone(patch.value);
    } else throw new Error("Unsupported desktop patch operation");
  }
  return state;
}

export function desktopTurns(state: Message): Message[] {
  const history = state.turnHistory?.kind === "canonical" ? state.turnHistory.history : null;
  if (history?.entitiesByKey && Array.isArray(history.islands)) {
    return history.islands.flatMap((island: Message) => (island.entries ?? []).map((entry: Message) => history.entitiesByKey[entry.value]).filter(Boolean));
  }
  return Array.isArray(state.turns) ? state.turns : [];
}

function textContent(content: unknown): string {
  return Array.isArray(content) ? content.filter(item => item?.type === "text").map(item => item.text ?? "").join("") : "";
}

/** Browser data intentionally excludes developer instructions, paths to logs, and raw tools. */
export function publicTurn(turn: Message): Message {
  const messages: Message[] = [];
  const confirmed = new Set((turn.items ?? []).filter((item: Message) => item.type === "userMessage").map((item: Message) => item.clientId).filter(Boolean));
  let hasUser = false;
  for (const item of turn.items ?? []) {
    if (item.type === "userMessage") {
      hasUser = true;
      messages.push({ id: item.id, type: "user", text: textContent(item.content), clientId: item.clientId });
    } else if (item.type === "steeringUserMessage" && !confirmed.has(item.clientUserMessageId)) {
      messages.push({ id: item.id, type: "user", text: textContent(item.input), clientId: item.clientUserMessageId });
    } else if (item.type === "agentMessage" && typeof item.text === "string") {
      messages.push({ id: item.id, type: "assistant", text: item.text, phase: item.phase });
    } else if (item.type === "reasoning") {
      const text = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].map(value => typeof value === "string" ? value : value?.text ?? "").join("\n");
      if (text) messages.push({ id: item.id, type: "reasoning", text });
    } else if (item.type === "commandExecution") {
      messages.push({ id: item.id, type: "activity", title: "运行命令", text: String(item.command ?? ""), detail: String(item.aggregatedOutput ?? "").slice(-16000), status: item.status });
    } else if (item.type === "fileChange") {
      messages.push({ id: item.id, type: "activity", title: "修改文件", text: (item.changes ?? []).map((change: Message) => change.path).filter(Boolean).join("\n"), status: item.status });
    } else if (item.type === "mcpToolCall") {
      messages.push({ id: item.id, type: "activity", title: `${item.server ?? "MCP"} / ${item.tool ?? "tool"}`, text: item.status ?? "" });
    } else if (item.type === "plan") {
      messages.push({ id: item.id, type: "activity", title: "计划", text: item.text ?? "" });
    }
  }
  if (!hasUser && turn.params?.input?.length) {
    messages.unshift({ id: `${turn.turnId ?? turn.id ?? turn.params.clientUserMessageId}:pending-user`, type: "user", text: textContent(turn.params.input), clientId: turn.params.clientUserMessageId });
  }
  return { id: turn.turnId ?? turn.id ?? turn.params?.clientUserMessageId, status: turn.status, messages, error: turn.error?.message ?? null };
}

export function publicState(state: Message): Message {
  return {
    id: state.id, title: state.title, cwd: state.cwd,
    model: state.latestModel, effort: state.latestReasoningEffort,
    status: state.threadRuntimeStatus?.type ?? "unknown",
    turns: desktopTurns(state).slice(-10).map(publicTurn),
    // Requests are rendered as explicit user actions and never auto-approved.
    requests: Array.isArray(state.requests) ? structuredClone(state.requests) : [],
    externalRequests: Array.isArray(state.externalRequests) ? structuredClone(state.externalRequests) : [],
  };
}

export function textInput(text: string): Message[] {
  // Desktop optimistic rendering reads this field before app-server adds defaults.
  return [{ type: "text", text, text_elements: [] }];
}

/** Send appended reply characters instead of retransmitting the chat at every token. */
export function viewDiff(before: any, after: any, path: (string | number)[] = [], patches: Message[] = []): Message[] {
  if (before === after) return patches;
  if (typeof before === "string" && typeof after === "string" && after.startsWith(before) && before.length > 32) {
    patches.push({ op: "append", path, value: after.slice(before.length) }); return patches;
  }
  if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after)) {
    if (Array.isArray(before) && before.length !== after.length) { patches.push({ op: "replace", path, value: after }); return patches; }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = [...path, Array.isArray(after) ? Number(key) : key];
      if (!Object.hasOwn(after, key)) patches.push({ op: "remove", path: childPath });
      else if (!Object.hasOwn(before, key)) patches.push({ op: "replace", path: childPath, value: after[key] });
      else viewDiff(before[key], after[key], childPath, patches);
    }
    return patches;
  }
  patches.push({ op: "replace", path, value: after }); return patches;
}
