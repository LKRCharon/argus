import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type CredentialSourceKind = "keychain" | "env" | "none";

export type GitHubApiClassification =
  | "authenticated"
  | "unauthenticated"
  | "forbidden"
  | "unreachable"
  | "tooling-missing";

export type GitSshState = "reachable" | "unreachable" | "tooling-missing";

export interface GitHubReadiness {
  provider: "github";
  credentialSource: CredentialSourceKind;
  identity: { login: string } | null;
  gitSsh: {
    reachable: boolean;
    state: GitSshState;
  };
  api: {
    classification: GitHubApiClassification;
  };
}

export type AndroidSdkReadinessState =
  | "ready"
  | "missing-packages"
  | "missing-license"
  | "missing-tooling";

export type AndroidSdkRootSource = "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "known-location" | "none";
export type AndroidAdbSource = "PATH" | "sdk-root" | "none";

export interface AndroidSdkReadiness {
  provider: "android";
  state: AndroidSdkReadinessState;
  sdkRootSource: AndroidSdkRootSource;
  tooling: {
    adb: boolean;
    sdkRoot: boolean;
  };
  adb: {
    available: boolean;
    source: AndroidAdbSource;
  };
  license: {
    present: boolean;
  };
  packages: {
    platformTools: boolean;
    platformApi35: boolean;
    buildToolsApi35: boolean;
  };
}

export interface KMacReadinessProbes {
  github: GitHubReadiness;
  android: AndroidSdkReadiness;
}

export interface ProbeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface ProbeCommandOptions {
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProbeCommandRunner = (
  command: string,
  args: readonly string[],
  options: ProbeCommandOptions,
) => ProbeCommandResult;

export interface ReadinessProbeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: string;
  ghPath?: string;
  gitPath?: string;
  gitRemote?: string;
  knownSdkRoots?: readonly string[];
  commandRunner?: ProbeCommandRunner;
  isExecutable?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  hasContent?: (path: string) => boolean;
}

