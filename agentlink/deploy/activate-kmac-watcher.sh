#!/bin/bash
# Rollback-safe activation of one immutable KMac watcher release.
set -Eeuo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
readonly BASE="${AGENTLINK_INSTALL_ROOT:-$HOME/Library/Application Support/AgentLink}"
readonly CURRENT="${ARGUS_CURRENT_LINK:-$BASE/current}"
readonly MESH_CONFIG="${ARGUS_MESH_CONFIG:-$BASE/state/mesh.json}"
readonly OLD_RELEASE="${ARGUS_EXPECTED_OLD_RELEASE:?ARGUS_EXPECTED_OLD_RELEASE is required}"
readonly CANDIDATE_RELEASE="${ARGUS_CANDIDATE_RELEASE:?ARGUS_CANDIDATE_RELEASE is required}"
readonly CANDIDATE_CONFIG="${ARGUS_CANDIDATE_CONFIG:?ARGUS_CANDIDATE_CONFIG is required}"
readonly REVIEWED_COMMIT="${ARGUS_REVIEWED_COMMIT:?ARGUS_REVIEWED_COMMIT is required}"
readonly EXPECTED_LIVE_MESH_SHA256="${ARGUS_EXPECTED_LIVE_MESH_SHA256:?ARGUS_EXPECTED_LIVE_MESH_SHA256 is required}"
readonly EXPECTED_CANDIDATE_MESH_SHA256="${ARGUS_EXPECTED_CANDIDATE_MESH_SHA256:?ARGUS_EXPECTED_CANDIDATE_MESH_SHA256 is required}"
readonly REPO_ROOT="${ARGUS_REPO_ROOT:-$(CDPATH= cd -P -- "$SCRIPT_DIR/../.." && pwd -P)}"
readonly BUN="${ARGUS_RUNTIME_BUN:-$BASE/runtime/bun-1.3.14/bin/bun}"
readonly LABEL="com.kairong.agentlink-watch"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly BACKUP_ROOT="${ARGUS_ACTIVATION_BACKUP_ROOT:-$BASE/activation/backups/stage2-20260830}"
readonly CONTROLLER_URL="${ARGUS_CONTROLLER_URL:-http://127.0.0.1:8790}"
readonly PEER_NAME="${ARGUS_PEER_NAME:-k Mac}"
readonly RESOURCE_ID="workspace:kmac-m4"
readonly RUNNER_ID="kmac-status-v1"
readonly GATES_MODULE="$SCRIPT_DIR/kmac-activation-gates.ts"

activation_attempted=0
baseline_last_seen=0
backup_mesh=""

sha256_file() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
fail_precondition() { printf 'BLOCKED gate=%s\n' "$1" >&2; exit 65; }

canonical_dir() {
  CDPATH= cd -P -- "$1" && pwd -P
}

canonical_file() {
  local file="$1" parent name
  [[ -f "$file" && ! -L "$file" ]] || return 1
  parent="$(canonical_dir "$(/usr/bin/dirname -- "$file")")" || return 1
  name="$(/usr/bin/basename -- "$file")"
  printf '%s/%s\n' "$parent" "$name"
}

canonical_release() {
  local value="$1"
  [[ -d "$value" && ! -L "$value" ]] || return 1
  canonical_dir "$value"
}

path_argument_is_persistent() {
  local value="$1"
  [[ "${#value}" -le 4096 && "$value" == /* && "$value" != "/tmp" && "$value" != "/private/tmp" \
    && "$value" != /tmp/* && "$value" != /private/tmp/* \
    && "$value" != *$'\n'* && "$value" != *$'\r'* \
    && "$value" != *"/../"* && "$value" != */.. ]]
}

