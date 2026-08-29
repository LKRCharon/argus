import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

type DelegationJobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "verifying"
  | "approval-required"
  | "completed"
  | "denied"
  | "failed"
  | "cancelled";

type JobAction = "cancel" | "approve" | "deny";

interface DelegationProject {
  id: string;
  name?: string;
  displayName?: string;
  domain?: string;
  modes?: string[];
  allowedDomains?: string[];
  allowedModes?: string[];
  enabled?: boolean;
}

interface DelegationPrincipal {
  id: string;
  label: string;
  projectIds: string[];
  modes: string[];
  createdAt?: string | number;
  expiresAt?: string | number | null;
  revokedAt?: string | number | null;
  status?: string;
}

interface AcceptanceEvidence {
  criterion?: string;
  label?: string;
  name?: string;
  status?: string;
  evidence?: string;
  detail?: string;
}

interface DelegationProgress {
  phase?: string;
  step?: string;
  label?: string;
  message?: string;
  percent?: number;
  current?: number;
  total?: number;
  completedUnits?: number;
  totalUnits?: number;
}

interface ChangedFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

interface DelegationCheck {
  name?: string;
  status?: string;
  summary?: string;
  detail?: string;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
}

interface DelegationRisk {
  summary?: string;
  level?: string;
  mitigation?: string;
}

interface DelegationJob {
  id: string;
  status: DelegationJobStatus;
  phase?: "accepted" | "preparing" | "running" | "verifying" | "awaiting-approval" | "publishing" | "finished";
  requester?: string | { id?: string; label?: string; name?: string };
  requesterId?: string;
  projectId: string;
  mode: string;
  domain?: string;
  goal: string;
  acceptance?: Array<string | AcceptanceEvidence>;
  progress?: number | string | DelegationProgress;
  baseRevision?: string | null;
  finalRevision?: string | null;
  changedFiles?: Array<string | ChangedFile>;
  checks?: Array<string | DelegationCheck>;
  risks?: Array<string | DelegationRisk>;
  artifactHash?: string | null;
  reportHash?: string | null;
  patchSha256?: string | null;
  reportSha256?: string | null;
  hashes?: {
    artifact?: string | null;
    report?: string | null;
  };
  agentSummary?: string | null;
  summary?: string | null;
  createdAt?: string | number;
  updatedAt?: string | number;
}

interface DelegationOverview {
  enabled: boolean;
  publicPath: string;
  runnerReady: boolean;
  projects: DelegationProject[];
  principals: DelegationPrincipal[];
  jobs: DelegationJob[];
}

interface TokenRequest {
  label: string;
  projectIds: string[];
  modes: string[];
  expiresInDays: number;
}

const activeStatuses = new Set<DelegationJobStatus>([
  "queued",
  "preparing",
  "running",
  "verifying",
  "approval-required",
]);

const statusLabels: Record<DelegationJobStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "执行中",
  verifying: "验收中",
  "approval-required": "待发布审批",
  completed: "已完成",
  denied: "已拒绝",
  failed: "失败",
  cancelled: "已取消",
};

const tokenModes = [
  { id: "inspect", label: "检查" },
  { id: "change", label: "修改" },
  { id: "publish", label: "发布" },
];

