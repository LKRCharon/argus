#!/bin/bash
# Secret-free, read-only KMac readiness checks. No service is restarted here.
set -u

SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
REPO_ROOT="${1:-$(CDPATH= cd -P -- "$SCRIPT_DIR/../.." && pwd -P)}"
AGENTLINK_BASE="${AGENTLINK_INSTALL_ROOT:-$HOME/Library/Application Support/AgentLink}"
PREPARED_ROOT="$AGENTLINK_BASE/prepared/${ARGUS_BACKUP_TAG:-argus-infra-stage1-20260830}"
EXPECTED_REMOTE="git@github-argus-clash:LKRCharon/argus.git"
EXPECTED_FETCH='+refs/heads/*:refs/remotes/origin/*'
readonly GITHUB_STATUS_RUNNER_ID="kmac-github-status-v1"
readonly CODEX_TASK_RUNNER_ID="kmac-codex-v1"
readonly EXPECTED_RUNTIME_BUN="$AGENTLINK_BASE/runtime/bun-1.3.14/bin/bun"
readonly EXPECTED_GITHUB_PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
readonly EXPECTED_CODEX_BIN="$HOME/.local/bin/codex"
readonly EXPECTED_CODEX_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
failures=0
warnings=0

fail() {
  printf '%s=FAIL\n' "$1"
  failures=$((failures + 1))
}

warn() {
  printf '%s=%s\n' "$1" "$2"
  warnings=$((warnings + 1))
}

ok() {
  printf '%s=%s\n' "$1" "$2"
}

mesh_remote_codex_control_state() {
  local config="$1"
  CONFIG="$config" /opt/homebrew/bin/bun -e '
    try {
      const value = await Bun.file(process.env.CONFIG).json();
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        console.log("invalid");
      } else {
        console.log(value.remoteCodexControl === true ? "enabled" : "disabled");
      }
    } catch {
      console.log("invalid");
    }
  ' 2>/dev/null || true
}

if [[ ! -d "$REPO_ROOT" ]] || ! /usr/bin/git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  fail REPOSITORY
else
  ok REPOSITORY "$REPO_ROOT"
fi

path_probe="$(/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/zsh -lc \
  'printf "%s\n" "$(command -v codex 2>/dev/null || true)" "$(command -v bun 2>/dev/null || true)"')"
path_codex="$(printf '%s\n' "$path_probe" | /usr/bin/sed -n '1p')"
path_bun="$(printf '%s\n' "$path_probe" | /usr/bin/sed -n '2p')"
if [[ "$path_codex" == "$HOME/.local/bin/codex" ]]; then
  codex_version="$($path_codex --version 2>/dev/null | /usr/bin/head -1)"
  [[ -n "$codex_version" ]] && ok NONINTERACTIVE_CODEX "$codex_version" || fail NONINTERACTIVE_CODEX
else
  fail NONINTERACTIVE_CODEX
fi
[[ "$path_bun" == /opt/homebrew/bin/bun ]] && ok NONINTERACTIVE_BUN "$path_bun" || fail NONINTERACTIVE_BUN

probe_bun="${path_bun:-/opt/homebrew/bin/bun}"
if [[ -x "$probe_bun" ]]; then
  readiness_probes="$($probe_bun "$SCRIPT_DIR/kmac-readiness-probes.ts" --json 2>/dev/null || true)"
  if [[ "$readiness_probes" == \{*\} ]]; then
    ok READINESS_PROBES "$readiness_probes"
    github_auth_state="$(GITHUB_PROBES="$readiness_probes" "$probe_bun" -e '
      try {
        const value = JSON.parse(process.env.GITHUB_PROBES ?? "{}");
        const status = value?.github?.status?.status;
        process.stdout.write(["authenticated", "unauthenticated", "unavailable", "error"].includes(status) ? status : "unavailable");
      } catch {
        process.stdout.write("unavailable");
      }
    ' 2>/dev/null || printf 'unavailable')"
    case "$github_auth_state" in
      authenticated) ok GITHUB_AUTH AUTHENTICATED ;;
      unauthenticated) warn GITHUB_AUTH UNAUTHENTICATED ;;
      unavailable) warn GITHUB_AUTH UNAVAILABLE ;;
      *) fail GITHUB_AUTH ERROR ;;
    esac
  else
    warn READINESS_PROBES TOOLING_MISSING
    warn GITHUB_AUTH UNAVAILABLE
  fi
else
  warn READINESS_PROBES TOOLING_MISSING
  warn GITHUB_AUTH UNAVAILABLE
fi

