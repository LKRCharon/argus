import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  authenticateBearer,
  authorizeDelegationRequest,
  generatePrincipalToken,
} from "./auth";
import { DelegationConfigStore } from "./config";
import {
  DelegationIdempotencyConflictError,
  DelegationJobJournal,
  delegationRequestDigest,
  type DelegationJobRecord,
} from "./journal";
import {
  DelegationRequestLimiter,
  type DelegationLimitPermit,
} from "./limits";
import {
  DelegationJobRequestSchema,
  DelegationModeSchema,
  DelegationSafeIdSchema,
  isWithin,
  type DelegationConfig,
  type DelegationJobRequest,
  type DelegationPrincipal,
  type DelegationProjectPolicy,
  type DelegationReport,
} from "./schemas";
import {
  DelegationRunner,
  type DelegationRunResult,
  type DelegationRunnerProject,
} from "./runner";

const PUBLIC_PATH_PATTERN = /^\/d\/[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "denied", "cancelled"]);

const CreateTokenSchema = z.object({
  label: z.string().trim().min(1).max(128),
  projectIds: z.array(DelegationSafeIdSchema).min(1).max(64)
    .refine((values) => new Set(values).size === values.length, "projectIds must be unique"),
  modes: z.array(DelegationModeSchema).min(1).max(3)
    .refine((values) => new Set(values).size === values.length, "modes must be unique"),
  expiresInDays: z.number().int().min(1).max(365),
}).strict();

export class DelegationServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DelegationServiceError";
  }
}

export interface DelegationServiceOptions {
  configStore?: DelegationConfigStore;
  journal?: DelegationJobJournal;
  limiter?: DelegationRequestLimiter;
  runner?: DelegationRunner;
  publicPath?: string;
  publicOrigin?: string;
  codexHome?: string;
  globalConcurrency?: number;
  now?: () => number;
}

interface QueuedRun {
  record: DelegationJobRecord;
  project: DelegationProjectPolicy;
  permit: DelegationLimitPermit;
}

interface ActiveRun {
  projectId: string;
  controller: AbortController;
  permit: DelegationLimitPermit;
  cancelledByOwner: boolean;
}

export interface DelegationOverview {
  enabled: boolean;
  publicPath: string;
  runnerReady: boolean;
  publisherReady: false;
  projects: Array<{
    id: string;
    displayName: string;
    allowedDomains: string[];
    allowedModes: string[];
    enabled: boolean;
    runnerReady: boolean;
    runnerReason?: string;
  }>;
  principals: Array<{
    id: string;
    label: string;
    projectIds: string[];
    modes: string[];
    expiresAt?: string;
    revokedAt?: string;
    status: "active" | "expired" | "revoked";
  }>;
  jobs: ReturnType<typeof ownerJobView>[];
}

