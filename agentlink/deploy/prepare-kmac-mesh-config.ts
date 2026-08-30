import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  parseMeshConfig,
  type MeshConfig,
} from "../packages/daemon/src/mesh/config";

const RESOURCE_ID = "workspace:kmac-m4";
const RUNNER_ID = "kmac-status-v1";

export interface KmacStatusRunnerOptions {
  runtimeBun: string;
  statusScript: string;
  stateDir: string;
  codexLauncher: string;
  relayPort?: number;
}

function requireAbsolute(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

export function withKmacStatusRunner(
  config: MeshConfig,
  options: KmacStatusRunnerOptions,
): MeshConfig {
  requireAbsolute(options.runtimeBun, "runtimeBun");
  requireAbsolute(options.statusScript, "statusScript");
  requireAbsolute(options.stateDir, "stateDir");
  requireAbsolute(options.codexLauncher, "codexLauncher");
  const relayPort = options.relayPort ?? 28787;
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
    throw new Error("relayPort is invalid");
  }

  const resource = config.resources.find((entry) => entry.id === RESOURCE_ID);
  if (!resource) throw new Error(`missing resource ${RESOURCE_ID}`);
  const existing = config.runners?.find((runner) => runner.id === RUNNER_ID);
  if (existing && (existing.resourceId !== RESOURCE_ID || existing.purpose !== "status")) {
    throw new Error(`${RUNNER_ID} is already bound to another capability`);
  }

  const runner = {
    id: RUNNER_ID,
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

  return parseMeshConfig({
    ...config,
    resources: config.resources.map((entry) => entry.id === RESOURCE_ID
      ? { ...entry, statusRunnerId: RUNNER_ID }
      : entry),
    runners: [...(config.runners ?? []).filter((entry) => entry.id !== RUNNER_ID), runner],
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
  const prepared = withKmacStatusRunner(config, {
    runtimeBun: flag(args, "--runtime-bun"),
    statusScript: flag(args, "--status-script"),
    stateDir: flag(args, "--state-dir"),
    codexLauncher: flag(args, "--codex-launcher"),
  });
  const serialized = `${JSON.stringify(prepared, null, 2)}\n`;
  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, output);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    resourceId: RESOURCE_ID,
    statusRunnerId: RUNNER_ID,
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