if [[ -d "$REPO_ROOT" ]]; then
  remote_url="$(/usr/bin/git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  fetch_specs="$(/usr/bin/git -C "$REPO_ROOT" config --local --get-all remote.origin.fetch 2>/dev/null || true)"
  [[ "$remote_url" == "$EXPECTED_REMOTE" ]] && ok GIT_REMOTE "$remote_url" || fail GIT_REMOTE
  [[ "$fetch_specs" == "$EXPECTED_FETCH" ]] && ok GIT_FETCH_REFSPEC "$fetch_specs" || fail GIT_FETCH_REFSPEC
  remote_main="$(GIT_TERMINAL_PROMPT=0 /usr/bin/git -C "$REPO_ROOT" ls-remote origin refs/heads/main 2>/dev/null | /usr/bin/awk 'NR == 1 {print $1}')"
  fetched_main="$(/usr/bin/git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main 2>/dev/null || true)"
  if [[ -n "$remote_main" && "$remote_main" == "$fetched_main" ]]; then
    ok GIT_MAIN_READBACK "$remote_main"
  else
    fail GIT_MAIN_READBACK
  fi
fi

github_ssh="$(/usr/bin/ssh -G github-argus-clash 2>/dev/null || true)"
if printf '%s\n' "$github_ssh" | /usr/bin/grep -qx 'hostname ssh.github.com' \
  && printf '%s\n' "$github_ssh" | /usr/bin/grep -qx 'port 443' \
  && printf '%s\n' "$github_ssh" | /usr/bin/grep -q '^proxycommand /usr/bin/nc -X connect -x 127.0.0.1:46640 %h %p$'; then
  ok GITHUB_SSH_ROUTE CLASH_127.0.0.1_46640
else
  fail GITHUB_SSH_ROUTE
fi

local_banner="$(/usr/bin/nc -G 3 127.0.0.1 22 </dev/null 2>/dev/null | /usr/bin/head -1 | /usr/bin/tr -d '\r')"
[[ "$local_banner" == SSH-2.0-* ]] && ok REVERSE_LAYER1_KMAC_SSH "$local_banner" || fail REVERSE_LAYER1_KMAC_SSH

reverse_pid="$(/bin/ps axww -o pid=,command= | /usr/bin/awk \
  '/\/usr\/bin\/ssh .* -R 127\.0\.0\.1:22022:127\.0\.0\.1:22 seoul/ {print $1; exit}')"
[[ -n "$reverse_pid" ]] && ok REVERSE_LAYER2_FORWARD_PROCESS "$reverse_pid" || fail REVERSE_LAYER2_FORWARD_PROCESS

remote_tunnel="$(/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=10 seoul \
  'set -eu; if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :22022"; else netstat -an | grep "[.:]22022[[:space:]].*LISTEN"; fi; printf "BANNER "; timeout 5 nc 127.0.0.1 22022 | head -1' 2>/dev/null || true)"
if printf '%s\n' "$remote_tunnel" | /usr/bin/grep -q '127.0.0.1:22022' \
  && printf '%s\n' "$remote_tunnel" | /usr/bin/grep -q 'BANNER SSH-2.0-'; then
  ok REVERSE_LAYER3_SEOUL_READBACK HEALTHY
else
  fail REVERSE_LAYER3_SEOUL_READBACK
fi

reverse_label="gui/$(/usr/bin/id -u)/com.kairong.agentlink-seoul-reverse-tunnel"
prepared_plist="$PREPARED_ROOT/com.kairong.agentlink-seoul-reverse-tunnel.plist"
if /bin/launchctl print "$reverse_label" >/dev/null 2>&1; then
  warn REVERSE_PERSISTENCE LOADED_UNEXPECTEDLY_FOR_STAGE1
elif [[ -f "$prepared_plist" ]] && /usr/bin/plutil -lint "$prepared_plist" >/dev/null 2>&1; then
  ok REVERSE_PERSISTENCE PREPARED_NOT_LOADED
else
  fail REVERSE_PERSISTENCE
fi

watch_label="gui/$(/usr/bin/id -u)/com.kairong.agentlink-watch"
if /bin/launchctl print "$watch_label" 2>/dev/null | /usr/bin/grep -q 'state = running'; then
  current_release="$(/usr/bin/readlink "$AGENTLINK_BASE/current" 2>/dev/null || true)"
  ok WATCHER_RUNNING "$(/usr/bin/basename "$current_release" 2>/dev/null || true)"
else
  fail WATCHER_RUNNING
fi