export class DelegationService {
  readonly publicPath: string;
  readonly journal: DelegationJobJournal;
  private readonly configStore: DelegationConfigStore;
  private readonly limiter: DelegationRequestLimiter;
  private readonly runner: DelegationRunner;
  private readonly globalConcurrency: number;
  private readonly now: () => number;
  private readonly publicOrigin: string;
  private config: DelegationConfig | undefined;
  private readonly queue: QueuedRun[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private drainScheduled = false;
  private started = false;
  private stopped = false;

  constructor(options: DelegationServiceOptions = {}) {
    this.configStore = options.configStore ?? new DelegationConfigStore();
    this.journal = options.journal ?? new DelegationJobJournal();
    this.limiter = options.limiter ?? new DelegationRequestLimiter({ maxRequests: 10, maxActive: 1 });
    this.now = options.now ?? Date.now;
    this.publicPath = parsePublicPath(options.publicPath ?? process.env.ARGUS_DELEGATION_PUBLIC_PATH ?? "");
    this.publicOrigin = parsePublicOrigin(options.publicOrigin ?? process.env.ARGUS_DELEGATION_PUBLIC_ORIGIN ?? "");
    this.runner = options.runner ?? new DelegationRunner({
      codexHome: options.codexHome ?? process.env.ARGUS_DELEGATION_CODEX_HOME ?? "",
    });
    this.globalConcurrency = boundedConcurrency(options.globalConcurrency ?? 2);
    this.config = this.configStore.load();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.recoverJobs();
    this.scheduleDrain();
  }

  stop(): void {
    this.stopped = true;
    for (const run of this.active.values()) run.controller.abort();
    for (const item of this.queue.splice(0)) item.permit.release();
  }

  isEnabled(): boolean {
    return Boolean(this.config && this.publicPath);
  }

  matchesPublicPath(pathname: string): boolean {
    return this.isEnabled() && pathname === this.publicPath;
  }

  authenticate(authorization: string | null | undefined): DelegationPrincipal | undefined {
    if (!this.config || !this.isEnabled()) return undefined;
    return authenticateBearer(authorization, this.config.principals, this.now());
  }

  overview(): DelegationOverview {
    const config = this.config;
    const projects = (config?.projects ?? []).map((project) => {
      const readiness = this.runner.readiness(toRunnerProject(project));
      return {
        id: project.id,
        displayName: project.displayName,
        allowedDomains: [...project.allowedDomains],
        allowedModes: [...project.allowedModes],
        enabled: true,
        runnerReady: readiness.ready,
        ...(readiness.reason ? { runnerReason: safeMessage(readiness.reason) } : {}),
      };
    });
    return {
      enabled: this.isEnabled(),
      publicPath: this.publicOrigin && this.publicPath ? `${this.publicOrigin}${this.publicPath}` : this.publicPath,
      runnerReady: projects.length > 0 && projects.every((project) => project.runnerReady),
      publisherReady: false,
      projects,
      principals: (config?.principals ?? []).map((principal) => ({
        id: principal.id,
        label: principal.label,
        projectIds: [...principal.projectIds],
        modes: [...principal.modes],
        ...(principal.expiresAt ? { expiresAt: principal.expiresAt } : {}),
        ...(principal.revokedAt ? { revokedAt: principal.revokedAt } : {}),
        status: principalStatus(principal, this.now()),
      })),
      jobs: this.journal.list(200).map(ownerJobView),
    };
  }

  submit(
    principal: DelegationPrincipal,
    idempotencyKey: string,
    requestInput: unknown,
  ): { record: DelegationJobRecord; created: boolean } {
    if (this.stopped) throw new DelegationServiceError("委托服务正在停止", 503);
    const config = this.requireConfig();
    const request = DelegationJobRequestSchema.parse(requestInput);
    const project = authorizeDelegationRequest(config, principal, request);
    const existing = this.journal.findByIdempotency(principal.id, idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== delegationRequestDigest(request)) {
        throw new DelegationIdempotencyConflictError();
      }
      return { record: existing, created: false };
    }
    const readiness = this.runner.readiness(toRunnerProject(project));
    if (!readiness.ready) throw new DelegationServiceError("项目执行器尚未就绪", 503);

    const decision = this.limiter.tryStart(principal.id);
    if (!decision.allowed) {
      const retryAfterSeconds = decision.retryAfterMs
        ? Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
        : 5;
      throw new DelegationServiceError("请求过于频繁或已有过多活动任务", 429, retryAfterSeconds);
    }
    try {
      const result = this.journal.begin({ principalId: principal.id, idempotencyKey, request });
      if (!result.created) {
        decision.permit.release();
        return result;
      }
      this.queue.push({ record: result.record, project, permit: decision.permit });
      this.scheduleDrain();
      return result;
    } catch (error) {
      decision.permit.release();
      throw error;
    }
  }

  getForPrincipal(principal: DelegationPrincipal, jobId: string): DelegationJobRecord | undefined {
    const record = this.journal.get(jobId);
    return record?.principalId === principal.id ? record : undefined;
  }