const COMMAND_TIMEOUT_MS = 8_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_GIT_REMOTE = "git@github-argus-clash:LKRCharon/argus.git";
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SECRET_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/** Redact command diagnostics before they can be inspected for classification. */
export function redactProbeText(input: string, maxLength = MAX_COMMAND_OUTPUT_BYTES): string {
  return input
    .slice(0, maxLength)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bAuthorization\s*:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: [REDACTED]")
    .replace(/\b(token|secret|password|private[_ -]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .slice(0, maxLength);
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: ProbeCommandOptions,
): ProbeCommandResult {
  const result = spawnSync(command, [...args], {
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: (result.error as { code?: string } | undefined)?.code === "ETIMEDOUT",
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasContent(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function commandEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  includeGitHubCredentials: boolean,
): Record<string, string> {
  const selected: Record<string, string> = {
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: env.HOME ?? homedir(),
    PATH: env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of ["GH_CONFIG_DIR", "SSH_AUTH_SOCK"] as const) {
    if (nonEmpty(env[key])) selected[key] = env[key];
  }
  if (includeGitHubCredentials) {
    for (const key of SECRET_ENV_KEYS) {
      if (nonEmpty(env[key])) selected[key] = env[key];
    }
  }
  return selected;
}

function executableFromPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  executable: (path: string) => boolean,
): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function firstExecutable(
  candidates: readonly (string | undefined)[],
  executable: (path: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate && executable(candidate)) return candidate;
  }
  return undefined;
}

function commandPath(
  name: string,
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  executable: (path: string) => boolean,
  fixedCandidates: readonly string[],
): string | undefined {
  return explicit
    ?? executableFromPath(name, env, executable)
    ?? firstExecutable(fixedCandidates, executable);
}

function commandResult(
  runner: ProbeCommandRunner,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): ProbeCommandResult {
  try {
    const result = runner(command, args, {
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    });
    return {
      status: typeof result.status === "number" ? result.status : null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      timedOut: result.timedOut === true,
    };
  } catch {
    return { status: null, stdout: "", stderr: "" };
  }
}

function parseLogin(value: string): { login: string } | null {
  const login = value.trim();
  return GITHUB_LOGIN.test(login) ? { login } : null;
}

function parseAuthStatusLogin(value: string): { login: string } | null {
  for (const line of value.split(/\r?\n/)) {
    const match = /\baccount\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/i.exec(line);
    if (match && GITHUB_LOGIN.test(match[1])) return { login: match[1] };
  }
  return null;
}

function hasEnvironmentCredential(env: Readonly<Record<string, string | undefined>>): boolean {
  return SECRET_ENV_KEYS.some((key) => nonEmpty(env[key]));
}

function authStatusLooksAuthenticated(result: ProbeCommandResult): boolean {
  return result.status === 0;
}

function classifyApiFailure(result: ProbeCommandResult): GitHubApiClassification {
  const text = redactProbeText(`${result.stdout}\n${result.stderr}`);
  if (/\b403\b|forbidden|rate limit/i.test(text)) return "forbidden";
  if (/\b401\b|unauthori[sz]ed|bad credentials|not logged in|authentication|invalid token/i.test(text)) {
    return "unauthenticated";
  }
  if (result.timedOut || /could not resolve|connection|network|proxy|tls|timeout|timed out|unreachable/i.test(text)) {
    return "unreachable";
  }
  return result.status === null ? "unreachable" : "unauthenticated";
}

function safeGitRemote(value: string): boolean {
  return value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value);
}

export function probeGitHubReadiness(options: ReadinessProbeOptions = {}): GitHubReadiness {
  const env = options.env ?? process.env;
  const executable = options.isExecutable ?? isExecutable;
  const runner = options.commandRunner ?? defaultCommandRunner;
  const gh = commandPath(
    "gh",
    options.ghPath,
    env,
    executable,
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"],
  );
  const git = commandPath(
    "git",
    options.gitPath,
    env,
    executable,
    ["/usr/bin/git"],
  );
  const ghCommandEnv = commandEnvironment(env, true);
  const gitCommandEnv = commandEnvironment(env, false);
  let credentialSource: CredentialSourceKind = hasEnvironmentCredential(env) ? "env" : "none";
  let identity: { login: string } | null = null;
  let apiClassification: GitHubApiClassification = "tooling-missing";

  if (gh) {
    const authStatus = commandResult(runner, gh, ["auth", "status", "--hostname", "github.com"], ghCommandEnv);
    identity = parseAuthStatusLogin(redactProbeText(`${authStatus.stdout}\n${authStatus.stderr}`));
    if (credentialSource === "none" && authStatusLooksAuthenticated(authStatus)) credentialSource = "keychain";

    const api = commandResult(runner, gh, ["api", "user", "--hostname", "github.com", "--jq", ".login"], ghCommandEnv);
    const apiLogin = api.status === 0 ? parseLogin(api.stdout) : null;
    if (apiLogin) {
      identity = apiLogin;
      apiClassification = "authenticated";
    } else {
      apiClassification = api.status === 0 ? "unauthenticated" : classifyApiFailure(api);
    }
  }

  let gitSshState: GitSshState = "tooling-missing";
  const remote = options.gitRemote ?? DEFAULT_GIT_REMOTE;
  if (git && safeGitRemote(remote)) {
    const gitResult = commandResult(runner, git, [
      "-c",
      "core.askPass=",
      "ls-remote",
      "--heads",
      remote,
    ], gitCommandEnv);
    gitSshState = gitResult.status === 0 ? "reachable" : "unreachable";
  }

  return {
    provider: "github",
    credentialSource,
    identity,
    gitSsh: {
      reachable: gitSshState === "reachable",
      state: gitSshState,
    },
    api: { classification: apiClassification },
  };
}

function defaultKnownSdkRoots(home: string, platform: string): string[] {
  if (platform === "win32") return [join(home, "AppData", "Local", "Android", "Sdk")];
  if (platform === "darwin") return [join(home, "Library", "Android", "sdk")];
  return [join(home, "Android", "Sdk"), join(home, "Library", "Android", "sdk")];
}

function chooseSdkRoot(
  env: Readonly<Record<string, string | undefined>>,
  knownRoots: readonly string[],
  directory: (path: string) => boolean,
): { path: string; source: Exclude<AndroidSdkRootSource, "none"> } | undefined {
  const configured: Array<{ path: string; source: Exclude<AndroidSdkRootSource, "none"> }> = [];
  if (nonEmpty(env.ANDROID_HOME)) configured.push({ path: env.ANDROID_HOME, source: "ANDROID_HOME" });
  if (nonEmpty(env.ANDROID_SDK_ROOT)) configured.push({ path: env.ANDROID_SDK_ROOT, source: "ANDROID_SDK_ROOT" });
  for (const candidate of configured) {
    if (directory(candidate.path)) return candidate;
  }
  for (const path of knownRoots) {
    if (directory(path)) return { path, source: "known-location" };
  }
  return undefined;
}

export function probeAndroidSdkReadiness(options: ReadinessProbeOptions = {}): AndroidSdkReadiness {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? homedir();
  const executable = options.isExecutable ?? isExecutable;
  const directory = options.isDirectory ?? isDirectory;
  const content = options.hasContent ?? hasContent;
  const knownRoots = options.knownSdkRoots ?? defaultKnownSdkRoots(home, platform);
  const sdk = chooseSdkRoot(env, knownRoots, directory);
  const pathAdb = executableFromPath("adb", env, executable);
  const sdkAdb = sdk ? join(sdk.path, "platform-tools", "adb") : undefined;
  const sdkAdbAvailable = Boolean(sdkAdb && executable(sdkAdb));
  const adbAvailable = Boolean(pathAdb) || sdkAdbAvailable;
  const adbSource: AndroidAdbSource = pathAdb ? "PATH" : sdkAdbAvailable ? "sdk-root" : "none";
  const platformTools = sdkAdbAvailable;
  const platformApi35 = Boolean(sdk && existsSync(join(sdk.path, "platforms", "android-35", "android.jar")));
  const buildToolsApi35 = Boolean(sdk && executable(join(sdk.path, "build-tools", "35.0.0", "aapt2")));
  const licensePresent = Boolean(sdk && content(join(sdk.path, "licenses", "android-sdk-license")));

  let state: AndroidSdkReadinessState;
  if (!sdk || !adbAvailable) {
    state = "missing-tooling";
  } else if (!licensePresent) {
    state = "missing-license";
  } else if (!platformTools || !platformApi35 || !buildToolsApi35) {
    state = "missing-packages";
  } else {
    state = "ready";
  }

  return {
    provider: "android",
    state,
    sdkRootSource: sdk?.source ?? "none",
    tooling: {
      adb: adbAvailable,
      sdkRoot: sdk !== undefined,
    },
    adb: {
      available: adbAvailable,
      source: adbSource,
    },
    license: { present: licensePresent },
    packages: {
      platformTools,
      platformApi35,
      buildToolsApi35,
    },
  };
}

export function collectKMacReadinessProbes(options: ReadinessProbeOptions = {}): KMacReadinessProbes {
  return {
    github: probeGitHubReadiness(options),
    android: probeAndroidSdkReadiness(options),
  };
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== "--json") process.exit(64);
  process.stdout.write(`${JSON.stringify(collectKMacReadinessProbes())}\n`);
}
