#!/bin/bash
# Rollback-safe activation of one immutable KMac watcher release.
set -Eeuo pipefail

readonly BASE="${AGENTLINK_INSTALL_ROOT:-$HOME/Library/Application Support/AgentLink}"
readonly CURRENT="${ARGUS_CURRENT_LINK:-$BASE/current}"
readonly MESH_CONFIG="${ARGUS_MESH_CONFIG:-$BASE/state/mesh.json}"
readonly OLD_RELEASE="${ARGUS_EXPECTED_OLD_RELEASE:-$BASE/releases/20260828-221519-unattended-reclaim}"
readonly CANDIDATE_RELEASE="${ARGUS_CANDIDATE_RELEASE:?ARGUS_CANDIDATE_RELEASE is required}"
readonly CANDIDATE_CONFIG="${ARGUS_CANDIDATE_CONFIG:?ARGUS_CANDIDATE_CONFIG is required}"
readonly REVIEWED_COMMIT="${ARGUS_REVIEWED_COMMIT:?ARGUS_REVIEWED_COMMIT is required}"
readonly REPO_ROOT="${ARGUS_REPO_ROOT:-$(CDPATH= cd -P -- "$(dirname -- "$0")/../.." && pwd -P)}"
readonly BUN="${ARGUS_RUNTIME_BUN:-$BASE/runtime/bun-1.3.14/bin/bun}"
readonly LABEL="com.kairong.agentlink-watch"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly BACKUP_ROOT="${ARGUS_ACTIVATION_BACKUP_ROOT:-$BASE/activation/backups/stage2-20260830}"
readonly CONTROLLER_URL="${ARGUS_CONTROLLER_URL:-http://127.0.0.1:8790}"
readonly PEER_NAME="${ARGUS_PEER_NAME:-k Mac}"
readonly RESOURCE_ID="workspace:kmac-m4"
readonly RUNNER_ID="kmac-status-v1"
readonly EXPECTED_MESH_SHA256="b44c335294c4df0aaff0e8c1b8be418859fddf364f0f0ebe8befb1766339943f"

activation_attempted=0
baseline_last_seen=0
backup_mesh=""

sha256_file() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
fail_precondition() { printf 'BLOCKED gate=%s\n' "$1" >&2; exit 65; }

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
  "$BUN" run "$CANDIDATE_RELEASE/scripts/release-manifest.ts" verify --release "$CANDIDATE_RELEASE" >/dev/null
}

verify_candidate_config() {
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$CANDIDATE_CONFIG" 2>/dev/null || true)"
  [[ "$mode" == 600 ]] || return 1
  CONFIG="$CANDIDATE_CONFIG" RELEASE="$CANDIDATE_RELEASE" "$BUN" -e '
    const config = JSON.parse(await Bun.file(process.env.CONFIG).text());
    const { parseMeshConfig } = await import(`${process.env.RELEASE}/packages/daemon/src/mesh/config.ts`);
    const parsed = parseMeshConfig(config);
    const resource = parsed.resources.find((entry) => entry.id === "workspace:kmac-m4");
    const runner = parsed.runners?.find((entry) => entry.id === "kmac-status-v1");
    if (resource?.statusRunnerId !== "kmac-status-v1"
      || runner?.resourceId !== "workspace:kmac-m4"
      || runner?.purpose !== "status"
      || runner?.approvalRequired !== false
      || runner?.allowDynamicArgs !== false
      || runner?.allowInput !== false
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
  /bin/cp -p "$CANDIDATE_CONFIG" "$temporary"
  /bin/chmod 0600 "$temporary"
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

[[ "$REVIEWED_COMMIT" =~ ^[a-f0-9]{40,64}$ ]] || fail_precondition reviewed_commit
[[ -d "$REPO_ROOT" ]] || fail_precondition repository
[[ "$(/usr/bin/git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)" == "$REVIEWED_COMMIT" ]] || fail_precondition reviewed_commit
[[ -z "$(/usr/bin/git -C "$REPO_ROOT" status --porcelain --untracked-files=all 2>/dev/null)" ]] || fail_precondition worktree_clean
[[ -L "$CURRENT" && "$(/usr/bin/readlink "$CURRENT")" == "$OLD_RELEASE" ]] || fail_precondition current_release
[[ -f "$MESH_CONFIG" && "$(sha256_file "$MESH_CONFIG")" == "$EXPECTED_MESH_SHA256" ]] || fail_precondition live_mesh_sha256
[[ -x "$BUN" && -d "$CANDIDATE_RELEASE" ]] || fail_precondition candidate_release
verify_candidate_manifest || fail_precondition candidate_manifest
verify_candidate_config || fail_precondition candidate_config
watcher_running || fail_precondition watcher_running
[[ -f "$CANDIDATE_CONFIG" ]] || fail_precondition candidate_config
[[ "$(/usr/bin/readlink "$CURRENT")" != "$CANDIDATE_RELEASE" ]] || fail_precondition current_release

snapshot="$(controller_snapshot 2>/dev/null)" || fail_precondition controller_snapshot
baseline_last_seen="${snapshot##* }"
[[ "$snapshot" == online\ * && "$baseline_last_seen" =~ ^[0-9]+$ ]] || fail_precondition controller_peer_online

/bin/mkdir -p "$BACKUP_ROOT"
/bin/chmod 0700 "$BACKUP_ROOT"
backup_mesh="$BACKUP_ROOT/mesh.json.before.$$.bak"
/bin/cp -p "$MESH_CONFIG" "$backup_mesh"
/bin/chmod 0600 "$backup_mesh"
[[ "$(sha256_file "$backup_mesh")" == "$EXPECTED_MESH_SHA256" ]] || fail_precondition mesh_backup

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