  readPatchForPrincipal(
    principal: DelegationPrincipal,
    jobId: string,
  ): { bytes: Buffer; sha256: string } {
    const record = this.getForPrincipal(principal, jobId);
    if (!record?.report?.patchSha256) throw new DelegationServiceError("未找到补丁产物", 404);
    const project = this.config?.projects.find((candidate) => candidate.id === record.projectId);
    if (!project) throw new DelegationServiceError("未找到补丁产物", 404);
    const artifactsRoot = join(project.workRoot, ".artifacts");
    if (!existsSync(artifactsRoot)) throw new DelegationServiceError("未找到补丁产物", 404);
    const canonicalRoot = realpathSync(artifactsRoot);
    const candidate = resolve(canonicalRoot, record.jobId, "changes.patch");
    if (!isWithin(canonicalRoot, candidate) || !existsSync(candidate)) {
      throw new DelegationServiceError("未找到补丁产物", 404);
    }
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > project.maxDiffBytes) {
      throw new DelegationServiceError("补丁产物无效", 409);
    }
    const bytes = readFileSync(candidate);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== record.report.patchSha256) {
      throw new DelegationServiceError("补丁产物完整性校验失败", 409);
    }
    return { bytes, sha256 };
  }

  cancelForPrincipal(principal: DelegationPrincipal, jobId: string): DelegationJobRecord {
    const record = this.getForPrincipal(principal, jobId);
    if (!record) throw new DelegationServiceError("未找到任务", 404);
    return this.cancel(record);
  }

  cancelAsOwner(jobId: string): DelegationJobRecord {
    const record = this.journal.get(jobId);
    if (!record) throw new DelegationServiceError("未找到任务", 404);
    return this.cancel(record);
  }

  denyAsOwner(jobId: string): DelegationJobRecord {
    const record = this.journal.get(jobId);
    if (!record) throw new DelegationServiceError("未找到任务", 404);
    if (record.status !== "approval-required") {
      throw new DelegationServiceError("任务当前不等待发布审批", 409);
    }
    return this.journal.update(jobId, {
      status: "denied",
      progress: { percent: 100, step: "denied", message: "所有者拒绝发布" },
      report: {
        ...(record.report ?? {}),
        outcome: "denied",
        summary: "所有者拒绝发布；线上 MarkSec 未发生变更。",
      },
    });
  }

  approveAsOwner(jobId: string): never {
    const record = this.journal.get(jobId);
    if (!record) throw new DelegationServiceError("未找到任务", 404);
    if (record.status !== "approval-required") {
      throw new DelegationServiceError("任务当前不等待发布审批", 409);
    }
    throw new DelegationServiceError("尚未配置固定发布 broker；审批产物已保留，但不会写入线上 MarkSec", 409);
  }

  createToken(input: unknown): { principal: Omit<DelegationPrincipal, "tokenHash">; token: string } {
    const config = this.requireConfig();
    const parsed = CreateTokenSchema.parse(input);
    for (const projectId of parsed.projectIds) {
      const project = config.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new DelegationServiceError(`未知项目 ${projectId}`, 400);
      if (parsed.modes.some((mode) => !project.allowedModes.includes(mode))) {
        throw new DelegationServiceError(`所选模式不适用于项目 ${projectId}`, 400);
      }
    }
    const issued = generatePrincipalToken();
    const principal: DelegationPrincipal = {
      id: `agent-${randomUUID()}`,
      label: parsed.label,
      tokenHash: issued.tokenHash,
      projectIds: parsed.projectIds,
      modes: parsed.modes,
      expiresAt: new Date(this.now() + parsed.expiresInDays * 24 * 60 * 60_000).toISOString(),
    };
    this.config = this.configStore.save({
      ...config,
      principals: [...config.principals, principal],
    });
    const { tokenHash: _tokenHash, ...safePrincipal } = principal;
    return { principal: safePrincipal, token: issued.takePlaintext() };
  }

  revokeToken(principalIdInput: string): Omit<DelegationPrincipal, "tokenHash"> {
    const config = this.requireConfig();
    const principalId = DelegationSafeIdSchema.parse(principalIdInput);
    const current = config.principals.find((principal) => principal.id === principalId);
    if (!current) throw new DelegationServiceError("未找到令牌", 404);
    const revokedAt = current.revokedAt ?? new Date(this.now()).toISOString();
    this.config = this.configStore.save({
      ...config,
      principals: config.principals.map((principal) => (
        principal.id === principalId ? { ...principal, revokedAt } : principal
      )),
    });
    const revoked = this.config.principals.find((principal) => principal.id === principalId)!;
    const { tokenHash: _tokenHash, ...safePrincipal } = revoked;
    return safePrincipal;
  }

  private requireConfig(): DelegationConfig {
    if (!this.config) throw new DelegationServiceError("委托服务尚未配置", 503);
    return this.config;
  }

  private cancel(record: DelegationJobRecord): DelegationJobRecord {
    if (TERMINAL_STATUSES.has(record.status)) return record;
    const queuedIndex = this.queue.findIndex((item) => item.record.jobId === record.jobId);
    if (queuedIndex >= 0) {
      const [queued] = this.queue.splice(queuedIndex, 1);
      queued?.permit.release();
    }
    const active = this.active.get(record.jobId);
    if (active) {
      active.cancelledByOwner = true;
      const cancelled = this.journal.update(record.jobId, {
        status: "cancelled",
        progress: { percent: record.progress.percent, step: "cancelled", message: "正在终止任务进程组" },
        report: {
          outcome: "cancelled",
          summary: "取消请求已持久化；Argus 正在终止隔离任务，线上 MarkSec 未发生变更。",
        },
      });
      active.controller.abort();
      return cancelled;
    }
    return this.journal.update(record.jobId, {
      status: "cancelled",
      progress: { percent: record.progress.percent, step: "cancelled", message: "任务已取消" },
      report: {
        ...(record.report ?? {}),
        outcome: "cancelled",
        summary: "任务已取消；线上 MarkSec 未发生变更。",
      },
    });
  }

  private recoverJobs(): void {
    const config = this.config;
    for (const record of this.journal.list(500).reverse()) {
      if (record.status === "running") {
        this.journal.update(record.jobId, {
          status: "failed",
          progress: { percent: record.progress.percent, step: "restart", message: "服务重启，任务未自动重试" },
          report: failureReport("Seoul 控制服务在任务执行期间重启。为避免重复执行，该任务未自动重试。"),
        });
        continue;
      }
      if (record.status !== "queued") continue;
      const principal = config?.principals.find((candidate) => candidate.id === record.principalId);
      const project = config?.projects.find((candidate) => candidate.id === record.projectId);
      if (!config || !principal || !project || principalStatus(principal, this.now()) !== "active") {
        this.journal.update(record.jobId, {
          status: "failed",
          progress: { percent: 0, step: "policy", message: "恢复时授权已不可用" },
          report: failureReport("恢复排队任务时找不到有效的项目授权。"),
        });
        continue;
      }
      try {
        authorizeDelegationRequest(config, principal, record.request);
        const readiness = this.runner.readiness(toRunnerProject(project));
        if (!readiness.ready) throw new Error("runner not ready");
        this.queue.push({ record, project, permit: noopPermit(principal.id) });
      } catch {
        this.journal.update(record.jobId, {
          status: "failed",
          progress: { percent: 0, step: "policy", message: "恢复时项目策略不可用" },
          report: failureReport("恢复排队任务时项目策略或执行器已不可用。"),
        });
      }
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.stopped) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.active.size < this.globalConcurrency) {
      const activeProjects = new Set([...this.active.values()].map((run) => run.projectId));
      const index = this.queue.findIndex((item) => !activeProjects.has(item.project.id));
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      if (!item) return;
      const current = this.journal.get(item.record.jobId);
      if (!current || current.status !== "queued") {
        item.permit.release();
        continue;
      }
      const controller = new AbortController();
      this.active.set(current.jobId, {
        projectId: item.project.id,
        controller,
        permit: item.permit,
        cancelledByOwner: false,
      });
      void this.execute(current, item.project, controller.signal).finally(() => {
        const active = this.active.get(current.jobId);
        active?.permit.release();
        this.active.delete(current.jobId);
        this.scheduleDrain();
      });
    }
  }

  private async execute(
    record: DelegationJobRecord,
    project: DelegationProjectPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.journal.update(record.jobId, {
        status: "running",
        phase: "preparing",
        progress: { percent: 1, step: "preparing", message: "正在准备隔离工作区" },
      });
      const result = await this.runner.run(toRunnerProject(project), {
        jobId: record.jobId,
        principalId: record.principalId,
        mode: record.request.mode,
        goal: record.request.goal,
        acceptance: record.request.acceptance,
        ...(record.request.baseRevision ? { baseRevision: record.request.baseRevision } : {}),
        ...(record.request.domain ? { domain: record.request.domain } : {}),
      }, {
        signal,
        onProgress: (phase, progress, message) => {
          if (this.journal.get(record.jobId)?.status !== "running") return;
          this.journal.update(record.jobId, {
            status: "running",
            phase,
            progress: { percent: Math.round(progress), step: phase, message },
          });
        },
      });
      if (this.journal.get(record.jobId)?.status === "cancelled") return;
      const report = buildReport(record.request, result);
      const publishReady = report.outcome === "success"
        && (report.acceptance ?? []).every((item) => item.status === "passed")
        && (report.verification ?? []).every((item) => item.status !== "failed");
      const status = record.request.mode === "publish"
        ? (publishReady ? "approval-required" : "failed")
        : (report.outcome === "failure" ? "failed" : "completed");
      this.journal.update(record.jobId, {
        status,
        phase: status === "approval-required" ? "awaiting-approval" : "finished",
        progress: {
          percent: 100,
          step: status === "approval-required" ? "approval" : "complete",
          message: status === "approval-required" ? "等待 Seoul 所有者审批发布" : "验收完成",
        },
        report,
      });
    } catch (error) {
      if (this.journal.get(record.jobId)?.status === "cancelled") return;
      const active = this.active.get(record.jobId);
      const cancelled = signal.aborted && active?.cancelledByOwner;
      this.journal.update(record.jobId, {
        status: cancelled ? "cancelled" : "failed",
        phase: "finished",
        progress: {
          percent: this.journal.get(record.jobId)?.progress.percent ?? 0,
          step: cancelled ? "cancelled" : "failed",
          message: cancelled ? "任务已取消" : "受限执行失败",
        },
        report: cancelled
          ? { outcome: "cancelled", summary: "任务已取消；线上 MarkSec 未发生变更。" }
          : failureReport(safeMessage(error instanceof Error ? error.message : String(error))),
      });
    }
  }
}

