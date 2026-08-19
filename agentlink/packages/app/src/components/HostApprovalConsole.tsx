import { useCallback, useEffect, useRef, useState } from "react";

type Decision = "allow-once" | "deny";

interface HostApproval {
  taskId: string;
  groupId: string;
  requesterNodeId: string;
  resourceId: string;
  operation: string;
  status: string;
  summary: string;
  runnerId?: string;
  args?: string[];
  createdAt: string | number;
}

interface HostApprovalsResponse {
  nodeId: string;
  approvals: HostApproval[];
}

const terminalStatuses = new Set([
  "allow-once",
  "allowed",
  "approved",
  "deny",
  "denied",
  "expired",
  "cancelled",
  "completed",
  "failed",
]);

export default function HostApprovalConsole() {
  const [response, setResponse] = useState<HostApprovalsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState<Record<string, Decision>>({});
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const activeRequest = useRef<AbortController | null>(null);

  const loadApprovals = useCallback(async (manual = false) => {
    if (activeRequest.current) {
      if (!manual) return;
      activeRequest.current.abort();
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    if (manual) setRefreshing(true);

    try {
      const nextResponse = await fetch("/api/approvals", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!nextResponse.ok) throw new Error(await readError(nextResponse));

      const payload = await nextResponse.json() as HostApprovalsResponse;
      if (typeof payload?.nodeId !== "string" || !Array.isArray(payload.approvals)) {
        throw new Error("审批列表格式无效");
      }

      setResponse(payload);
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setLoadError(errorMessage(cause));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
      }
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadApprovals();
    const timer = window.setInterval(() => void loadApprovals(), 5_000);
    return () => {
      window.clearInterval(timer);
      const controller = activeRequest.current;
      activeRequest.current = null;
      controller?.abort();
    };
  }, [loadApprovals]);

  async function submitDecision(taskId: string, decision: Decision) {
    setSubmitting((current) => ({ ...current, [taskId]: decision }));
    setDecisionErrors((current) => omitKey(current, taskId));

    try {
      const decisionResponse = await fetch(`/api/approvals/${encodeURIComponent(taskId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!decisionResponse.ok) throw new Error(await readError(decisionResponse));

      setResponse((current) => current ? {
        ...current,
        approvals: current.approvals.map((approval) => approval.taskId === taskId
          ? { ...approval, status: decision === "allow-once" ? "allowed" : "denied" }
          : approval),
      } : current);
      activeRequest.current?.abort();
      activeRequest.current = null;
      await loadApprovals();
    } catch (cause) {
      setDecisionErrors((current) => ({ ...current, [taskId]: errorMessage(cause) }));
    } finally {
      setSubmitting((current) => omitKey(current, taskId));
    }
  }

  const approvals = response?.approvals ?? [];
  const initialLoading = response === null && loadError === null;

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-slate-950">
      <header className="border-b border-slate-200/80 bg-white/90 px-5 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-5">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">审批请求</h1>
            <p className="mt-1 truncate text-sm text-slate-500" title={response?.nodeId}>
              {response?.nodeId ? `目标节点 ${response.nodeId}` : "正在读取目标节点"} · 约 5 秒刷新
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadApprovals(true)}
            disabled={refreshing}
            className="shrink-0 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-500 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-[#007aff]/25 disabled:cursor-wait disabled:opacity-50"
          >
            {refreshing ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-7 sm:px-8 sm:py-10">
        {loadError && (
          <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {initialLoading && <EmptyState text="正在读取审批请求" />}
        {!initialLoading && approvals.length === 0 && <EmptyState text="暂无审批请求" />}

        <div className="space-y-4">
          {approvals.map((approval) => (
            <ApprovalItem
              key={approval.taskId}
              approval={approval}
              submitting={submitting[approval.taskId]}
              error={decisionErrors[approval.taskId]}
              onDecision={(decision) => void submitDecision(approval.taskId, decision)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function ApprovalItem({
  approval,
  submitting,
  error,
  onDecision,
}: {
  approval: HostApproval;
  submitting?: Decision;
  error?: string;
  onDecision: (decision: Decision) => void;
}) {
  const actionable = !terminalStatuses.has(approval.status.toLowerCase());

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-900/[0.02]">
      <div className="px-5 pt-5 sm:px-6 sm:pt-6">
        <div className="flex items-start justify-between gap-4">
          <p className="min-w-0 text-lg font-semibold leading-7 tracking-tight">
            {approval.summary || `${approval.operation} · ${approval.resourceId}`}
          </p>
          <span className={statusClass(approval.status)}>{statusLabel(approval.status)}</span>
        </div>

        <dl className="mt-5 grid gap-x-8 gap-y-4 border-t border-slate-100 py-5 sm:grid-cols-2">
          <Detail label="资源" value={approval.resourceId} mono />
          <Detail label="操作" value={approval.operation} mono />
          <Detail label="Runner" value={approval.runnerId || "未指定"} mono />
          <Detail label="请求时间" value={formatCreatedAt(approval.createdAt)} />
          <Detail label="请求者" value={approval.requesterNodeId} mono wide />
          <Detail label="协作组" value={approval.groupId} mono wide />
          <Detail label="参数" value={approval.args?.length ? approval.args.join(" ") : "无额外参数"} mono wide />
        </dl>
      </div>

      {error && (
        <p role="alert" className="border-t border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700 sm:px-6">
          {error}
        </p>
      )}

      {actionable && (
        <div className="flex gap-3 border-t border-slate-200 bg-slate-50/70 px-5 py-4 sm:justify-end sm:px-6">
          <button
            type="button"
            onClick={() => onDecision("deny")}
            disabled={Boolean(submitting)}
            className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-red-300 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/20 disabled:cursor-wait disabled:opacity-50 sm:flex-none sm:min-w-28"
          >
            {submitting === "deny" ? "拒绝中" : "拒绝"}
          </button>
          <button
            type="button"
            onClick={() => onDecision("allow-once")}
            disabled={Boolean(submitting)}
            className="flex-1 rounded-xl bg-[#007aff] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#006ee6] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-50 sm:flex-none sm:min-w-32"
          >
            {submitting === "allow-once" ? "允许中" : "允许一次"}
          </button>
        </div>
      )}
    </article>
  );
}

function Detail({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`mt-1 break-words text-sm leading-6 text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-24 text-center text-sm text-slate-500">{text}</p>;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待处理",
    requested: "待处理",
    "approval-required": "待处理",
    queued: "待处理",
    "allow-once": "已允许一次",
    allowed: "已允许一次",
    approved: "已允许一次",
    deny: "已拒绝",
    denied: "已拒绝",
    expired: "已过期",
    cancelled: "已取消",
    completed: "已完成",
    failed: "处理失败",
  };
  return labels[status.toLowerCase()] ?? status;
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();
  const base = "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold";
  if (["allow-once", "allowed", "approved", "completed"].includes(normalized)) {
    return `${base} bg-emerald-50 text-emerald-700`;
  }
  if (["deny", "denied", "failed"].includes(normalized)) {
    return `${base} bg-red-50 text-red-700`;
  }
  if (["expired", "cancelled"].includes(normalized)) {
    return `${base} bg-slate-100 text-slate-600`;
  }
  return `${base} bg-amber-50 text-amber-700`;
}

function formatCreatedAt(value: string | number) {
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

async function readError(response: Response) {
  const text = (await response.text()).trim();
  if (!text) return `请求失败（${response.status}）`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
    return `请求失败（${response.status}）`;
  } catch {
    return text;
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function omitKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}
