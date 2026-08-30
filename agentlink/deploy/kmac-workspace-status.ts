import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MeshWorkspaceStatusSchema,
  type MeshDeadlineStage,
  type MeshWorkspaceStatus,
} from "@agentlink/wire";

const ACTIVE_TASK_STATES = new Set(["received", "approval-required", "queued", "running"]);
const ALL_TASK_STATES = new Set([
  ...ACTIVE_TASK_STATES,
  "completed",
  "denied",
  "failed",
  "cancelled",
]);
const MAX_TASK_JOURNAL_BYTES = 10 * 1024 * 1024;

interface StatusInputs {
  watcherAvailable: boolean;
  relayAvailable: boolean;
  codexAppServerAvailable: boolean;
  activeJobs: number;
  taskJournalValid: boolean;
  workspaceRevision: string | null;
  checkedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function countActiveJobs(value: unknown): number {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks)) {
    throw new Error("invalid task journal");
  }
  let count = 0;
  for (const task of value.tasks) {
    if (!isRecord(task) || typeof task.status !== "string" || !ALL_TASK_STATES.has(task.status)) {
      throw new Error("invalid task record");
    }
    if (ACTIVE_TASK_STATES.has(task.status)) count += 1;
  }
  return count;
}

export function deriveWorkspaceStatus(inputs: StatusInputs): MeshWorkspaceStatus {
  let lastErrorStage: MeshDeadlineStage | null = null;
  if (!inputs.watcherAvailable) {
    lastErrorStage = "watcher";
  } else if (!inputs.relayAvailable) {
    lastErrorStage = "relay";
  } else if (!inputs.codexAppServerAvailable) {
    lastErrorStage = "app-server";
  } else if (!inputs.taskJournalValid) {
    lastErrorStage = "watcher";
  }

  return MeshWorkspaceStatusSchema.parse({
    connectionStatus: !inputs.watcherAvailable
      ? "offline"
      : inputs.relayAvailable ? "online" : "degraded",
    watcherAvailable: inputs.watcherAvailable,
    codexAppServerAvailable: inputs.codexAppServerAvailable,
    activeJobs: inputs.activeJobs,
    workspaceRevision: inputs.workspaceRevision,
    lastSuccess: lastErrorStage === null ? inputs.checkedAt : null,
    lastErrorStage,
    checkedAt: inputs.checkedAt,
  });
}

function commandSucceeds(executable: string, args: string[]): boolean {
  const result = spawnSync(executable, args, {
    stdio: "ignore",
    timeout: 2_000,
  });
  return result.status === 0 && !result.error;
}

const MAX_LAUNCHCTL_OUTPUT_BYTES = 16 * 1024;

/** Accept only launchd's bounded, explicit running state line. */
export function launchctlStateIsRunning(output: string): boolean {
  if (Buffer.byteLength(output, "utf8") > MAX_LAUNCHCTL_OUTPUT_BYTES) return false;
  return output.split(/\r?\n/).some((line) => /^\s*state\s*=\s*running\s*$/.test(line));
}

function watcherIsRunning(label: string): boolean {
  if (process.platform !== "darwin" || process.getuid === undefined) return false;
  const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    maxBuffer: MAX_LAUNCHCTL_OUTPUT_BYTES,
  });
  return result.status === 0
    && !result.error
    && typeof result.stdout === "string"
    && launchctlStateIsRunning(result.stdout);
}

function codexIsAvailable(): boolean {
  const candidates = [
    process.env.ARGUS_STATUS_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), ".codex/plugins/.plugin-appserver/codex"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (commandSucceeds(candidate, ["--version"])) return true;
    } catch {
      // Try the next fixed local candidate.
    }
  }
  return false;
}

function workspaceRevision(): string | null {
  const manifest = join(import.meta.dir, "..", ".argus-functional-manifest.json");
  if (existsSync(manifest)) {
    try {
      const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (isRecord(value)
        && typeof value.gitCommit === "string"
        && /^[a-f0-9]{40,64}$/.test(value.gitCommit)) {
        return value.gitCommit;
      }
    } catch {
      // A development checkout has no release manifest; use Git below.
    }
  }
  const result = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 2_000,
  });
  const revision = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return /^[a-f0-9]{40,64}$/.test(revision) ? revision : null;
}

function activeJobs(stateDir: string): { count: number; valid: boolean } {
  const journal = join(stateDir, "mesh-tasks.json");
  if (!existsSync(journal)) return { count: 0, valid: true };
  try {
    if (statSync(journal).size > MAX_TASK_JOURNAL_BYTES) return { count: 0, valid: false };
    return { count: countActiveJobs(JSON.parse(readFileSync(journal, "utf8"))), valid: true };
  } catch {
    return { count: 0, valid: false };
  }
}

function relayIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function configuredPort(): number {
  const value = Number(process.env.ARGUS_STATUS_RELAY_PORT ?? "28787");
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : 28787;
}

export async function collectWorkspaceStatus(): Promise<MeshWorkspaceStatus> {
  const checkedAt = new Date().toISOString();
  const jobs = activeJobs(
    process.env.ARGUS_STATUS_STATE_DIR ?? join(homedir(), ".agentlink"),
  );
  return deriveWorkspaceStatus({
    watcherAvailable: watcherIsRunning(
      process.env.ARGUS_STATUS_WATCH_LABEL ?? "com.kairong.agentlink-watch",
    ),
    relayAvailable: await relayIsAvailable(configuredPort()),
    codexAppServerAvailable: codexIsAvailable(),
    activeJobs: jobs.count,
    taskJournalValid: jobs.valid,
    workspaceRevision: workspaceRevision(),
    checkedAt,
  });
}

if (import.meta.main) {
  if (process.argv.length > 2) process.exit(64);
  void collectWorkspaceStatus()
    .then((status) => process.stdout.write(`${JSON.stringify(status)}\n`))
    .catch(() => {
      const checkedAt = new Date().toISOString();
      const fallback = deriveWorkspaceStatus({
        watcherAvailable: false,
        relayAvailable: false,
        codexAppServerAvailable: false,
        activeJobs: 0,
        taskJournalValid: false,
        workspaceRevision: null,
        checkedAt,
      });
      process.stdout.write(`${JSON.stringify(fallback)}\n`);
    });
}