export function publicJobView(record: DelegationJobRecord): Record<string, unknown> {
  return {
    id: record.jobId,
    projectId: record.projectId,
    mode: record.request.mode,
    domain: record.request.domain,
    goal: boundedMessage(record.request.goal, 2_048),
    ...(!record.report ? { acceptance: record.request.acceptance } : {}),
    baseRevision: record.request.baseRevision,
    status: record.status,
    phase: record.phase,
    progress: record.progress,
    report: record.report,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

function ownerJobView(record: DelegationJobRecord): Record<string, unknown> {
  return {
    ...publicJobView(record),
    principalId: record.principalId,
  };
}

function toRunnerProject(project: DelegationProjectPolicy): DelegationRunnerProject {
  return {
    id: project.id,
    displayName: project.displayName,
    sourceRoot: project.sourceRoot,
    workRoot: project.workRoot,
    defaultRef: project.defaultRef,
    allowedDomains: project.allowedDomains,
    codexExecutable: project.codexExecutable,
    maxRuntimeMs: project.maxRuntimeMs,
    maxChangedFiles: project.maxChangedFiles,
    maxDiffBytes: project.maxDiffBytes,
    copyExcludes: project.copyExcludes,
    verificationCommands: project.verificationCommands?.map((command) => ({
      label: command.label,
      executable: command.argv[0]!,
      args: command.argv.slice(1),
      ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
    })),
  };
}

function buildReport(request: DelegationJobRequest, result: DelegationRunResult): DelegationReport {
  const acceptance = request.acceptance.map((criterion) => {
    const evidence = result.acceptance.find((item) => item.criterion === criterion);
    return evidence
      ? { criterion, status: evidence.status, detail: boundedMessage(evidence.evidence, 256) || undefined }
      : { criterion, status: "not-run" as const, detail: "Codex 未返回与该条件精确匹配的证据" };
  });
  const failedVerification = result.checks.some((check) => check.status === "failed");
  const incompleteAcceptance = acceptance.some((item) => item.status !== "passed");
  const outcome = result.outcome === "blocked"
    ? "failure"
    : result.outcome === "partial" || failedVerification || incompleteAcceptance
      ? "partial"
      : "success";
  const warnings = [...result.risks, ...result.nextSteps]
    .map((value) => boundedMessage(value, 512))
    .filter(Boolean)
    .slice(0, 7);
  if (result.changedFiles.length > 40) {
    warnings.push(`变更文件列表仅展示前 40 个，共 ${result.changedFiles.length} 个`);
  }
  return {
    outcome,
    summary: boundedMessage(result.summary, 2_048) || "Codex 已结束，但未提供摘要。",
    baseRevision: result.baseRevision,
    finalRevision: result.finalRevision,
    changedFileCount: result.changedFiles.length,
    changedFiles: result.changedFiles.slice(0, 40),
    diffBytes: result.patchBytes,
    patchSha256: result.patchSha256,
    reportSha256: result.reportSha256,
    ...(result.sourceSnapshotSha256 ? { sourceSnapshotSha256: result.sourceSnapshotSha256 } : {}),
    commandCount: result.commandCount,
    acceptance,
    verification: result.checks.slice(0, 16).map((check, index) => ({
      id: `check-${index + 1}`,
      status: check.status,
      ...(typeof check.exitCode === "number" && check.exitCode >= -1 && check.exitCode <= 255
        ? { exitCode: check.exitCode }
        : {}),
      ...(typeof check.durationMs === "number" ? { durationMs: check.durationMs } : {}),
      ...(boundedMessage(check.summary, 256) ? { summary: boundedMessage(check.summary, 256) } : {}),
    })),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 8) } : {}),
  };
}

