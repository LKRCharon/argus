import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import {
  MeshGitHubStatusSchema,
  type MeshGitHubStatus,
} from "@agentlink/wire";

export const GITHUB_STATUS_RUNNER_ID = "kmac-github-status-v1";
export const KMAC_GITHUB_STATUS_RUNNER_ID = GITHUB_STATUS_RUNNER_ID;
export const KMAC_GITHUB_CLI_PATH = "/opt/homebrew/bin/gh";
export const KMAC_GITHUB_STATUS_ARGS = Object.freeze([
  "auth",
  "status",
  "--hostname",
  "github.com",
] as const);

const COMMAND_TIMEOUT_MS = 8_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export interface GitHubStatusCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: "missing" | "other";
  outputLimit?: boolean;
}

export interface GitHubStatusCommandOptions {
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type GitHubStatusCommandRunner = (
  command: string,
  args: readonly string[],
  options: GitHubStatusCommandOptions,
) => GitHubStatusCommandResult;

export interface KmacGitHubStatusOptions {
  env?: Readonly<Record<string, string | undefined>>;
  commandRunner?: GitHubStatusCommandRunner;
  isExecutable?: (path: string) => boolean;
  now?: () => Date;
}

/** Remove credential-like diagnostics before classification, even though none are returned. */
export function redactGitHubOutput(input: string, maxLength = MAX_COMMAND_OUTPUT_BYTES): string {
  return input
    .slice(0, maxLength)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat|oauth)[A-Za-z0-9_-]*_[A-Za-z0-9_=-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bAuthorization\s*:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: [REDACTED]")
    .replace(/\b(token|secret|password|private[_ -]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .slice(0, maxLength);
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: GitHubStatusCommandOptions,
): GitHubStatusCommandResult {
  const result = spawnSync(command, [...args], {
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });
  const errorCode = (result.error as { code?: unknown } | undefined)?.code;
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: errorCode === "ETIMEDOUT",
    spawnError: errorCode === "ENOENT" ? "missing" : result.error ? "other" : undefined,
    outputLimit: errorCode === "ENOBUFS" || errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  };
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Only these non-secret values reach gh; all GH/GITHUB/XDG override variables are discarded. */
export function githubStatusEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return {
    HOME: typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir(),
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    GH_PROMPT_DISABLED: "1",
  };
}

function loginFromOutput(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const match = /\b(?:logged in to )?github\.com\s+account\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/i.exec(line);
    if (match && GITHUB_LOGIN.test(match[1])) return match[1];
  }
  return null;
}

function sourceFromOutput(value: string): "keychain" | "config" {
  if (/keychain|keyring/i.test(value)) return "keychain";
  return "config";
}

type MeshGitHubErrorCode = Extract<MeshGitHubStatus, { errorCode: string }>["errorCode"];

function result(
  status: MeshGitHubStatus["status"],
  checkedAt: string,
  login: string | null,
  source: MeshGitHubStatus["source"],
  errorCode?: MeshGitHubErrorCode,
): MeshGitHubStatus {
  return MeshGitHubStatusSchema.parse({
    status,
    login,
    source,
    checkedAt,
    ...(errorCode ? { errorCode } : {}),
  });
}

function classifyCommand(
  command: GitHubStatusCommandResult,
  checkedAt: string,
): MeshGitHubStatus {
  const diagnostic = redactGitHubOutput(`${command.stdout}\n${command.stderr}`);
  if (command.status === 0) {
    const login = loginFromOutput(diagnostic);
    return login
      ? result("authenticated", checkedAt, login, sourceFromOutput(diagnostic))
      : result("error", checkedAt, null, "none", "invalid-output");
  }
  if (command.timedOut) return result("unavailable", checkedAt, null, "none", "timeout");
  if (command.outputLimit) return result("error", checkedAt, null, "none", "output-limit");
  if (command.spawnError === "missing") return result("unavailable", checkedAt, null, "none", "gh-missing");
  if (command.status === null || command.spawnError === "other") {
    return result("unavailable", checkedAt, null, "none", "spawn-failed");
  }
  if (/not logged in|not authenticated|authentication required|run gh auth login|no accounts? found/i.test(diagnostic)) {
    return result("unauthenticated", checkedAt, null, "none", "not-authenticated");
  }
  if (/could not resolve|connection|network|proxy|tls|timeout|timed out|unreachable|service unavailable/i.test(diagnostic)) {
    return result("unavailable", checkedAt, null, "none", "network-unavailable");
  }
  return result("error", checkedAt, null, "none", "command-failed");
}

/** Run the one owner-configured GitHub operation. The caller cannot supply argv, host, repo, or env. */
export function runKmacGitHubStatus(options: KmacGitHubStatusOptions = {}): MeshGitHubStatus {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const executable = options.isExecutable ?? defaultIsExecutable;
  if (!options.commandRunner && !executable(KMAC_GITHUB_CLI_PATH)) {
    return result("unavailable", checkedAt, null, "none", "gh-missing");
  }
  let command: GitHubStatusCommandResult;
  try {
    command = commandRunner(
      KMAC_GITHUB_CLI_PATH,
      KMAC_GITHUB_STATUS_ARGS,
      {
        env: githubStatusEnvironment(options.env),
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      },
    );
  } catch {
    return result("unavailable", checkedAt, null, "none", "spawn-failed");
  }
  return classifyCommand(command, checkedAt);
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    process.exitCode = 64;
  } else {
    // Every probe outcome is data. Keep the process successful so Mesh can parse
    // unauthenticated, unavailable, and error states instead of replacing them.
    process.stdout.write(`${JSON.stringify(runKmacGitHubStatus())}\n`);
  }
}