live_mesh="$AGENTLINK_BASE/state/mesh.json"
prepared_mesh="$PREPARED_ROOT/mesh.json"
if [[ -f "$live_mesh" ]]; then
  live_status="$(CONFIG="$live_mesh" /opt/homebrew/bin/bun -e \
    'const c=await Bun.file(process.env.CONFIG).json(); const r=(c.resources??[]).find((x)=>x.id==="workspace:kmac-m4"); console.log(r?.statusRunnerId??"missing");' 2>/dev/null || true)"
  [[ "$live_status" == kmac-status-v1 ]] && ok LIVE_STATUS_RUNNER "$live_status" || fail LIVE_STATUS_RUNNER
  live_github_status="$(CONFIG="$live_mesh" /opt/homebrew/bin/bun -e \
    'const c=await Bun.file(process.env.CONFIG).json(); const r=(c.resources??[]).find((x)=>x.id==="workspace:kmac-m4"); console.log(r?.githubStatusRunnerId??"missing");' 2>/dev/null || true)"
  [[ "$live_github_status" == "$GITHUB_STATUS_RUNNER_ID" ]] && ok LIVE_GITHUB_STATUS_RUNNER "$live_github_status" || fail LIVE_GITHUB_STATUS_RUNNER
  live_remote_codex_control="$(mesh_remote_codex_control_state "$live_mesh")"
  case "$live_remote_codex_control" in
    enabled) ok LIVE_REMOTE_CODEX_CONTROL ENABLED ;;
    disabled) warn LIVE_REMOTE_CODEX_CONTROL DISABLED ;;
    *) fail LIVE_REMOTE_CODEX_CONTROL ;;
  esac
else
  fail LIVE_STATUS_RUNNER
  fail LIVE_REMOTE_CODEX_CONTROL
