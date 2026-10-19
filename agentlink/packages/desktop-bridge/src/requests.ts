import type { Message } from "./ipc";

export function nativeRequest(entry: Message): Message {
  return { id: entry.id ?? entry.requestId ?? entry.request?.id ?? entry.request?.requestId,
    method: entry.method ?? entry.request?.method, params: entry.params ?? entry.request?.params ?? {} };
}

export function pendingRequests(state: Message): Message[] {
  const unique = new Map<string, Message>();
  for (const entry of [...(Array.isArray(state.requests) ? state.requests : []), ...(Array.isArray(state.externalRequests) ? state.externalRequests : [])]) {
    const request = nativeRequest(entry);
    unique.set(JSON.stringify([request.method, request.id]), request);
  }
  return [...unique.values()];
}

const kindByMethod: Record<string, string> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file",
};
const labels: Record<string, string> = { accept: "允许本次", acceptForSession: "允许本会话", decline: "拒绝", cancel: "取消操作" };

export function approvalActions(request: Message): Message[] {
  if (!kindByMethod[request.method] || request.id == null) return [];
  const decisions = Array.isArray(request.params.availableDecisions) ? request.params.availableDecisions : ["accept", "decline"];
  return decisions.flatMap((value: any) => {
    const label = typeof value === "string" ? labels[value] : value?.acceptWithExecpolicyAmendment ? "允许并记住此命令规则" : value?.applyNetworkPolicyAmendment ? "应用网络规则" : null;
    return label ? [{ label, value: structuredClone(value) }] : [];
  });
}

/** Keep both the explanation and the exact command; never choose one over the other. */
export function publicRequest(request: Message): Message {
  const params = request.params;
  return { id: request.id, method: request.method, kind: kindByMethod[request.method] ?? "other",
    reason: params.reason ?? params.message ?? null, command: params.command ?? null, cwd: params.cwd ?? null,
    details: structuredClone(params), actions: approvalActions(request) };
}

export function approvalTarget(state: Message, requestId: string | number, method: string, decision: unknown): { request: Message; kind: string } {
  const request = pendingRequests(state).find(entry => String(entry.id) === String(requestId) && entry.method === method);
  if (!request) throw new Error("该审批已结束或尚未同步，请刷新会话");
  const kind = kindByMethod[request.method];
  if (!kind || !approvalActions(request).some(action => JSON.stringify(action.value) === JSON.stringify(decision))) throw new Error("此审批不支持该操作，请刷新会话");
  return { request, kind };
}