function failureReport(summary: string): DelegationReport {
  return { outcome: "failure", summary: safeMessage(summary) || "受限执行失败。" };
}

function safeMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/[A-Za-z0-9_-]{43}/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function boundedMessage(value: string, maxBytes: number): string {
  const clean = safeMessage(value);
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.length <= maxBytes) return clean;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function principalStatus(principal: DelegationPrincipal, now: number): "active" | "expired" | "revoked" {
  if (principal.revokedAt) return "revoked";
  if (principal.expiresAt && Date.parse(principal.expiresAt) <= now) return "expired";
  return "active";
}

function parsePublicPath(value: string): string {
  const path = value.trim();
  if (!path) return "";
  if (!PUBLIC_PATH_PATTERN.test(path)) {
    throw new Error("ARGUS_DELEGATION_PUBLIC_PATH 必须是 /d/ 后跟 64 位小写十六进制秘密");
  }
  return path;
}

function parsePublicOrigin(value: string): string {
  const input = value.trim();
  if (!input) return "";
  let origin: URL;
  try {
    origin = new URL(input);
  } catch {
    throw new Error("ARGUS_DELEGATION_PUBLIC_ORIGIN 必须是 HTTPS origin");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("ARGUS_DELEGATION_PUBLIC_ORIGIN 必须是无路径的 HTTPS origin");
  }
  return origin.origin;
}

function boundedConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new Error("delegation globalConcurrency 必须在 1 到 16 之间");
  }
  return value;
}

function noopPermit(principalId: string): DelegationLimitPermit {
  return { principalId, release: () => undefined };
}
