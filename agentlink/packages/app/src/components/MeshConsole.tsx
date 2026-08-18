import { useEffect, useMemo, useState } from "react";

type PeerStatus = "offline" | "connecting" | "online" | "error";
type TaskStatus = "queued" | "running" | "completed" | "denied" | "approval-required" | "failed" | "cancelled";
type ResourceStatusState = "ready" | "degraded" | "error" | "unknown";

interface GpuDeviceStatus {
  index: number;
  name: string;
  temperatureC: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  utilizationGpuPercent: number | null;
  driverVersion: string | null;
}

interface ResourceStatus {
  state: ResourceStatusState;
  summary: string;
  observedAt: string;
  error?: string;
  gpu?: { devices: GpuDeviceStatus[] };
}

interface Resource {
  id: string;
  ownerNodeId: string;
  kind: string;
  displayName: string;
  rootHint: string;
  capabilities?: string[];
  runnerIds?: string[];
  statusRunnerId?: string;
  status?: ResourceStatus;
  nodeId: string;
  deviceName: string;
}

interface Peer {
  fingerprint: string;
  deviceName: string;
  platform: string;
  status: PeerStatus;
  lastSeen: number | null;
  error: string | null;
  resources: Resource[];
}

interface Task {
  taskId: string;
  groupId: string;
  targetNodeId: string;
  resourceId: string;
  operation: string;
  status: TaskStatus;
  decision?: string;
  message?: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
}

interface Overview {
  controllerNodeId: string;
  generatedAt: number;
  peers: Peer[];
  resources: Resource[];
  tasks: Task[];
}

const statusText: Record<PeerStatus | TaskStatus, string> = {
  offline: "离线",
  connecting: "连接中",
  online: "在线",
  error: "错误",
  queued: "排队",
  running: "运行中",
  completed: "完成",
  denied: "已拒绝",
  "approval-required": "待审批",
  failed: "失败",
  cancelled: "已取消",
};