path_is_under() {
  local root="$1" value="$2"
  [[ "$value" == "$root"/* ]]
}

controller_inputs_are_safe() {
  local port peer_name_re='^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'
  [[ "$CONTROLLER_URL" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]] || return 1
  port="${CONTROLLER_URL##*:}"
  (( port >= 1 && port <= 65535 )) || return 1
  [[ "$PEER_NAME" =~ $peer_name_re ]]
}

launchctl_output() {
  /bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null
}

watcher_running() {
  local output
  output="$(launchctl_output || true)"
  [[ "${#output}" -le 16384 ]] || return 1
  printf '%s\n' "$output" | /usr/bin/grep -Eq '^[[:space:]]*state[[:space:]]*=[[:space:]]*running[[:space:]]*$'
}

watcher_pid() {
  launchctl_output | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }'
}

verify_process() {
  local pid command
  watcher_running || return 1
  pid="$(watcher_pid)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$BUN"* && "$command" == *"$CURRENT/packages/daemon/src/index.ts"* && "$command" == *" watch"* ]]
}

verify_candidate_manifest() {
  local output
  output="$("$BUN" run "$CANDIDATE_RELEASE/scripts/release-manifest.ts" verify --release "$CANDIDATE_RELEASE" 2>/dev/null)" || return 1
  [[ "${#output}" -le 65536 ]] || return 1
  printf '%s' "$output" | env GATES_MODULE="$GATES_MODULE" EXPECTED_COMMIT="$REVIEWED_COMMIT" "$BUN" -e '
    const value = JSON.parse(await new Response(Bun.stdin.stream()).text());
    const { manifestMatchesReviewedCommit } = await import(process.env.GATES_MODULE);
    if (!manifestMatchesReviewedCommit(value, process.env.EXPECTED_COMMIT)) process.exit(1);
  ' >/dev/null
}

verify_candidate_config() {
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$CANDIDATE_CONFIG" 2>/dev/null || true)"
  [[ "$mode" == 600 ]] || return 1
  local actual_hash
  actual_hash="$(sha256_file "$CANDIDATE_CONFIG")"
  env GATES_MODULE="$GATES_MODULE" ACTUAL_HASH="$actual_hash" EXPECTED_HASH="$EXPECTED_CANDIDATE_MESH_SHA256" "$BUN" -e '
    const { candidateMeshHashMatches } = await import(process.env.GATES_MODULE);
    if (!candidateMeshHashMatches(process.env.ACTUAL_HASH, process.env.EXPECTED_HASH)) process.exit(1);
  ' >/dev/null || return 1
  CONFIG="$CANDIDATE_CONFIG" RELEASE="$CANDIDATE_RELEASE" \
    EXPECTED_RUNTIME_BUN="$BUN" \
    EXPECTED_STATE_DIR="$base_canonical/state" \
    EXPECTED_CODEX_BIN="$HOME/.local/bin/codex" \
    EXPECTED_STATUS_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$BUN" -e '
    const config = JSON.parse(await Bun.file(process.env.CONFIG).text());
    const { parseMeshConfig } = await import(`${process.env.RELEASE}/packages/daemon/src/mesh/config.ts`);
    const parsed = parseMeshConfig(config);
    const resource = parsed.resources.find((entry) => entry.id === "workspace:kmac-m4");
    const runner = parsed.runners?.find((entry) => entry.id === "kmac-status-v1");
    const expectedEnv = {
      PATH: process.env.EXPECTED_STATUS_PATH,
      ARGUS_STATUS_STATE_DIR: process.env.EXPECTED_STATE_DIR,
      ARGUS_STATUS_WATCH_LABEL: "com.kairong.agentlink-watch",
      ARGUS_STATUS_CODEX_BIN: process.env.EXPECTED_CODEX_BIN,
      ARGUS_STATUS_RELAY_PORT: "28787",
    };
    const env = runner?.env;
    const envMatches = env !== undefined
      && Object.keys(env).length === Object.keys(expectedEnv).length
      && Object.entries(expectedEnv).every(([key, value]) => env[key] === value);
    if (resource?.statusRunnerId !== "kmac-status-v1"
      || runner?.resourceId !== "workspace:kmac-m4"
      || runner?.purpose !== "status"
      || runner?.executable !== process.env.EXPECTED_RUNTIME_BUN
      || runner?.fixedArgs?.length !== 1
      || runner?.approvalRequired !== false
      || runner?.allowDynamicArgs !== false
      || runner?.allowInput !== false
      || runner?.workdir !== "."
      || runner?.maxRuntimeMs !== 5000
      || runner?.maxOutputBytes !== 4096
      || runner?.workspaceCapabilities?.length !== 1
      || runner.workspaceCapabilities[0] !== "read-only-status"
      || runner?.exposeDebugOutput !== false
      || !envMatches
      || runner?.fixedArgs?.[0] !== `${process.env.RELEASE}/deploy/kmac-workspace-status.ts`) process.exit(1);
  ' >/dev/null
}

controller_snapshot() {
  /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=3 -o ServerAliveCountMax=1 seoul \
    "/home/ubuntu/.bun/bin/bun -e 'const r=await fetch(\"$CONTROLLER_URL/api/overview\"); if(!r.ok) process.exit(1); const o=await r.json(); const p=(o.peers??[]).find((x)=>x.deviceName===\"$PEER_NAME\"); if(!p || (p.status!==\"online\" && p.status!==\"connecting\") || !Number.isInteger(p.lastSeen)) process.exit(1); process.stdout.write(p.status+\" \"+p.lastSeen+\"\\n\")'" 2>/dev/null
}

controller_verify() {
  local minimum_seen="$1" attempt snapshot status seen
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if snapshot="$(controller_snapshot 2>/dev/null)"; then
      status="${snapshot%% *}"; seen="${snapshot##* }"
      if [[ "$status" == online && "$seen" =~ ^[0-9]+$ ]] && (( seen > minimum_seen )); then
        /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=3 -o ServerAliveCountMax=1 seoul \
          "/home/ubuntu/.bun/bin/bun -e 'const r=await fetch(\"$CONTROLLER_URL/api/refresh\",{method:\"POST\"}); if(!r.ok) process.exit(1); const o=await r.json(); const p=(o.peers??[]).find((x)=>x.deviceName===\"$PEER_NAME\"); const resource=p?.resources?.find((x)=>x.id===\"$RESOURCE_ID\"); const status=p?.resourceStatuses?.[\"$RESOURCE_ID\"]; if(p?.status!==\"online\" || !Number.isInteger(p.lastSeen) || p.lastSeen<=${minimum_seen} || resource?.statusRunnerId!==\"$RUNNER_ID\" || status?.state!==\"ready\" || status?.workspace?.workspaceRevision!==\"$REVIEWED_COMMIT\") process.exit(1); process.stdout.write(\"ok\\n\")'" \
          >/dev/null 2>/dev/null
        printf '%s\n' "$seen"
        return 0
      fi
    fi
    /bin/sleep 2
  done
  return 1
}

controller_reconnect() {
  local minimum_seen="$1" attempt snapshot status seen
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if snapshot="$(controller_snapshot 2>/dev/null)"; then
      status="${snapshot%% *}"; seen="${snapshot##* }"
      if [[ "$status" == online && "$seen" =~ ^[0-9]+$ ]] && (( seen > minimum_seen )); then
        printf '%s\n' "$seen"
        return 0
      fi
    fi
    /bin/sleep 2
  done
  return 1
}

atomic_mesh_replace() {
  local temporary="$MESH_CONFIG.stage2.$$"
  [[ "$(sha256_file "$CANDIDATE_CONFIG")" == "$EXPECTED_CANDIDATE_MESH_SHA256" ]] || return 1
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  /bin/cp -p "$CANDIDATE_CONFIG" "$temporary"
  /bin/chmod 0600 "$temporary"
  if [[ "$(sha256_file "$temporary")" != "$EXPECTED_CANDIDATE_MESH_SHA256" ]]; then
    /bin/rm -f "$temporary"
    return 1
  fi
  /bin/mv -f "$temporary" "$MESH_CONFIG"
}

atomic_mesh_restore() {
  local temporary="$MESH_CONFIG.rollback.$$"
  /bin/cp -p "$backup_mesh" "$temporary"
  /bin/chmod 0600 "$temporary"
  /bin/mv -f "$temporary" "$MESH_CONFIG"
}

atomic_link_switch() {
  local target="$1" temporary="$CURRENT.stage2.$$"
  /bin/ln -s "$target" "$temporary"
  /bin/mv -f "$temporary" "$CURRENT"
}

rollback() {
  local rc=$? rollback_seen rollback_pid
  trap - ERR INT TERM
  set +e
  if (( activation_attempted )); then
    atomic_mesh_restore
    atomic_link_switch "$OLD_RELEASE"
    /bin/launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1
    rollback_pid="$(verify_process && watcher_pid || true)"
    rollback_seen="$(controller_reconnect "$baseline_last_seen" 2>/dev/null || true)"
    if [[ "$(/usr/bin/readlink "$CURRENT")" == "$OLD_RELEASE" && -n "$rollback_pid" && -n "$rollback_seen" ]]; then
      printf 'ROLLED_BACK old_release=%s pid=%s lastSeen=%s backup_sha256=%s\n' "$OLD_RELEASE" "$rollback_pid" "$rollback_seen" "$(sha256_file "$backup_mesh")"
    else
      printf 'BLOCKED rollback_verification_failed old_release=%s pid=%s lastSeen=%s\n' "$OLD_RELEASE" "$rollback_pid" "$rollback_seen" >&2
      rc=70
    fi
  fi
  exit "$rc"
}
trap rollback ERR INT TERM

path_argument_is_persistent "$BASE" || fail_precondition base_path
base_canonical="$(canonical_dir "$BASE" 2>/dev/null || true)"
[[ -n "$base_canonical" && "$base_canonical" != "/tmp" && "$base_canonical" != "/private/tmp" \
  && "$base_canonical" != /tmp/* && "$base_canonical" != /private/tmp/* ]] || fail_precondition base_path
path_argument_is_persistent "$CURRENT" || fail_precondition current_path
path_argument_is_persistent "$MESH_CONFIG" || fail_precondition live_mesh_path
path_argument_is_persistent "$BACKUP_ROOT" || fail_precondition backup_path
path_argument_is_persistent "$REPO_ROOT" || fail_precondition repository_path
path_argument_is_persistent "$BUN" || fail_precondition runtime_path
[[ "$CURRENT" == "$BASE/current" ]] || fail_precondition current_path
[[ "$MESH_CONFIG" == "$BASE/state/mesh.json" ]] || fail_precondition live_mesh_path
[[ "$BACKUP_ROOT" == "$BASE/activation/backups/"* ]] || fail_precondition backup_path
[[ "$(/usr/bin/basename -- "$BACKUP_ROOT")" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || fail_precondition backup_path
[[ ! -L "$BASE/activation" && ! -L "$BASE/activation/backups" && ! -L "$BACKUP_ROOT" ]] || fail_precondition backup_path
path_argument_is_persistent "$OLD_RELEASE" || fail_precondition expected_old_release_path
path_argument_is_persistent "$CANDIDATE_RELEASE" || fail_precondition candidate_release_path
path_argument_is_persistent "$CANDIDATE_CONFIG" || fail_precondition candidate_config_path
old_release_canonical="$(canonical_release "$OLD_RELEASE" 2>/dev/null || true)"
candidate_release_canonical="$(canonical_release "$CANDIDATE_RELEASE" 2>/dev/null || true)"
candidate_config_canonical="$(canonical_file "$CANDIDATE_CONFIG" 2>/dev/null || true)"
live_mesh_canonical="$(canonical_file "$MESH_CONFIG" 2>/dev/null || true)"
[[ -n "$old_release_canonical" && -n "$candidate_release_canonical" && -n "$candidate_config_canonical" && -n "$live_mesh_canonical" ]] || fail_precondition candidate_paths
current_parent_canonical="$(canonical_dir "$(/usr/bin/dirname -- "$CURRENT")" 2>/dev/null || true)"
[[ "$(/usr/bin/basename -- "$CURRENT")" == current && "$current_parent_canonical" == "$base_canonical" ]] || fail_precondition current_path
path_is_under "$base_canonical/releases" "$old_release_canonical" || fail_precondition expected_old_release_path
path_is_under "$base_canonical/releases" "$candidate_release_canonical" || fail_precondition candidate_release_path
path_is_under "$base_canonical/prepared" "$candidate_config_canonical" || fail_precondition candidate_config_path
[[ "$(/usr/bin/basename -- "$CANDIDATE_CONFIG")" == mesh.json ]] || fail_precondition candidate_config_path
[[ "$live_mesh_canonical" == "$base_canonical/state/mesh.json" ]] || fail_precondition live_mesh_path
[[ "$candidate_release_canonical" != "$old_release_canonical" ]] || fail_precondition candidate_release_identity
[[ "$candidate_config_canonical" != "$live_mesh_canonical" ]] || fail_precondition candidate_live_path
[[ "$EXPECTED_LIVE_MESH_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail_precondition expected_live_mesh_sha256
[[ "$EXPECTED_CANDIDATE_MESH_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail_precondition expected_candidate_mesh_sha256
[[ "$REVIEWED_COMMIT" =~ ^[a-f0-9]{40,64}$ ]] || fail_precondition reviewed_commit
controller_inputs_are_safe || fail_precondition controller_inputs
[[ -d "$REPO_ROOT" ]] || fail_precondition repository
[[ "$(/usr/bin/git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)" == "$REVIEWED_COMMIT" ]] || fail_precondition reviewed_commit
[[ -z "$(/usr/bin/git -C "$REPO_ROOT" status --porcelain --untracked-files=all 2>/dev/null)" ]] || fail_precondition worktree_clean
[[ -L "$CURRENT" ]] || fail_precondition current_release
current_target="$(/usr/bin/readlink "$CURRENT" 2>/dev/null || true)"
if [[ "$current_target" != /* ]]; then current_target="$(/usr/bin/dirname -- "$CURRENT")/$current_target"; fi
current_target_canonical="$(canonical_release "$current_target" 2>/dev/null || true)"
[[ "$current_target_canonical" == "$old_release_canonical" ]] || fail_precondition current_release
[[ -f "$MESH_CONFIG" && "$(sha256_file "$MESH_CONFIG")" == "$EXPECTED_LIVE_MESH_SHA256" ]] || fail_precondition live_mesh_sha256
[[ -x "$BUN" && -d "$CANDIDATE_RELEASE" ]] || fail_precondition candidate_release
verify_candidate_manifest || fail_precondition candidate_manifest
verify_candidate_config || fail_precondition candidate_config
watcher_running || fail_precondition watcher_running

snapshot="$(controller_snapshot 2>/dev/null)" || fail_precondition controller_snapshot
baseline_last_seen="${snapshot##* }"
[[ "$snapshot" == online\ * && "$baseline_last_seen" =~ ^[0-9]+$ ]] || fail_precondition controller_peer_online

/bin/mkdir -p "$BACKUP_ROOT"
/bin/chmod 0700 "$BACKUP_ROOT"
backup_mesh="$BACKUP_ROOT/mesh.json.before.$$.bak"
backup_canonical="$(canonical_dir "$BACKUP_ROOT" 2>/dev/null || true)"
path_is_under "$base_canonical/activation/backups" "$backup_canonical" || fail_precondition backup_path
[[ "$(/usr/bin/stat -f '%Lp' "$BACKUP_ROOT" 2>/dev/null || true)" == 700 ]] || fail_precondition backup_directory_mode
/bin/cp -p "$MESH_CONFIG" "$backup_mesh"
/bin/chmod 0600 "$backup_mesh"
[[ "$(sha256_file "$backup_mesh")" == "$EXPECTED_LIVE_MESH_SHA256" ]] || fail_precondition mesh_backup

activation_attempted=1
atomic_link_switch "$CANDIDATE_RELEASE"
atomic_mesh_replace
/bin/launchctl kickstart -k "$DOMAIN/$LABEL"

[[ "$(/usr/bin/readlink "$CURRENT")" == "$CANDIDATE_RELEASE" ]] || exit 1
verify_process || exit 1
reconnected_at="$(controller_verify "$baseline_last_seen")"

trap - ERR INT TERM
printf 'READY_FOR_COMMANDER_CANARY old_release=%s candidate_release=%s pid=%s lastSeen=%s mesh_backup=%s mesh_backup_sha256=%s\n' \
  "$OLD_RELEASE" "$CANDIDATE_RELEASE" "$(watcher_pid)" "$reconnected_at" "$backup_mesh" "$(sha256_file "$backup_mesh")"