export default function DelegationConsole() {
  const [overview, setOverview] = useState<DelegationOverview | null>(null);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyJob, setBusyJob] = useState<{ id: string; action: JobAction } | null>(null);
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenProjectIds, setTokenProjectIds] = useState<string[]>([]);
  const [tokenModeIds, setTokenModeIds] = useState<string[]>(["inspect"]);
  const [tokenExpiryDays, setTokenExpiryDays] = useState("30");
  const [creatingToken, setCreatingToken] = useState(false);
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [tokenWasHidden, setTokenWasHidden] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Argus · MarkSec 委托";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const loadOverview = useCallback(async (manual = false) => {
    if (activeRequest.current) {
      if (!manual) return;
      activeRequest.current.abort();
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    if (manual) setRefreshing(true);

    try {
      const response = await fetch("/api/delegation/overview", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readError(response));

      const payload = parseOverview(await response.json());
      setOverview(payload);
      setLoadError(null);
      setSelectedJobId((current) => payload.jobs.some((job) => job.id === current) ? current : payload.jobs[0]?.id ?? "");
    } catch (cause) {
      if (isAbortError(cause)) return;
      setLoadError(errorMessage(cause));
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (manual) setRefreshing(false);
    }
  }, []);

  const hasActiveJobs = overview?.jobs.some((job) => activeStatuses.has(effectiveStatus(job))) ?? false;
  const pollInterval = hasActiveJobs ? 2_000 : 30_000;

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), pollInterval);
    return () => {
      window.clearInterval(timer);
      const request = activeRequest.current;
      activeRequest.current = null;
      request?.abort();
    };
  }, [loadOverview, pollInterval]);

  const jobs = overview?.jobs ?? [];
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedProject = selectedJob
    ? overview?.projects.find((project) => project.id === selectedJob.projectId)
    : undefined;

  async function runJobAction(jobId: string, action: JobAction) {
    setBusyJob({ id: jobId, action });
    setActionError(null);
    try {
      const response = await fetch(`/api/delegation/jobs/${encodeURIComponent(jobId)}/${action}`, {
        method: "POST",
        headers: { "x-argus-owner": "1" },
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadOverview(true);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusyJob(null);
    }
  }

  function openTokenPanel() {
    if (tokenProjectIds.length === 0) {
      const firstProject = overview?.projects.find((project) => project.enabled !== false);
      if (firstProject) setTokenProjectIds([firstProject.id]);
    }
    setTokenError(null);
    setTokenPanelOpen(true);
  }

  function closeTokenPanel() {
    if (revealedToken) {
      setRevealedToken(null);
      setTokenWasHidden(true);
    }
    setTokenPanelOpen(false);
  }

  async function createToken(event: FormEvent) {
    event.preventDefault();
    const expiresInDays = Number(tokenExpiryDays);
    const body: TokenRequest = {
      label: tokenLabel.trim(),
      projectIds: tokenProjectIds,
      modes: tokenModeIds,
      expiresInDays,
    };

    if (!body.label) {
      setTokenError("请输入令牌名称");
      return;
    }
    if (body.projectIds.length === 0) {
      setTokenError("至少选择一个项目");
      return;
    }
    if (body.modes.length === 0) {
      setTokenError("至少选择一种权限");
      return;
    }
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      setTokenError("有效期应为 1–365 天");
      return;
    }

    setCreatingToken(true);
    setTokenError(null);
    try {
      const response = await fetch("/api/delegation/tokens", {
        method: "POST",
        headers: { "content-type": "application/json", "x-argus-owner": "1" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response));

      const token = await readPlaintextToken(response);
      setRevealedToken(token);
      setTokenWasHidden(false);
      setTokenLabel("");
      await loadOverview(true);
    } catch (cause) {
      setTokenError(errorMessage(cause));
    } finally {
      setCreatingToken(false);
    }
  }

  async function revokeToken(tokenId: string) {
    setRevokingTokenId(tokenId);
    setTokenError(null);
    try {
      const response = await fetch(`/api/delegation/tokens/${encodeURIComponent(tokenId)}/revoke`, {
        method: "POST",
        headers: { "x-argus-owner": "1" },
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadOverview(true);
    } catch (cause) {
      setTokenError(errorMessage(cause));
    } finally {
      setRevokingTokenId(null);
    }
  }

  async function copyText(value: string, key: string) {
    try {
      await writeClipboard(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => current === key ? null : current), 1_500);
    } catch (cause) {
      const message = `复制失败：${errorMessage(cause)}`;
      if (key.startsWith("token")) setTokenError(message);
      else setActionError(message);
    }
  }

  const initialLoading = overview === null && loadError === null;
  const publicPath = overview?.publicPath ?? "";
  const submissionEndpoint = publicPath ? `${publicPath}/jobs` : "";

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-slate-950">
      <header className="border-b border-slate-200 bg-white px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className={`h-2.5 w-2.5 rounded-full ${overview?.enabled ? "bg-[#007aff]" : "bg-slate-300"}`} />
              <h1 className="text-xl font-semibold tracking-tight">MarkSec 委托</h1>
              {overview && (
                <span className="text-sm text-slate-500">
                  {overview.enabled ? (overview.runnerReady ? "Runner 就绪" : "Runner 未就绪") : "已停用"}
                </span>
              )}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-slate-500">
              <span className="shrink-0">POST</span>
              <code className="truncate font-mono text-slate-700" title={submissionEndpoint || undefined}>
                {submissionEndpoint || (initialLoading ? "正在读取入口" : "未配置公开入口")}
              </code>
              {submissionEndpoint && (
                <button
                  type="button"
                  onClick={() => void copyText(submissionEndpoint, "endpoint")}
                  className="shrink-0 font-medium text-[#007aff] hover:text-[#0066d6] focus:outline-none focus:ring-2 focus:ring-[#007aff]/20"
                >
                  {copiedKey === "endpoint" ? "已复制" : "复制"}
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openTokenPanel}
              disabled={!overview}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-500 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-[#007aff]/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              访问令牌
            </button>
            <button
              type="button"
              onClick={() => void loadOverview(true)}
              disabled={refreshing}
              className="rounded-lg bg-[#007aff] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#006ee6] focus:outline-none focus:ring-2 focus:ring-[#007aff]/25 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-50"
            >
              {refreshing ? "刷新中" : "刷新"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-6 sm:px-8">
        {loadError && <ErrorBanner message={loadError} />}
        {actionError && <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />}
        {overview && !overview.enabled && (
          <div className="mb-5 border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700">
            委托入口已停用。历史任务仍可查看，不能创建新令牌。
          </div>
        )}
        {overview?.enabled && !overview.runnerReady && (
          <div className="mb-5 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Seoul Runner 未就绪。新任务可以进入队列，但不会开始执行。
          </div>
        )}

        <section className="min-h-[620px] overflow-hidden border border-slate-200 bg-white lg:grid lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold">委托任务</h2>
              <span className="text-sm text-slate-500">
                {jobs.length} 条 · {hasActiveJobs ? "2 秒刷新" : "30 秒刷新"}
              </span>
            </div>
            <div className="max-h-[420px] overflow-y-auto lg:max-h-[calc(100vh-190px)]">
              {initialLoading && <EmptyState text="正在读取任务" />}
              {!initialLoading && jobs.length === 0 && <EmptyState text="还没有委托任务" />}
              {jobs.map((job) => (
                <JobListItem
                  key={job.id}
                  job={job}
                  selected={job.id === selectedJobId}
                  onSelect={() => {
                    setSelectedJobId(job.id);
                    setActionError(null);
                  }}
                />
              ))}
            </div>
          </aside>

          <div className="min-w-0">
            {selectedJob ? (
              <JobDetail
                job={selectedJob}
                project={selectedProject}
                principals={overview?.principals ?? []}
                busyJob={busyJob}
                copiedKey={copiedKey}
                onAction={(action) => void runJobAction(selectedJob.id, action)}
                onCopy={(value, key) => void copyText(value, key)}
              />
            ) : (
              <div className="flex min-h-[500px] items-center justify-center px-6 text-sm text-slate-500">
                {loadError ? "任务读取失败" : "选择任务查看验收证据"}
              </div>
            )}
          </div>
        </section>
      </main>

      {tokenPanelOpen && overview && (
        <TokenPanel
          enabled={overview.enabled}
          publicPath={overview.publicPath}
          projects={overview.projects}
          principals={overview.principals}
          label={tokenLabel}
          projectIds={tokenProjectIds}
          modes={tokenModeIds}
          expiryDays={tokenExpiryDays}
          creating={creatingToken}
          revokingId={revokingTokenId}
          error={tokenError}
          revealedToken={revealedToken}
          tokenWasHidden={tokenWasHidden}
          copiedKey={copiedKey}
          onClose={closeTokenPanel}
          onSubmit={(event) => void createToken(event)}
          onLabelChange={setTokenLabel}
          onProjectIdsChange={setTokenProjectIds}
          onModesChange={setTokenModeIds}
          onExpiryDaysChange={setTokenExpiryDays}
          onRevoke={(id) => void revokeToken(id)}
          onCopy={(value, key) => void copyText(value, key)}
          onHideToken={() => {
            setRevealedToken(null);
            setTokenWasHidden(true);
          }}
        />
      )}
    </div>
  );
}

function JobListItem({ job, selected, onSelect }: { job: DelegationJob; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`block w-full border-b border-slate-100 px-5 py-4 text-left transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#007aff]/25 ${selected ? "border-l-2 border-l-[#007aff] bg-blue-50/60 pl-[18px]" : "hover:bg-slate-50"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-slate-600">
          {modeLabel(job.mode)} · {job.projectId}
        </span>
        <StatusBadge status={effectiveStatus(job)} />
      </div>
      <p className="mt-3 line-clamp-2 text-sm font-semibold leading-5 text-slate-950">
        {boundedText(job.goal, 180, "未提供任务目标")}
      </p>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
        <span className="truncate">{requesterText(job.requester, job.requesterId)}</span>
        <span className="shrink-0">{formatRelativeTime(job.updatedAt ?? job.createdAt)}</span>
      </div>
    </button>
  );
}

function JobDetail({
  job,
  project,
  principals,
  busyJob,
  copiedKey,
  onAction,
  onCopy,
}: {
  job: DelegationJob;
  project?: DelegationProject;
  principals: DelegationPrincipal[];
  busyJob: { id: string; action: JobAction } | null;
  copiedKey: string | null;
  onAction: (action: JobAction) => void;
  onCopy: (value: string, key: string) => void;
}) {
  const displayStatus = effectiveStatus(job);
  const canCancel = activeStatuses.has(displayStatus);
  const canDecidePublish = job.status === "approval-required" && job.mode === "publish";
  const progress = progressPercent(job.progress);
  const artifactHash = job.artifactHash ?? job.patchSha256 ?? job.hashes?.artifact ?? null;
  const reportHash = job.reportHash ?? job.reportSha256 ?? job.hashes?.report ?? null;
  const requester = requesterLabel(job, principals);
  const busy = busyJob?.id === job.id ? busyJob.action : null;

  return (
    <article>
      <div className="px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 max-w-4xl">
            <div className="flex items-center gap-3">
              <StatusBadge status={displayStatus} />
              <span className="font-mono text-xs text-slate-400">{shortId(job.id)}</span>
            </div>
            <h2 className="mt-4 text-2xl font-semibold leading-8 tracking-tight text-slate-950">
              {boundedText(job.goal, 4_000, "未提供任务目标")}
            </h2>
          </div>

          {(canCancel || canDecidePublish) && (
            <div className="flex flex-wrap items-center gap-2">
              {canCancel && (
                <button
                  type="button"
                  onClick={() => onAction("cancel")}
                  disabled={Boolean(busy)}
                  className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:border-red-300 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/20 disabled:cursor-wait disabled:opacity-50"
                >
                  {busy === "cancel" ? "取消中" : "取消任务"}
                </button>
              )}
              {canDecidePublish && (
                <>
                  <button
                    type="button"
                    onClick={() => onAction("deny")}
                    disabled={Boolean(busy)}
                    className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:border-red-300 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/20 disabled:cursor-wait disabled:opacity-50"
                  >
                    {busy === "deny" ? "拒绝中" : "拒绝发布"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAction("approve")}
                    disabled={Boolean(busy)}
                    className="rounded-lg bg-[#007aff] px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-[#006ee6] focus:outline-none focus:ring-2 focus:ring-[#007aff]/25 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-50"
                  >
                    {busy === "approve" ? "批准中" : "批准发布"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <dl className="mt-6 grid gap-x-8 gap-y-4 border-t border-slate-200 pt-5 sm:grid-cols-2 xl:grid-cols-4">
          <DetailTerm label="请求者" value={requester} />
          <DetailTerm label="项目" value={projectName(project, job.projectId)} />
          <DetailTerm label="模式" value={modeLabel(job.mode)} mono />
          <DetailTerm label="域名" value={job.domain || project?.domain || "未指定"} mono />
        </dl>
      </div>

      <EvidenceSection title="进度">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-slate-800">{progressText(job.progress, displayStatus)}</p>
          {progress !== null && <span className="text-sm tabular-nums text-slate-500">{Math.round(progress)}%</span>}
        </div>
        {progress !== null && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-[#007aff] transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
      </EvidenceSection>

      <EvidenceSection title="验收证据">
        <AcceptanceList items={job.acceptance ?? []} />
      </EvidenceSection>

      <EvidenceSection title="修订与文件">
        <dl className="grid gap-5 sm:grid-cols-2">
          <DetailTerm label="Base revision" value={job.baseRevision || "尚未记录"} mono />
          <DetailTerm label="Final revision" value={job.finalRevision || "尚未生成"} mono />
        </dl>
        <ChangedFiles files={job.changedFiles ?? []} />
      </EvidenceSection>

      <EvidenceSection title="检查">
        <ChecksList checks={job.checks ?? []} />
      </EvidenceSection>

      <EvidenceSection title="风险">
        <RisksList risks={job.risks ?? []} />
      </EvidenceSection>

      <EvidenceSection title="产物与报告">
        <div className="grid gap-5 sm:grid-cols-2">
          <HashValue
            label="Artifact hash"
            value={artifactHash}
            copied={copiedKey === `artifact-${job.id}`}
            onCopy={() => artifactHash && onCopy(artifactHash, `artifact-${job.id}`)}
          />
          <HashValue
            label="Report hash"
            value={reportHash}
            copied={copiedKey === `report-${job.id}`}
            onCopy={() => reportHash && onCopy(reportHash, `report-${job.id}`)}
          />
        </div>
      </EvidenceSection>

      <EvidenceSection title="Agent 摘要">
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
          {boundedText(job.agentSummary ?? job.summary, 4_000, "尚未生成验收摘要")}
        </p>
      </EvidenceSection>
    </article>
  );
}

function AcceptanceList({ items }: { items: Array<string | AcceptanceEvidence> }) {
  if (items.length === 0) return <InlineEmpty text="未提供验收项" />;
  return (
    <div className="divide-y divide-slate-100 border-y border-slate-100">
      {items.map((item, index) => {
        const structured = typeof item === "string" ? null : item;
        const title = typeof item === "string"
          ? item
          : item.criterion || item.label || item.name || `验收项 ${index + 1}`;
        const evidence = structured?.evidence || structured?.detail;
        return (
          <div key={`${title}-${index}`} className="flex items-start justify-between gap-5 py-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">{boundedText(title, 1_000)}</p>
              {evidence && <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{boundedText(evidence, 1_500)}</p>}
            </div>
            {structured?.status && <EvidenceStatus status={structured.status} />}
          </div>
        );
      })}
    </div>
  );
}

function ChangedFiles({ files }: { files: Array<string | ChangedFile> }) {
  if (files.length === 0) return <div className="mt-5"><InlineEmpty text="没有记录文件变更" /></div>;
  return (
    <div className="mt-5 divide-y divide-slate-100 border-y border-slate-100">
      {files.map((file, index) => {
        const path = typeof file === "string" ? file : file.path;
        return (
          <div key={`${path}-${index}`} className="flex items-center justify-between gap-4 py-3 text-sm">
            <code className="min-w-0 break-all font-mono text-slate-800">{path}</code>
            {typeof file !== "string" && (
              <span className="shrink-0 text-xs tabular-nums text-slate-500">
                {file.status || "modified"}
                {typeof file.additions === "number" ? ` +${file.additions}` : ""}
                {typeof file.deletions === "number" ? ` −${file.deletions}` : ""}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChecksList({ checks }: { checks: Array<string | DelegationCheck> }) {
  if (checks.length === 0) return <InlineEmpty text="尚无检查结果" />;
  return (
    <div className="divide-y divide-slate-100 border-y border-slate-100">
      {checks.map((check, index) => {
        if (typeof check === "string") {
          return <p key={`${check}-${index}`} className="py-3.5 text-sm text-slate-800">{boundedText(check, 1_000)}</p>;
        }
        return (
          <div key={`${check.name ?? "check"}-${index}`} className="py-3.5">
            <div className="flex items-start justify-between gap-5">
              <p className="text-sm font-medium text-slate-900">{check.name || `检查 ${index + 1}`}</p>
              {check.status && <EvidenceStatus status={check.status} />}
            </div>
            {(check.summary || check.detail) && (
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                {boundedText(check.summary || check.detail, 1_500)}
              </p>
            )}
            {(check.command || typeof check.exitCode === "number" || typeof check.durationMs === "number") && (
              <p className="mt-2 break-all font-mono text-xs text-slate-500">
                {[check.command, typeof check.exitCode === "number" ? `exit ${check.exitCode}` : null, typeof check.durationMs === "number" ? formatDuration(check.durationMs) : null].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RisksList({ risks }: { risks: Array<string | DelegationRisk> }) {
  if (risks.length === 0) return <InlineEmpty text="未报告风险" />;
  return (
    <div className="divide-y divide-slate-100 border-y border-slate-100">
      {risks.map((risk, index) => {
        if (typeof risk === "string") {
          return <p key={`${risk}-${index}`} className="py-3.5 text-sm leading-6 text-slate-700">{boundedText(risk, 1_500)}</p>;
        }
        return (
          <div key={`${risk.summary ?? "risk"}-${index}`} className="py-3.5">
            <div className="flex items-start gap-3">
              {risk.level && <EvidenceStatus status={risk.level} />}
              <p className="text-sm leading-6 text-slate-800">{boundedText(risk.summary, 1_500, `风险 ${index + 1}`)}</p>
            </div>
            {risk.mitigation && <p className="mt-1 text-sm leading-6 text-slate-600">处理：{boundedText(risk.mitigation, 1_500)}</p>}
          </div>
        );
      })}
    </div>
  );
}

function TokenPanel({
  enabled,
  publicPath,
  projects,
  principals,
  label,
  projectIds,
  modes,
  expiryDays,
  creating,
  revokingId,
  error,
  revealedToken,
  tokenWasHidden,
  copiedKey,
  onClose,
  onSubmit,
  onLabelChange,
  onProjectIdsChange,
  onModesChange,
  onExpiryDaysChange,
  onRevoke,
  onCopy,
  onHideToken,
}: {
  enabled: boolean;
  publicPath: string;
  projects: DelegationProject[];
  principals: DelegationPrincipal[];
  label: string;
  projectIds: string[];
  modes: string[];
  expiryDays: string;
  creating: boolean;
  revokingId: string | null;
  error: string | null;
  revealedToken: string | null;
  tokenWasHidden: boolean;
  copiedKey: string | null;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  onLabelChange: (value: string) => void;
  onProjectIdsChange: (values: string[]) => void;
  onModesChange: (values: string[]) => void;
  onExpiryDaysChange: (value: string) => void;
  onRevoke: (id: string) => void;
  onCopy: (value: string, key: string) => void;
  onHideToken: () => void;
}) {
  const submissionEndpoint = publicPath ? `${publicPath}/jobs` : "";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/20" role="presentation" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-panel-title"
        className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-200 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-7">
          <h2 id="token-panel-title" className="text-lg font-semibold tracking-tight">访问令牌</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:border-slate-500 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-[#007aff]/20"
          >
            关闭
          </button>
        </div>

        <div className="px-5 py-6 sm:px-7">
          <div className="border-b border-slate-200 pb-6">
            <p className="text-sm font-medium text-slate-900">委托入口</p>
            <div className="mt-2 flex items-start gap-3 border border-slate-200 bg-slate-50 px-3 py-2.5">
              <code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-slate-700">{submissionEndpoint || "未配置"}</code>
              {submissionEndpoint && (
                <button type="button" onClick={() => onCopy(submissionEndpoint, "token-endpoint")} className="shrink-0 text-xs font-semibold text-[#007aff] hover:text-[#0066d6]">
                  {copiedKey === "token-endpoint" ? "已复制" : "复制"}
                </button>
              )}
            </div>
          </div>

          {error && <div role="alert" className="mt-5 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          {revealedToken && (
            <section className="mt-6 border border-blue-200 bg-blue-50 px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-950">新令牌</h3>
                  <p className="mt-1 text-sm text-slate-600">仅显示这一次，关闭或隐藏后无法再次查看。</p>
                </div>
                <button type="button" onClick={onHideToken} className="shrink-0 text-sm font-medium text-slate-600 hover:text-slate-950">隐藏</button>
              </div>
              <code className="mt-4 block select-all break-all border border-blue-200 bg-white px-3 py-3 font-mono text-sm leading-6 text-slate-950">
                {revealedToken}
              </code>
              <button
                type="button"
                onClick={() => onCopy(revealedToken, "token")}
                className="mt-3 rounded-lg bg-[#007aff] px-4 py-2 text-sm font-semibold text-white hover:bg-[#006ee6] focus:outline-none focus:ring-2 focus:ring-[#007aff]/25 focus:ring-offset-2"
              >
                {copiedKey === "token" ? "已复制" : "复制令牌"}
              </button>
            </section>
          )}

          {!revealedToken && tokenWasHidden && (
            <div className="mt-6 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              令牌已隐藏，无法再次查看。需要新值时请撤销旧令牌并重新创建。
            </div>
          )}

          <form className="mt-7 border-b border-slate-200 pb-7" onSubmit={onSubmit}>
            <h3 className="text-base font-semibold">创建令牌</h3>
            <fieldset disabled={!enabled || creating} className="mt-5 space-y-5 disabled:opacity-50">
              <Field label="名称">
                <input
                  value={label}
                  onChange={(event) => onLabelChange(event.target.value)}
                  className="input"
                  maxLength={80}
                  placeholder="例如 review-agent"
                  autoComplete="off"
                />
              </Field>

              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">项目</p>
                <div className="divide-y divide-slate-100 border-y border-slate-200">
                  {projects.map((project) => (
                    <label key={project.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                      <span>
                        <span className="font-medium text-slate-900">{projectName(project, project.id)}</span>
                        {project.domain && <span className="ml-2 font-mono text-xs text-slate-500">{project.domain}</span>}
                      </span>
                      <input
                        type="checkbox"
                        checked={projectIds.includes(project.id)}
                        disabled={project.enabled === false}
                        onChange={() => onProjectIdsChange(toggleValue(projectIds, project.id))}
                        className="h-4 w-4 accent-[#007aff]"
                      />
                    </label>
                  ))}
                  {projects.length === 0 && <InlineEmpty text="没有可授权项目" />}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">权限</p>
                <div className="flex flex-wrap gap-2">
                  {tokenModes.map((mode) => (
                    <label key={mode.id} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm font-medium transition ${modes.includes(mode.id) ? "border-[#007aff] bg-blue-50 text-[#007aff]" : "border-slate-300 text-slate-600 hover:border-slate-500"}`}>
                      <input
                        type="checkbox"
                        checked={modes.includes(mode.id)}
                        onChange={() => onModesChange(toggleValue(modes, mode.id))}
                        className="sr-only"
                      />
                      {mode.label}
                    </label>
                  ))}
                </div>
              </div>

              <Field label="有效期（天）">
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={expiryDays}
                  onChange={(event) => onExpiryDaysChange(event.target.value)}
                  className="input"
                />
              </Field>

              <button
                type="submit"
                disabled={!enabled || creating || projects.length === 0}
                className="rounded-lg bg-[#007aff] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#006ee6] focus:outline-none focus:ring-2 focus:ring-[#007aff]/25 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating ? "创建中" : enabled ? "创建令牌" : "委托入口已停用"}
              </button>
            </fieldset>
          </form>

          <section className="pt-7">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">现有令牌</h3>
              <span className="text-sm text-slate-500">{principals.length} 个</span>
            </div>
            <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
              {principals.map((principal) => {
                const inactive = principalInactive(principal);
                return (
                  <div key={principal.id} className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-950">{principal.label}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {principal.projectIds.map((id) => projectName(projects.find((project) => project.id === id), id)).join(" · ") || "无项目"}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {principal.modes.map(modeLabel).join(" · ") || "无权限"} · {principalExpiryText(principal)}
                        </p>
                      </div>
                      {inactive ? (
                        <span className="shrink-0 text-xs font-medium text-slate-400">{inactive}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onRevoke(principal.id)}
                          disabled={revokingId === principal.id}
                          className="shrink-0 text-sm font-medium text-slate-500 hover:text-red-700 disabled:cursor-wait disabled:opacity-50"
                        >
                          {revokingId === principal.id ? "撤销中" : "撤销"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {principals.length === 0 && <InlineEmpty text="还没有访问令牌" />}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function EvidenceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-slate-200 px-5 py-5 sm:px-7 sm:py-6">
      <h3 className="mb-4 text-sm font-semibold text-slate-950">{title}</h3>
      {children}
    </section>
  );
}

function DetailTerm({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`mt-1 break-words text-sm leading-6 text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">{label}</span>{children}</label>;
}

function StatusBadge({ status }: { status: DelegationJobStatus }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(status)}`}>{statusLabels[status]}</span>;
}

function EvidenceStatus({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const positive = ["passed", "pass", "success", "completed", "verified", "low"].includes(normalized);
  const negative = ["failed", "fail", "error", "blocked", "high", "critical"].includes(normalized);
  const className = positive
    ? "bg-emerald-50 text-emerald-700"
    : negative
      ? "bg-red-50 text-red-700"
      : "bg-slate-100 text-slate-600";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>{evidenceStatusLabel(status)}</span>;
}

function HashValue({ label, value, copied, onCopy }: { label: string; value: string | null; copied: boolean; onCopy: () => void }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      {value ? (
        <div className="mt-1 flex items-start gap-3">
          <code className="min-w-0 flex-1 break-all font-mono text-sm leading-6 text-slate-900">{value}</code>
          <button type="button" onClick={onCopy} className="shrink-0 text-xs font-semibold text-[#007aff] hover:text-[#0066d6]">
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-sm text-slate-500">尚未生成</p>
      )}
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div role="alert" className="mb-5 flex items-start justify-between gap-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span>{message}</span>
      {onDismiss && <button type="button" onClick={onDismiss} className="shrink-0 font-medium hover:text-red-900">关闭</button>}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="px-5 py-20 text-center text-sm text-slate-500">{text}</p>;
}

function InlineEmpty({ text }: { text: string }) {
  return <p className="py-4 text-sm text-slate-500">{text}</p>;
}

function parseOverview(value: unknown): DelegationOverview {
  if (!isRecord(value)
    || typeof value.enabled !== "boolean"
    || typeof value.publicPath !== "string"
    || typeof value.runnerReady !== "boolean"
    || !Array.isArray(value.projects)
    || !Array.isArray(value.principals)
    || !Array.isArray(value.jobs)) {
    throw new Error("委托概览格式无效");
  }
  return {
    enabled: value.enabled,
    publicPath: value.publicPath,
    runnerReady: value.runnerReady,
    projects: value.projects.map(normalizeProject),
    principals: value.principals.map(normalizePrincipal),
    jobs: value.jobs.map(normalizeJob),
  };
}

function normalizeProject(value: unknown, index: number): DelegationProject {
  if (!isRecord(value)) throw new Error(`项目 ${index + 1} 格式无效`);
  const id = requiredString(value.id, `项目 ${index + 1} 缺少 id`);
  const allowedDomains = stringArray(value.allowedDomains);
  const allowedModes = stringArray(value.allowedModes);
  const modes = stringArray(value.modes);
  return {
    id,
    displayName: optionalString(value.displayName),
    name: optionalString(value.name),
    domain: optionalString(value.domain) || allowedDomains[0],
    modes: modes.length > 0 ? modes : allowedModes,
    allowedDomains,
    allowedModes,
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

function normalizePrincipal(value: unknown, index: number): DelegationPrincipal {
  if (!isRecord(value)) throw new Error(`令牌 ${index + 1} 格式无效`);
  return {
    id: requiredString(value.id, `令牌 ${index + 1} 缺少 id`),
    label: requiredString(value.label, `令牌 ${index + 1} 缺少名称`),
    projectIds: stringArray(value.projectIds),
    modes: stringArray(value.modes),
    createdAt: dateValue(value.createdAt),
    expiresAt: dateValue(value.expiresAt),
    revokedAt: dateValue(value.revokedAt),
    status: optionalString(value.status),
  };
}

function normalizeJob(value: unknown, index: number): DelegationJob {
  if (!isRecord(value)) throw new Error(`任务 ${index + 1} 格式无效`);
  const request = recordValue(value.request);
  const report = recordValue(value.report);
  const result = recordValue(value.result) ?? recordValue(value.runResult);
  const hashes = recordValue(value.hashes);
  const statusValue = firstString(value.status);
  if (!isDelegationStatus(statusValue)) throw new Error(`任务 ${index + 1} 状态无效`);

  const requester = normalizeRequester(value.requester);
  const phase = firstString(value.phase);
  return {
    id: requiredString(firstString(value.id, value.jobId), `任务 ${index + 1} 缺少 id`),
    status: statusValue,
    ...(isDelegationPhase(phase) ? { phase } : {}),
    requester,
    requesterId: firstString(value.requesterId, value.principalId),
    projectId: requiredString(firstString(value.projectId, request?.projectId), `任务 ${index + 1} 缺少 projectId`),
    mode: requiredString(firstString(value.mode, request?.mode), `任务 ${index + 1} 缺少 mode`),
    domain: firstString(value.domain, request?.domain),
    goal: requiredString(firstString(value.goal, request?.goal), `任务 ${index + 1} 缺少目标`),
    acceptance: normalizeAcceptance(firstArray(report?.acceptance, value.acceptance, request?.acceptance)),
    progress: normalizeProgress(value.progress),
    baseRevision: firstString(value.baseRevision, result?.baseRevision, report?.baseRevision, request?.baseRevision),
    finalRevision: firstString(value.finalRevision, result?.finalRevision, report?.finalRevision),
    changedFiles: normalizeChangedFiles(firstArray(value.changedFiles, result?.changedFiles, report?.changedFiles)),
    checks: normalizeChecks(firstArray(value.checks, result?.checks, report?.checks, report?.verification)),
    risks: normalizeRisks(firstArray(value.risks, result?.risks, report?.risks, report?.warnings)),
    artifactHash: firstString(value.artifactHash, result?.artifactHash, report?.artifactHash),
    reportHash: firstString(value.reportHash, result?.reportHash, report?.reportHash),
    patchSha256: firstString(value.patchSha256, result?.patchSha256, report?.patchSha256),
    reportSha256: firstString(value.reportSha256, result?.reportSha256, report?.reportSha256),
    hashes: hashes ? {
      artifact: firstString(hashes.artifact),
      report: firstString(hashes.report),
    } : undefined,
    agentSummary: firstString(value.agentSummary),
    summary: firstString(value.summary, result?.summary, report?.summary),
    createdAt: dateValue(value.createdAt),
    updatedAt: dateValue(value.updatedAt),
  };
}

function normalizeRequester(value: unknown): DelegationJob["requester"] {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return {
    id: optionalString(value.id),
    label: optionalString(value.label),
    name: optionalString(value.name),
  };
}

function normalizeProgress(value: unknown): DelegationJob["progress"] {
  if (typeof value === "string" || typeof value === "number") return value;
  if (!isRecord(value)) return undefined;
  return {
    phase: optionalString(value.phase),
    step: optionalString(value.step),
    label: optionalString(value.label),
    message: optionalString(value.message),
    percent: optionalNumber(value.percent),
    current: optionalNumber(value.current),
    total: optionalNumber(value.total),
    completedUnits: optionalNumber(value.completedUnits),
    totalUnits: optionalNumber(value.totalUnits),
  };
}

function normalizeAcceptance(value: unknown[]): Array<string | AcceptanceEvidence> {
  return value.flatMap((item): Array<string | AcceptanceEvidence> => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    return [{
      criterion: firstString(item.criterion, item.label, item.name),
      status: optionalString(item.status),
      evidence: optionalString(item.evidence),
      detail: optionalString(item.detail),
    }];
  });
}

function normalizeChangedFiles(value: unknown[]): Array<string | ChangedFile> {
  return value.flatMap((item): Array<string | ChangedFile> => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    const path = firstString(item.path, item.file);
    if (!path) return [];
    return [{
      path,
      status: optionalString(item.status),
      additions: optionalNumber(item.additions),
      deletions: optionalNumber(item.deletions),
    }];
  });
}

function normalizeChecks(value: unknown[]): Array<string | DelegationCheck> {
  return value.flatMap((item): Array<string | DelegationCheck> => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    return [{
      name: firstString(item.name, item.label, item.id),
      status: optionalString(item.status),
      summary: firstString(item.summary, item.evidence),
      detail: optionalString(item.detail),
      command: optionalString(item.command),
      exitCode: optionalNumber(item.exitCode),
      durationMs: optionalNumber(item.durationMs),
    }];
  });
}

function normalizeRisks(value: unknown[]): Array<string | DelegationRisk> {
  return value.flatMap((item): Array<string | DelegationRisk> => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    return [{
      summary: firstString(item.summary, item.message),
      level: optionalString(item.level),
      mitigation: optionalString(item.mitigation),
    }];
  });
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function requiredString(value: unknown, message: string): string {
  const candidate = optionalString(value);
  if (!candidate) throw new Error(message);
  return candidate;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dateValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isDelegationStatus(value: unknown): value is DelegationJobStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(statusLabels, value);
}

function isDelegationPhase(value: unknown): value is NonNullable<DelegationJob["phase"]> {
  return typeof value === "string" && [
    "accepted",
    "preparing",
    "running",
    "verifying",
    "awaiting-approval",
    "publishing",
    "finished",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusClass(status: DelegationJobStatus) {
  if (status === "completed") return "bg-emerald-50 text-emerald-700";
  if (["denied", "failed"].includes(status)) return "bg-red-50 text-red-700";
  if (status === "approval-required") return "bg-amber-50 text-amber-700";
  if (["preparing", "running", "verifying"].includes(status)) return "bg-blue-50 text-[#007aff]";
  return "bg-slate-100 text-slate-600";
}

function effectiveStatus(job: DelegationJob): DelegationJobStatus {
  if (job.status === "running" && job.phase === "preparing") return "preparing";
  if (job.status === "running" && job.phase === "verifying") return "verifying";
  return job.status;
}

function modeLabel(mode: string) {
  const labels: Record<string, string> = {
    inspect: "检查",
    change: "修改",
    publish: "发布",
  };
  return labels[mode] ?? mode;
}

function evidenceStatusLabel(status: string) {
  const labels: Record<string, string> = {
    passed: "通过",
    pass: "通过",
    success: "通过",
    completed: "完成",
    verified: "已验证",
    failed: "失败",
    fail: "失败",
    error: "错误",
    blocked: "阻塞",
    pending: "待验证",
    running: "进行中",
    skipped: "已跳过",
    low: "低",
    medium: "中",
    high: "高",
    critical: "严重",
  };
  return labels[status.toLowerCase()] ?? status;
}

function requesterText(requester: DelegationJob["requester"], requesterId?: string) {
  if (typeof requester === "string") return requester;
  if (requester) return requester.label || requester.name || requester.id || requesterId || "未知请求者";
  return requesterId || "未知请求者";
}

function requesterLabel(job: DelegationJob, principals: DelegationPrincipal[]) {
  const raw = requesterText(job.requester, job.requesterId);
  const requesterId = typeof job.requester === "object" ? job.requester?.id : job.requesterId || job.requester;
  return principals.find((principal) => principal.id === requesterId)?.label || raw;
}

function projectName(project: DelegationProject | undefined, fallback: string) {
  return project?.displayName || project?.name || project?.id || fallback;
}

function progressPercent(progress: DelegationJob["progress"]): number | null {
  if (typeof progress === "number") return clampPercent(progress);
  if (!progress || typeof progress === "string") return null;
  if (typeof progress.percent === "number") return clampPercent(progress.percent);
  if (typeof progress.current === "number" && typeof progress.total === "number" && progress.total > 0) {
    return clampPercent((progress.current / progress.total) * 100);
  }
  if (typeof progress.completedUnits === "number" && typeof progress.totalUnits === "number" && progress.totalUnits > 0) {
    return clampPercent((progress.completedUnits / progress.totalUnits) * 100);
  }
  return null;
}

function progressText(progress: DelegationJob["progress"], status: DelegationJobStatus) {
  if (typeof progress === "string") return boundedText(progress, 1_000);
  if (progress && typeof progress !== "number") {
    return boundedText(progress.message || progress.label || progress.step || progress.phase, 1_000, statusLabels[status]);
  }
  return statusLabels[status];
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function boundedText(value: string | null | undefined, limit: number, fallback = "—") {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n…已截断`;
}

function formatRelativeTime(value?: string | number) {
  const date = parseDate(value);
  if (!date) return "时间未知";
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDate(value?: string | number | null) {
  const date = parseDate(value);
  if (!date) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function parseDate(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function principalInactive(principal: DelegationPrincipal) {
  if (principal.revokedAt || principal.status?.toLowerCase() === "revoked") return "已撤销";
  const expiresAt = parseDate(principal.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) return "已过期";
  return null;
}

function principalExpiryText(principal: DelegationPrincipal) {
  const inactive = principalInactive(principal);
  if (inactive) return inactive;
  return principal.expiresAt ? `到期 ${formatDate(principal.expiresAt)}` : "长期有效";
}

async function readPlaintextToken(response: Response) {
  const text = (await response.text()).trim();
  if (!text) throw new Error("服务端没有返回令牌");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string" && parsed) return parsed;
    if (isRecord(parsed)) {
      if (typeof parsed.token === "string" && parsed.token) return parsed.token;
      if (typeof parsed.plaintextToken === "string" && parsed.plaintextToken) return parsed.plaintextToken;
      if (typeof parsed.plaintext === "string" && parsed.plaintext) return parsed.plaintext;
    }
  } catch {
    return text;
  }
  throw new Error("令牌响应格式无效");
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
    return boundedText(text, 1_000, `请求失败（${response.status}）`);
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function isAbortError(cause: unknown) {
  return cause instanceof DOMException && cause.name === "AbortError";
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("浏览器拒绝访问剪贴板");
  } finally {
    textarea.remove();
  }
}