export default function MeshConsole() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [groupId, setGroupId] = useState("group-alpha");
  const [operation, setOperation] = useState("inspect");
  const [scopeJson, setScopeJson] = useState('{"runnerId":"","args":[],"timeoutMs":600000}');
  const [grantJson, setGrantJson] = useState("");
  const [approvalJson, setApprovalJson] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function loadOverview() {
    try {
      const response = await fetch("/api/overview", { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const next = await response.json() as Overview;
      setOverview(next);
      setError(null);
      setTargetNodeId((current) => current || next.peers[0]?.fingerprint || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const target = overview?.peers.find((peer) => peer.fingerprint === targetNodeId);
  const targetResources = overview?.resources.filter((resource) => resource.nodeId === targetNodeId) ?? target?.resources ?? [];
  const selectedResource = targetResources.find((resource) => resource.id === resourceId);

  useEffect(() => {
    if (targetResources.length > 0 && !targetResources.some((resource) => resource.id === resourceId)) {
      setResourceId(targetResources[0].id);
    }
  }, [resourceId, targetResources]);

  const onlineCount = overview?.peers.filter((peer) => peer.status === "online").length ?? 0;
  const runningCount = overview?.tasks.filter((task) => task.status === "running").length ?? 0;

  async function refresh() {
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await loadOverview();
    } finally {
      setRefreshing(false);
    }
  }

  async function submitTask() {
    if (!targetNodeId || !resourceId) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { targetNodeId, resourceId, groupId, operation };
      if (operation !== "inspect") {
        body.scope = JSON.parse(scopeJson);
        body.grant = JSON.parse(grantJson);
        body.approval = JSON.parse(approvalJson);
      }
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      await loadOverview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-slate-950">
      <header className="border-b border-slate-200/80 bg-white/90 px-6 py-5 backdrop-blur lg:px-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#007aff]" />
              <h1 className="text-xl font-semibold tracking-tight">Argus Mesh</h1>
            </div>
            <p className="mt-1 text-sm text-slate-500">Seoul 控制台</p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-500 disabled:cursor-wait disabled:opacity-50"
          >
            {refreshing ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 lg:px-10">
        {error && <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <section className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-3xl font-semibold tracking-tight">设备状态</p>
            <p className="mt-2 text-sm text-slate-500">
              {onlineCount} 台在线 · {overview?.resources.length ?? 0} 个资源 · {runningCount} 个任务运行中 · 状态约每 60 秒刷新
            </p>
          </div>
          <div className="text-right text-xs text-slate-400">
            控制节点<br />{shortId(overview?.controllerNodeId ?? "—")}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-4">
                <h2 className="font-semibold">节点</h2>
              </div>
              <div className="divide-y divide-slate-100">
                {(overview?.peers ?? []).map((peer) => (
                  <button
                    key={peer.fingerprint}
                    type="button"
                    onClick={() => setTargetNodeId(peer.fingerprint)}
                    className={`flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-slate-50 ${targetNodeId === peer.fingerprint ? "bg-blue-50/60" : ""}`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <StatusDot status={peer.status} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{peer.deviceName}</span>
                        <span className="mt-1 block text-xs text-slate-500">{peer.platform} · {shortId(peer.fingerprint)}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-sm text-slate-500">{peer.resources.length} 个资源</span>
                  </button>
                ))}
                {(overview?.peers.length ?? 0) === 0 && <Empty text="还没有已配对节点" />}
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <h2 className="font-semibold">资源</h2>
                <span className="text-sm text-slate-500">{target ? target.deviceName : "全部节点"}</span>
              </div>
              <div className="divide-y divide-slate-100">
                {targetResources.map((resource) => (
                  <div key={`${resource.nodeId}:${resource.id}`} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{resource.displayName}</p>
                      <p className="mt-1 text-xs text-slate-500">{resource.kind} · {resource.id}</p>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <p>{resource.capabilities?.join(" · ") || "无能力声明"}</p>
                      {resource.runnerIds?.length ? <p className="mt-1 text-slate-400">runner {resource.runnerIds.join(", ")}</p> : null}
                    </div>
                  </div>
                ))}
                {targetResources.length === 0 && <Empty text="尚未发现资源" />}
              </div>
            </div>

            <GpuStatusPanel
              resource={selectedResource}
              refreshing={refreshing}
              onRefresh={() => void refresh()}
            />

            <TaskList tasks={overview?.tasks ?? []} peers={overview?.peers ?? []} />
          </div>

          <TaskComposer
            peers={overview?.peers ?? []}
            resources={targetResources}
            targetNodeId={targetNodeId}
            resourceId={resourceId}
            groupId={groupId}
            operation={operation}
            scopeJson={scopeJson}
            grantJson={grantJson}
            approvalJson={approvalJson}
            setTargetNodeId={setTargetNodeId}
            setResourceId={setResourceId}
            setGroupId={setGroupId}
            setOperation={setOperation}
            setScopeJson={setScopeJson}
            setGrantJson={setGrantJson}
            setApprovalJson={setApprovalJson}
            onSubmit={() => void submitTask()}
            submitting={submitting}
            selectedResource={selectedResource}
          />
        </section>
      </main>
    </div>
  );
}

function GpuStatusPanel({
  resource,
  refreshing,
  onRefresh,
}: {
  resource?: Resource;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (!resource || resource.kind !== "gpu") return null;
  const status = resource.status;
  const devices = status?.gpu?.devices ?? [];
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="font-semibold">GPU 状态</h2>
          <p className="mt-1 text-sm text-slate-500">
            {status ? `${status.summary} · ${formatObservedAt(status.observedAt)}` : "等待第一次状态读取"}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-500 disabled:cursor-wait disabled:opacity-50"
        >
          {refreshing ? "刷新中" : "刷新 GPU"}
        </button>
      </div>
      {!status && <Empty text="尚未返回 GPU 状态" />}
      {status && devices.length > 0 && (
        <div className="divide-y divide-slate-100">
          {devices.map((device) => (
            <div key={`${device.index}-${device.name}`} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_110px_140px_120px] sm:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${status.state === "ready" ? "bg-emerald-500" : "bg-amber-400"}`} />
                <div className="min-w-0">
                  <p className="truncate font-medium">GPU {device.index} · {device.name}</p>
                  <p className="mt-1 text-xs text-slate-500">驱动 {device.driverVersion ?? "未知"}</p>
                </div>
              </div>
              <Metric label="利用率" value={formatPercent(device.utilizationGpuPercent)} />
              <Metric label="显存" value={`${formatMiB(device.memoryUsedMiB)} / ${formatMiB(device.memoryTotalMiB)} MiB`} />
              <Metric label="温度" value={device.temperatureC === null ? "—" : `${Math.round(device.temperatureC)}°C`} />
            </div>
          ))}
        </div>
      )}
      {status?.state === "error" && <p className="px-5 py-4 text-sm text-red-700">{status.error ?? "GPU 状态读取失败"}</p>}
      {status && devices.length === 0 && status.state !== "error" && <Empty text="没有发现 GPU 设备" />}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-800">{value}</p>
    </div>
  );
}

function TaskComposer(props: {
  peers: Peer[];
  resources: Resource[];
  targetNodeId: string;
  resourceId: string;
  groupId: string;
  operation: string;
  scopeJson: string;
  grantJson: string;
  approvalJson: string;
  setTargetNodeId: (value: string) => void;
  setResourceId: (value: string) => void;
  setGroupId: (value: string) => void;
  setOperation: (value: string) => void;
  setScopeJson: (value: string) => void;
  setGrantJson: (value: string) => void;
  setApprovalJson: (value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  selectedResource?: Resource;
}) {
  const hasRunner = (props.selectedResource?.runnerIds?.length ?? 0) > 0;
  return (
    <aside className="h-fit rounded-2xl border border-slate-200 bg-white p-5 lg:sticky lg:top-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">提交任务</h2>
          <p className="mt-1 text-sm text-slate-500">先选节点，再选本地资源。</p>
        </div>
        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-[#007aff]">typed</span>
      </div>

      <div className="mt-6 space-y-4">
        <Field label="目标节点">
          <select value={props.targetNodeId} onChange={(event) => props.setTargetNodeId(event.target.value)} className="input">
            <option value="">选择节点</option>
            {props.peers.map((peer) => <option key={peer.fingerprint} value={peer.fingerprint}>{peer.deviceName}</option>)}
          </select>
        </Field>
        <Field label="资源">
          <select value={props.resourceId} onChange={(event) => props.setResourceId(event.target.value)} className="input">
            <option value="">选择资源</option>
            {props.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.displayName}</option>)}
          </select>
        </Field>
        <Field label="Group">
          <input value={props.groupId} onChange={(event) => props.setGroupId(event.target.value)} className="input" placeholder="group-alpha" />
        </Field>
        <Field label="操作">
          <select value={props.operation} onChange={(event) => props.setOperation(event.target.value)} className="input">
            <option value="inspect">inspect · 只读</option>
            <option value="run" disabled={!hasRunner}>run · named runner</option>
          </select>
        </Field>
        {props.operation === "run" && (
          <div className="space-y-3 border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-amber-700">run 需要目标所有者的 grant 与 approval</p>
            <textarea value={props.scopeJson} onChange={(event) => props.setScopeJson(event.target.value)} className="code-input" aria-label="runner scope" />
            <textarea value={props.grantJson} onChange={(event) => props.setGrantJson(event.target.value)} className="code-input" placeholder="grant JSON" aria-label="grant JSON" />
            <textarea value={props.approvalJson} onChange={(event) => props.setApprovalJson(event.target.value)} className="code-input" placeholder="approval JSON" aria-label="approval JSON" />
          </div>
        )}
        <button
          type="button"
          onClick={props.onSubmit}
          disabled={props.submitting || !props.targetNodeId || !props.resourceId}
          className="w-full rounded-xl bg-[#007aff] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#006de0] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.submitting ? "提交中" : "提交任务"}
        </button>
      </div>
    </aside>
  );
}

function TaskList({ tasks, peers }: { tasks: Task[]; peers: Peer[] }) {
  const names = useMemo(() => new Map(peers.map((peer) => [peer.fingerprint, peer.deviceName])), [peers]);
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 className="font-semibold">任务</h2>
        <span className="text-sm text-slate-500">最近 100 条</span>
      </div>
      <div className="divide-y divide-slate-100">
        {tasks.map((task) => (
          <div key={task.taskId} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{task.operation} · {task.resourceId}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{names.get(task.targetNodeId) ?? shortId(task.targetNodeId)} · {shortId(task.taskId)}</p>
            </div>
            <span className={`status status-${task.status}`}>{statusText[task.status] ?? task.status}</span>
          </div>
        ))}
        {tasks.length === 0 && <Empty text="还没有任务" />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>{children}</label>;
}

function StatusDot({ status }: { status: PeerStatus }) {
  const color = status === "online" ? "bg-emerald-500" : status === "error" ? "bg-red-500" : status === "connecting" ? "bg-amber-400" : "bg-slate-300";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
}

function Empty({ text }: { text: string }) {
  return <div className="px-5 py-10 text-center text-sm text-slate-400">{text}</div>;
}

function formatObservedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp))}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function formatMiB(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}`;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
