import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  parseMeshConfig,
  type MeshConfig,
} from "../packages/daemon/src/mesh/config";
import { GITHUB_STATUS_RUNNER_ID } from "./kmac-github-status";

const RESOURCE_ID = "workspace:kmac-m4";
const STATUS_RUNNER_ID = "kmac-status-v1";
export const CODEX_TASK_RUNNER_ID = "kmac-codex-v1";
export const CODEX_TASK_FIXED_ARGS = [
  "exec",
  "--sandbox", "workspace-write",
  "--skip-git-repo-check",
  "--ephemeral",
  "--color", "never",
  "-",
] as const;
export const CODEX_TASK_WORKSPACE_CAPABILITIES = [
  "structured-artifact-input",
  "task-scoped-workspace",
  "changed-file-manifest",
] as const;

export interface KmacStatusRunnerOptions {
  runtimeBun: string;
  statusScript: string;
  stateDir: string;
  codexLauncher: string;
  githubStatusScript?: string;
  githubHome?: string;
  relayPort?: number;
  enableRemoteCodexControl?: boolean;
}

function requireAbsolute(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function pathsOverlap(left: string, right: string): boolean {
  const contains = (root: string, candidate: string): boolean => {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  };
  return contains(left, right) || contains(right, left);
}

export function withKmacRunners(
  config: MeshConfig,
  options: KmacStatusRunnerOptions,
): MeshConfig {
  requireAbsolute(options.runtimeBun, "runtimeBun");
  requireAbsolute(options.statusScript, "statusScript");
  requireAbsolute(options.stateDir, "stateDir");
  requireAbsolute(options.codexLauncher, "codexLauncher");
  const githubStatusScript = options.githubStatusScript
    ?? join(dirname(options.statusScript), "kmac-github-status.ts");
  requireAbsolute(githubStatusScript, "githubStatusScript");
  const githubHome = options.githubHome ?? process.env.HOME ?? homedir();
  requireAbsolute(githubHome, "githubHome");
  const relayPort = options.relayPort ?? 28787;
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
    throw new Error("relayPort is invalid");
  }

  const resource = config.resources.find((entry) => entry.id === RESOURCE_ID);
  if (!resource) throw new Error(`missing resource ${RESOURCE_ID}`);
  const artifactRoot = join(options.stateDir, "mesh-workspaces");
  if (pathsOverlap(artifactRoot, resource.root)) {
    throw new Error("artifact workspace root must be isolated from the registered resource");
  }
  const existing = config.runners?.find((runner) => runner.id === STATUS_RUNNER_ID);
  if (existing && (existing.resourceId !== RESOURCE_ID || existing.purpose !== "status")) {
    throw new Error(`${STATUS_RUNNER_ID} is already bound to another capability`);
  }
  const existingGithub = config.runners?.find((runner) => runner.id === GITHUB_STATUS_RUNNER_ID);
  if (existingGithub && (existingGithub.resourceId !== RESOURCE_ID || existingGithub.purpose !== "status")) {
    throw new Error(`${GITHUB_STATUS_RUNNER_ID} is already bound to another capability`);
  }
  const existingCodex = config.runners?.find((runner) => runner.id === CODEX_TASK_RUNNER_ID);
  if (existingCodex && (existingCodex.resourceId !== RESOURCE_ID || existingCodex.purpose !== "task")) {
    throw new Error(`${CODEX_TASK_RUNNER_ID} is already bound to another capability`);
  }

  const runner = {
    id: STATUS_RUNNER_ID,
    resourceId: RESOURCE_ID,
    purpose: "status" as const,
    executable: options.runtimeBun,
    fixedArgs: [options.statusScript],
    workdir: ".",
    env: {
      PATH: `${dirname(options.codexLauncher)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      ARGUS_STATUS_STATE_DIR: options.stateDir,
      ARGUS_STATUS_WATCH_LABEL: "com.kairong.agentlink-watch",
      ARGUS_STATUS_CODEX_BIN: options.codexLauncher,
      ARGUS_STATUS_RELAY_PORT: String(relayPort),
    },
    maxRuntimeMs: 5_000,
    maxOutputBytes: 4_096,
    allowDynamicArgs: false,
    allowInput: false,
    title: "KMac workspace readiness",
    inputSchema: { type: "null" },
    resultSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "connectionStatus",
        "watcherAvailable",
        "codexAppServerAvailable",
        "remoteCodexControl",
        "activeJobs",
        "workspaceRevision",
        "lastSuccess",
        "lastErrorStage",
        "checkedAt",
      ],
    },
    approvalRequired: false,
    workspaceCapabilities: ["read-only-status" as const],
    exposeDebugOutput: false,
  };
  const githubRunner = {
    id: GITHUB_STATUS_RUNNER_ID,
    resourceId: RESOURCE_ID,
    purpose: "status" as const,
    executable: options.runtimeBun,
    fixedArgs: [githubStatusScript],
    workdir: ".",
    env: {
      HOME: githubHome,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    maxRuntimeMs: 10_000,
    maxOutputBytes: 8_192,
    allowDynamicArgs: false,
    allowInput: false,
    title: "KMac GitHub authentication readiness",
    inputSchema: { type: "null" },
    resultSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "login", "source", "checkedAt"],
      properties: {
        status: { enum: ["authenticated", "unauthenticated", "unavailable", "error"] },
        login: { type: ["string", "null"] },
        source: { enum: ["keychain", "config", "none"] },
        checkedAt: { type: "string" },
        errorCode: { type: "string" },
      },
    },
    approvalRequired: false,
    workspaceCapabilities: ["read-only-status" as const],
    exposeDebugOutput: false,
  };
  const codexRunner = {
    id: CODEX_TASK_RUNNER_ID,
    resourceId: RESOURCE_ID,
    purpose: "task" as const,
    executable: options.codexLauncher,
    fixedArgs: [...CODEX_TASK_FIXED_ARGS],
    workdir: ".",
    env: {
      HOME: githubHome,
      PATH: `${dirname(options.codexLauncher)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    maxRuntimeMs: 15 * 60_000,
    maxOutputBytes: 256 * 1024,
    allowDynamicArgs: false,
    allowInput: true,
    title: "KMac Codex isolated artifact task",
    inputSchema: { type: "string", maxLength: 1_048_576 },
    resultSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runnerId: { const: CODEX_TASK_RUNNER_ID },
        exitCode: { type: ["integer", "null"] },
        signal: { type: ["string", "null"] },
        timedOut: { type: "boolean" },
        durationMs: { type: "integer", minimum: 0 },
        resultSummary: { type: "string" },
        integrity: { type: "object" },
        baseArtifactId: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        resultArtifactId: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        resultArtifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        changedFiles: { type: "integer", minimum: 0, maximum: 256 },
        deletedFiles: { type: "integer", minimum: 0, maximum: 256 },
      },
      required: [
        "runnerId",
        "exitCode",
        "signal",
        "timedOut",
        "durationMs",
        "resultSummary",
        "integrity",
        "baseArtifactId",
        "resultArtifactId",
        "resultArtifactSha256",
        "changedFiles",
        "deletedFiles",
      ],
    },
    approvalRequired: true,
    workspaceCapabilities: [...CODEX_TASK_WORKSPACE_CAPABILITIES],
    exposeDebugOutput: false,
  };

  return parseMeshConfig({
    ...config,
    ...(options.enableRemoteCodexControl === true ? { remoteCodexControl: true } : {}),
    artifactRoot,
    resources: config.resources.map((entry) => entry.id === RESOURCE_ID
      ? { ...entry, statusRunnerId: STATUS_RUNNER_ID, githubStatusRunnerId: GITHUB_STATUS_RUNNER_ID }
      : entry),
    runners: [
      ...(config.runners ?? []).filter((entry) => ![
        STATUS_RUNNER_ID,
        GITHUB_STATUS_RUNNER_ID,
        CODEX_TASK_RUNNER_ID,
      ].includes(entry.id)),
      runner,
      githubRunner,
      codexRunner,
    ],
  });
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function main(args: string[]): void {
  const input = flag(args, "--input");
  const output = flag(args, "--output");
  if (input === output) throw new Error("stage one refuses to overwrite the live Mesh config");
  requireAbsolute(input, "input");
  requireAbsolute(output, "output");
  const source = readFileSync(input, "utf8");
  const config = parseMeshConfig(JSON.parse(source));
  const prepared = withKmacRunners(config, {
    runtimeBun: flag(args, "--runtime-bun"),
    statusScript: flag(args, "--status-script"),
    stateDir: flag(args, "--state-dir"),
    codexLauncher: flag(args, "--codex-launcher"),
    githubStatusScript: args.includes("--github-status-script")
      ? flag(args, "--github-status-script")
      : undefined,
    githubHome: args.includes("--github-home") ? flag(args, "--github-home") : undefined,
    enableRemoteCodexControl: args.includes("--enable-remote-codex-control"),
  });
  const serialized = `${JSON.stringify(prepared, null, 2)}\n`;
  const temporary = `${output}.${randomUUID()}.tmp`;
  let published = false;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
    published = true;
  } finally {
    if (!published && existsSync(temporary)) unlinkSync(temporary);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    resourceId: RESOURCE_ID,
    statusRunnerId: STATUS_RUNNER_ID,
    githubStatusRunnerId: GITHUB_STATUS_RUNNER_ID,
    taskRunnerId: CODEX_TASK_RUNNER_ID,
    remoteCodexControl: prepared.remoteCodexControl,
    inputSha256: sha256(source),
    outputSha256: sha256(serialized),
  })}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : "Mesh config preparation failed",
    })}\n`);
    process.exitCode = 1;
  }
}