fi
if [[ -f "$prepared_mesh" ]]; then
  prepared_status="$(CONFIG="$prepared_mesh" EXPECTED_RESOURCE_ID="workspace:kmac-m4" EXPECTED_GITHUB_STATUS_RUNNER_ID="$GITHUB_STATUS_RUNNER_ID" EXPECTED_RUNTIME_BUN="$EXPECTED_RUNTIME_BUN" EXPECTED_GITHUB_HOME="$HOME" EXPECTED_GITHUB_PATH="$EXPECTED_GITHUB_PATH" EXPECTED_CODEX_BIN="$EXPECTED_CODEX_BIN" EXPECTED_CODEX_PATH="$EXPECTED_CODEX_PATH" EXPECTED_ARTIFACT_ROOT="$AGENTLINK_BASE/state/mesh-workspaces" EXPECTED_RELEASE_ROOT="$AGENTLINK_BASE/releases/" /opt/homebrew/bin/bun -e '
    try {
      const c = await Bun.file(process.env.CONFIG).json();
      const resources = Array.isArray(c?.resources) ? c.resources : [];
      const runners = Array.isArray(c?.runners) ? c.runners : [];
      const resource = resources.find((entry) => entry?.id === process.env.EXPECTED_RESOURCE_ID);
      const runner = runners.find((entry) => entry?.id === "kmac-status-v1");
      const github = runners.find((entry) => entry?.id === process.env.EXPECTED_GITHUB_STATUS_RUNNER_ID);
      const codex = runners.find((entry) => entry?.id === "kmac-codex-v1");
      const statusArg = Array.isArray(runner?.fixedArgs) && runner.fixedArgs.length === 1
        && typeof runner.fixedArgs[0] === "string" ? runner.fixedArgs[0] : "";
      const statusMarker = "/deploy/kmac-workspace-status.ts";
      const candidateRelease = statusArg.endsWith(statusMarker)
        ? statusArg.slice(0, -statusMarker.length) : "";
      const releaseRoot = process.env.EXPECTED_RELEASE_ROOT ?? "";
      const releaseId = candidateRelease.startsWith(releaseRoot)
        ? candidateRelease.slice(releaseRoot.length) : "";
      const expectedGithubArg = candidateRelease
        ? candidateRelease + "/deploy/kmac-github-status.ts" : "";
      const githubEnv = github?.env;
      const expectedEnv = {
        HOME: process.env.EXPECTED_GITHUB_HOME,
        PATH: process.env.EXPECTED_GITHUB_PATH,
      };
      const githubEnvMatches = githubEnv !== null
        && typeof githubEnv === "object"
        && !Array.isArray(githubEnv)
        && Object.keys(githubEnv).length === Object.keys(expectedEnv).length
        && Object.entries(expectedEnv).every(([key, value]) => githubEnv[key] === value);
      const codexEnv = codex?.env;
      const expectedCodexEnv = {
        HOME: process.env.EXPECTED_GITHUB_HOME,
        PATH: process.env.EXPECTED_CODEX_PATH,
      };
      const codexEnvMatches = codexEnv !== null
        && typeof codexEnv === "object"
        && !Array.isArray(codexEnv)
        && Object.keys(codexEnv).length === Object.keys(expectedCodexEnv).length
        && Object.entries(expectedCodexEnv).every(([key, value]) => codexEnv[key] === value);
      const codexArgs = ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-"];
      const codexCapabilities = ["structured-artifact-input", "task-scoped-workspace", "changed-file-manifest"];
      const codexResultKeys = ["runnerId", "exitCode", "signal", "timedOut", "durationMs", "resultSummary", "integrity", "baseArtifactId", "resultArtifactId", "resultArtifactSha256", "changedFiles", "deletedFiles"];
      const valid = c?.artifactRoot === process.env.EXPECTED_ARTIFACT_ROOT
        && resource?.id === process.env.EXPECTED_RESOURCE_ID
        && resource?.statusRunnerId === "kmac-status-v1"
        && resource?.githubStatusRunnerId === process.env.EXPECTED_GITHUB_STATUS_RUNNER_ID
        && runner?.executable === process.env.EXPECTED_RUNTIME_BUN
        && runner?.purpose === "status"
        && runner?.fixedArgs?.length === 1
        && /^[A-Za-z0-9._-]{1,80}$/.test(releaseId)
        && github?.resourceId === process.env.EXPECTED_RESOURCE_ID
        && github?.purpose === "status"
        && github?.executable === process.env.EXPECTED_RUNTIME_BUN
        && github?.fixedArgs?.length === 1
        && github.fixedArgs[0] === expectedGithubArg
        && github?.workdir === "."
        && github?.env !== undefined
        && github?.maxRuntimeMs === 10000
        && github?.maxOutputBytes === 8192
        && github?.approvalRequired === false
        && github?.allowDynamicArgs === false
        && github?.allowInput === false
        && Array.isArray(github?.workspaceCapabilities)
        && github.workspaceCapabilities.length === 1
        && github.workspaceCapabilities[0] === "read-only-status"
        && github?.exposeDebugOutput === false
        && githubEnvMatches
        && codex?.resourceId === process.env.EXPECTED_RESOURCE_ID
        && codex?.purpose === "task"
        && codex?.executable === process.env.EXPECTED_CODEX_BIN
        && JSON.stringify(codex?.fixedArgs) === JSON.stringify(codexArgs)
        && codex?.workdir === "."
        && codex?.maxRuntimeMs === 900000
        && codex?.maxOutputBytes === 262144
        && codex?.approvalRequired === true
        && codex?.allowDynamicArgs === false
        && codex?.allowInput === true
        && codex?.inputSchema?.type === "string"
        && codex?.inputSchema?.maxLength === 1048576
        && codex?.resultSchema?.additionalProperties === false
        && JSON.stringify(codex?.resultSchema?.required) === JSON.stringify(codexResultKeys)
        && JSON.stringify(Object.keys(codex?.resultSchema?.properties ?? {})) === JSON.stringify(codexResultKeys)
        && JSON.stringify(codex?.workspaceCapabilities) === JSON.stringify(codexCapabilities)
        && codex?.exposeDebugOutput === false
        && codexEnvMatches;
      console.log(valid ? "ready" : "invalid");
    } catch {
      console.log("invalid");
    }
  ' 2>/dev/null || true)"
  [[ "$prepared_status" == ready ]] && ok PREPARED_STATUS_RUNNER READY_NOT_ACTIVE || fail PREPARED_STATUS_RUNNER
  prepared_remote_codex_control="$(mesh_remote_codex_control_state "$prepared_mesh")"
  case "$prepared_remote_codex_control" in
    enabled) ok PREPARED_REMOTE_CODEX_CONTROL ENABLED ;;
    disabled) warn PREPARED_REMOTE_CODEX_CONTROL DISABLED ;;
    *) fail PREPARED_REMOTE_CODEX_CONTROL ;;
  esac
else
  warn PREPARED_STATUS_RUNNER NOT_PREPARED
  warn PREPARED_REMOTE_CODEX_CONTROL NOT_PREPARED
fi

if [[ -x /opt/homebrew/opt/openjdk@17/bin/java ]]; then
  java_version="$(/opt/homebrew/opt/openjdk@17/bin/java -version 2>&1 | /usr/bin/head -1)"
  ok JDK17 "$java_version"
else
  fail JDK17
fi

available_kib="$(/bin/df -Pk "$HOME" | /usr/bin/awk 'NR == 2 {print $4}')"
if [[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib >= 12 * 1024 * 1024 )); then
  ok ANDROID_DISK_GATE "${available_kib}KiB"
else
  fail ANDROID_DISK_GATE
fi

if (( failures == 0 )); then
  ok READINESS "STAGE1_READY_WITH_${warnings}_NOTICE(S)"
  exit 0
fi
printf 'READINESS=FAILED failures=%d notices=%d\n' "$failures" "$warnings"
exit 1
