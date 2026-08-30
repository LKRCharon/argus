#!/bin/bash
# Secret-free, read-only KMac readiness checks. No service is restarted here.
set -u

SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
REPO_ROOT="${1:-$(CDPATH= cd -P -- "$SCRIPT_DIR/../.." && pwd -P)}"
AGENTLINK_BASE="${AGENTLINK_INSTALL_ROOT:-$HOME/Library/Application Support/AgentLink}"
PREPARED_ROOT="$AGENTLINK_BASE/prepared/${ARGUS_BACKUP_TAG:-argus-infra-stage1-20260830}"
EXPECTED_REMOTE="git@github-argus-clash:LKRCharon/argus.git"
EXPECTED_FETCH='+refs/heads/*:refs/remotes/origin/*'
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

if [[ ! -d "$REPO_ROOT" ]] || ! /usr/bin/git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  fail REPOSITORY
else
  ok REPOSITORY "$REPO_ROOT"
fi

path_probe="$(/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/zsh -lc \
  'printf "%s\n" "$(command -v codex 2>/dev/null || true)" "$(command -v gh 2>/dev/null || true)" "$(command -v bun 2>/dev/null || true)"')"
path_codex="$(printf '%s\n' "$path_probe" | /usr/bin/sed -n '1p')"
path_gh="$(printf '%s\n' "$path_probe" | /usr/bin/sed -n '2p')"
path_bun="$(printf '%s\n' "$path_probe" | /usr/bin/sed -n '3p')"
if [[ "$path_codex" == "$HOME/.local/bin/codex" ]]; then
  codex_version="$($path_codex --version 2>/dev/null | /usr/bin/head -1)"
  [[ -n "$codex_version" ]] && ok NONINTERACTIVE_CODEX "$codex_version" || fail NONINTERACTIVE_CODEX
else
  fail NONINTERACTIVE_CODEX
fi
[[ "$path_gh" == /opt/homebrew/bin/gh ]] && ok NONINTERACTIVE_GH "$path_gh" || fail NONINTERACTIVE_GH
[[ "$path_bun" == /opt/homebrew/bin/bun ]] && ok NONINTERACTIVE_BUN "$path_bun" || fail NONINTERACTIVE_BUN

if [[ -x /opt/homebrew/bin/gh ]]; then
  if GH_PROMPT_DISABLED=1 /opt/homebrew/bin/gh auth status --hostname github.com >/dev/null 2>&1; then
    ok GH_KEYCHAIN_CONTEXT AVAILABLE
  else
    warn GH_KEYCHAIN_CONTEXT UNAVAILABLE_CONTEXT_LIMITATION
  fi
  ok GH_API_CAPABILITY WINDOWS_COMMANDER_DEFAULT
else
  fail GH_BINARY
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
  ok LIVE_STATUS_RUNNER "$live_status"
else
  fail LIVE_STATUS_RUNNER
fi
if [[ -f "$prepared_mesh" ]]; then
  prepared_status="$(CONFIG="$prepared_mesh" /opt/homebrew/bin/bun -e \
    'const c=await Bun.file(process.env.CONFIG).json(); const resource=(c.resources??[]).find((x)=>x.id==="workspace:kmac-m4"); const runner=(c.runners??[]).find((x)=>x.id==="kmac-status-v1"); const valid=resource?.statusRunnerId==="kmac-status-v1"&&runner?.purpose==="status"&&runner?.approvalRequired===false&&runner?.allowDynamicArgs===false&&runner?.allowInput===false; console.log(valid?"ready":"invalid");' 2>/dev/null || true)"
  [[ "$prepared_status" == ready ]] && ok PREPARED_STATUS_RUNNER READY_NOT_ACTIVE || fail PREPARED_STATUS_RUNNER
else
  warn PREPARED_STATUS_RUNNER NOT_PREPARED
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

android_check="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [[ -f "$android_check/platforms/android-35/android.jar" \
  && -x "$android_check/platform-tools/adb" \
  && -x "$android_check/build-tools/35.0.0/aapt2" ]]; then
  ok ANDROID_API35 READY
elif [[ -s "$android_check/licenses/android-sdk-license" ]]; then
  warn ANDROID_API35 PACKAGES_MISSING
else
  warn ANDROID_API35 NEED_ANDROID_LICENSE
fi

if (( failures == 0 )); then
  ok READINESS "STAGE1_READY_WITH_${warnings}_NOTICE(S)"
  exit 0
fi
printf 'READINESS=FAILED failures=%d notices=%d\n' "$failures" "$warnings"
exit 1
