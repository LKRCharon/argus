#!/bin/bash
# Destructive handoff from the audited manual reverse SSH to one LaunchAgent.
# This file is started by dispatch-kmac-reverse-tunnel.sh, never from the
# commander's foreground SSH session.
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
readonly HOME_DIR="${HOME:-}"
readonly BASE="${AGENTLINK_INSTALL_ROOT:-${HOME_DIR}/Library/Application Support/AgentLink}"
readonly HANDOFF_ROOT="$BASE/activation/handoff"
readonly RESULT_PATH="${ARGUS_HANDOFF_RESULT_PATH:-}"
readonly LABEL="com.kairong.agentlink-seoul-reverse-tunnel"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly TARGET="${ARGUS_REVERSE_PLIST_TARGET:-${HOME_DIR}/Library/LaunchAgents/${LABEL}.plist}"
readonly BACKUP_ROOT="${ARGUS_REVERSE_BACKUP_ROOT:-$HANDOFF_ROOT/backups}"
readonly PREVIOUS_PLIST="$BACKUP_ROOT/reverse-tunnel-plist.before"
readonly ABSENT_MARKER="$BACKUP_ROOT/reverse-tunnel-plist.absent"
readonly EXPECTED_MANUAL_PID="${ARGUS_EXPECTED_MANUAL_SSH_PID:-}"
readonly EXPECTED_PLIST_SHA256="${ARGUS_EXPECTED_REVERSE_PLIST_SHA256:-}"
readonly CONTROLLER_HOST="seoul"
readonly REMOTE_FORWARD="127.0.0.1:22022:127.0.0.1:22"
readonly EXPECTED_MANUAL_COMMAND="/usr/bin/ssh -fNT -o BatchMode=yes -o ClearAllForwardings=no -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -R 127.0.0.1:22022:127.0.0.1:22 seoul"
readonly EXPECTED_LAUNCHD_COMMAND="/usr/bin/ssh -NT -o BatchMode=yes -o ClearAllForwardings=no -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -R 127.0.0.1:22022:127.0.0.1:22 seoul"

handoff_attempted=0
failure_gate=""
result_path_ready=0

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

path_argument_is_persistent() {
  local value="$1"
  [[ "${#value}" -le 4096 && "$value" == /* && "$value" != "/tmp" && "$value" != "/private/tmp" \
    && "$value" != /tmp/* && "$value" != /private/tmp/* \
    && "$value" != *$'\n'* && "$value" != *$'\r'* \
    && "$value" != *"/../"* && "$value" != */.. ]]
}

canonical_dir() {
  CDPATH= cd -P -- "$1" && pwd -P
}

fixed_target_path_is_safe() {
  local target_parent expected_parent
  [[ -n "$HOME_DIR" ]] || return 1
  path_argument_is_persistent "$TARGET" || return 1
  [[ "$(/usr/bin/basename -- "$TARGET")" == "$LABEL.plist" ]] || return 1
  target_parent="$(/usr/bin/dirname -- "$TARGET")"
  expected_parent="${HOME_DIR}/Library/LaunchAgents"
  [[ -d "$target_parent" && -d "$expected_parent" ]] || return 1
  [[ "$(canonical_dir "$target_parent")" == "$(canonical_dir "$expected_parent")" ]] || return 1
}

backup_root_is_safe() {
  local handoff_canonical backup_canonical backup_parent backup_parent_canonical
  path_argument_is_persistent "$BACKUP_ROOT" || return 1
  [[ -d "$BACKUP_ROOT" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$BACKUP_ROOT" 2>/dev/null || true)" == 700 ]] || return 1
  handoff_canonical="$(canonical_dir "$HANDOFF_ROOT")" || return 1
  backup_canonical="$(canonical_dir "$BACKUP_ROOT")" || return 1
  backup_parent="$(/usr/bin/dirname -- "$BACKUP_ROOT")"
  backup_parent_canonical="$(canonical_dir "$backup_parent")" || return 1
  [[ "$backup_canonical" == "$handoff_canonical/backups" ]] \
    || [[ "$backup_parent_canonical" == "$HOME_DIR/.argus-backups" \
      && "$backup_canonical" == "$backup_parent_canonical/argus-infra-stage2-20260830" ]]
}

result_path_is_safe() {
  local base_canonical handoff_canonical result_parent result_parent_canonical name
  path_argument_is_persistent "$BASE" || return 1
  path_argument_is_persistent "$RESULT_PATH" || return 1
  [[ "${#RESULT_PATH}" -le 4096 ]] || return 1
  [[ "$RESULT_PATH" != *"/../"* && "$RESULT_PATH" != */.. && "$RESULT_PATH" != *$'\n'* ]] || return 1
  [[ -n "$HOME_DIR" && -d "$BASE" && -d "$HANDOFF_ROOT" ]] || return 1
  base_canonical="$(canonical_dir "$BASE")" || return 1
  handoff_canonical="$(canonical_dir "$HANDOFF_ROOT")" || return 1
  [[ "$handoff_canonical" == "$base_canonical/activation/handoff" ]] || return 1
  result_parent="$(/usr/bin/dirname -- "$RESULT_PATH")"
  result_parent_canonical="$(canonical_dir "$result_parent")" || return 1
  [[ "$result_parent_canonical" == "$handoff_canonical/results" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$result_parent" 2>/dev/null || true)" == 700 ]] || return 1
  name="$(/usr/bin/basename -- "$RESULT_PATH")"
  [[ "$name" =~ ^handoff-[A-Za-z0-9._-]{1,80}\.result$ ]] || return 1
  [[ -f "$RESULT_PATH" && ! -L "$RESULT_PATH" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$RESULT_PATH" 2>/dev/null || true)" == 600 ]] || return 1
}

write_result() {
  local state="$1" detail="${2:-}" manual_pid="${3:-}" launchd_pid="${4:-}" plist_state="${5:-}" temporary now dispatch_id current_status
  [[ "$result_path_ready" == 1 ]] || return 1
  case "$state" in
    STARTED|REVERSE_TUNNEL_HANDOFF_OK|ROLLED_BACK|BLOCKED) ;;
    *) return 1 ;;
  esac
  [[ -f "$RESULT_PATH" && ! -L "$RESULT_PATH" ]] || return 1
  current_status="$(/usr/bin/head -c 128 "$RESULT_PATH" 2>/dev/null | /usr/bin/sed -n '1p')" || return 1
  [[ "$current_status" == status=STARTED ]] || return 1
  [[ -z "$detail" || "$detail" =~ ^[A-Za-z0-9_.=-]{1,96}$ ]] || detail=unspecified
  [[ -z "$manual_pid" || "$manual_pid" =~ ^[0-9]+$ ]] || manual_pid=unknown
  [[ -z "$launchd_pid" || "$launchd_pid" =~ ^[0-9]+$ ]] || launchd_pid=unknown
  [[ -z "$plist_state" || "$plist_state" =~ ^[A-Za-z0-9_.=-]{1,96}$ ]] || plist_state=unknown
  dispatch_id="$(/usr/bin/basename -- "$RESULT_PATH" .result)"
  now="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  temporary="$RESULT_PATH.tmp.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  {
    /usr/bin/printf 'status=%s\n' "$state"
    /usr/bin/printf 'dispatch_id=%s\n' "$dispatch_id"
    /usr/bin/printf 'updated_at=%s\n' "$now"
    [[ -z "$detail" ]] || /usr/bin/printf 'detail=%s\n' "$detail"
    [[ -z "$manual_pid" ]] || /usr/bin/printf 'manual_pid=%s\n' "$manual_pid"
    [[ -z "$launchd_pid" ]] || /usr/bin/printf 'launchd_pid=%s\n' "$launchd_pid"
    [[ -z "$plist_state" ]] || /usr/bin/printf 'previous_plist_state=%s\n' "$plist_state"
  } > "$temporary" || return 1
  /bin/chmod 0600 "$temporary" || return 1
  /bin/mv -f "$temporary" "$RESULT_PATH"
}

fail_precondition() {
  failure_gate="$1"
  write_result BLOCKED "$failure_gate" || true
  trap - ERR INT TERM
  /usr/bin/printf 'BLOCKED gate=%s\n' "$failure_gate" >&2
  exit 65
}

launchctl_output() {
  /bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null
}

manual_command() {
  /bin/ps -p "$1" -o command= 2>/dev/null | /usr/bin/head -c 4096
}

manual_identity_for_pid() {
  local pid="$1" command
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command="$(manual_command "$pid")"
  [[ "$command" == "$EXPECTED_MANUAL_COMMAND" ]] || return 1
}

launchd_running_pid() {
  local output pid command
  output="$(launchctl_output || true)"
  [[ "${#output}" -le 16384 ]] || return 1
  printf '%s\n' "$output" | /usr/bin/grep -Eq '^[[:space:]]*state[[:space:]]*=[[:space:]]*running[[:space:]]*$' || return 1
  pid="$(printf '%s\n' "$output" | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+$/ {print $3; exit}')"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null | /usr/bin/head -c 4096 || true)"
  [[ "$command" == "$EXPECTED_LAUNCHD_COMMAND" ]] || return 1
  printf '%s\n' "$pid"
}

seoul_tunnel_health() {
  local output
  output="$(/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=3 -o ServerAliveCountMax=1 "$CONTROLLER_HOST" \
    'set -eu; if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :22022"; else netstat -an | grep "[.:]22022[[:space:]].*LISTEN"; fi; printf "BANNER "; timeout 5 nc 127.0.0.1 22022 | head -1' 2>/dev/null || true)"
  [[ "${#output}" -le 16384 ]] || return 1
  printf '%s\n' "$output" | /usr/bin/grep -q '127\.0\.0\.1:22022'
  printf '%s\n' "$output" | /usr/bin/grep -q 'BANNER SSH-2.0-'
}

wait_for_launchd_tunnel() {
  local attempt pid
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if pid="$(launchd_running_pid 2>/dev/null)" && seoul_tunnel_health; then
      printf '%s\n' "$pid"
      return 0
    fi
    /bin/sleep 2
  done
  return 1
}

stop_manual() {
  manual_identity_for_pid "$EXPECTED_MANUAL_PID" || return 1
  /bin/kill -TERM "$EXPECTED_MANUAL_PID" 2>/dev/null || return 1
  for _ in {1..10}; do
    /bin/kill -0 "$EXPECTED_MANUAL_PID" 2>/dev/null || return 0
    /bin/sleep 1
  done
  return 1
}

restore_manual() {
  local pid
  if manual_identity_for_pid "$EXPECTED_MANUAL_PID"; then
    printf '%s\n' "$EXPECTED_MANUAL_PID"
    return 0
  fi
  /usr/bin/ssh -fNT \
    -o BatchMode=yes \
    -o ClearAllForwardings=no \
    -o ControlMaster=no \
    -o ControlPath=none \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 \
    -R "$REMOTE_FORWARD" "$CONTROLLER_HOST" >/dev/null 2>&1
  for _ in {1..15}; do
    pid="$(/bin/ps axww -o pid=,command= 2>/dev/null | /usr/bin/awk '
      $1 ~ /^[0-9]+$/ && $0 ~ /^ *[0-9]+ \/usr\/bin\/ssh -fNT -o BatchMode=yes -o ClearAllForwardings=no -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -R 127\.0\.0\.1:22022:127\.0\.0\.1:22 seoul$/ { print $1; exit }')"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      manual_identity_for_pid "$pid" && printf '%s\n' "$pid" && return 0
    fi
    /bin/sleep 1
  done
  return 1
}

restore_previous_plist() {
  local temporary
  if [[ -f "$ABSENT_MARKER" && ! -L "$ABSENT_MARKER" ]]; then
    [[ ! -e "$PREVIOUS_PLIST" && ! -L "$PREVIOUS_PLIST" ]] || return 1
    /bin/rm -f "$TARGET"
    [[ ! -e "$TARGET" && ! -L "$TARGET" ]]
    printf 'absent_marker\n'
    return
  fi
  [[ -f "$PREVIOUS_PLIST" && ! -L "$PREVIOUS_PLIST" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$PREVIOUS_PLIST" 2>/dev/null || true)" == 600 ]] || return 1
  /usr/bin/plutil -lint "$PREVIOUS_PLIST" >/dev/null || return 1
  temporary="$TARGET.rollback.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  /bin/cp -p "$PREVIOUS_PLIST" "$temporary" || return 1
  /bin/chmod 0600 "$temporary" || return 1
  /bin/mv -f "$temporary" "$TARGET" || return 1
  /usr/bin/plutil -lint "$TARGET" >/dev/null || return 1
  printf 'previous_plist\n'
}

rollback() {
  local rc=$? restored_pid rollback_plist_state
  trap - ERR INT TERM
  set +e
  if (( handoff_attempted )); then
    /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    # The previous plist is intentionally left unloaded: launch state before
    # this handoff is not provable, and a stale job could reclaim port 22022.
    rollback_plist_state="$(restore_previous_plist 2>/dev/null || true)"
    if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      rollback_plist_state=""
    fi
    restored_pid="$(restore_manual 2>/dev/null || true)"
    if [[ "$restored_pid" =~ ^[0-9]+$ && -n "$rollback_plist_state" ]] && seoul_tunnel_health; then
      write_result ROLLED_BACK manual_restored "$restored_pid" "" unloaded_not_proven || true
      /usr/bin/printf 'ROLLED_BACK manual_pid=%s launchagent=%s previous_plist=%s\n' \
        "$restored_pid" "$LABEL" "$rollback_plist_state"
    else
      write_result BLOCKED rollback_verification_failed "$restored_pid" "" unloaded_not_proven || true
      /usr/bin/printf 'BLOCKED rollback_verification_failed manual_pid=%s launchagent=%s previous_plist=%s\n' \
        "$restored_pid" "$LABEL" "$rollback_plist_state" >&2
      rc=70
    fi
  else
    write_result BLOCKED "${failure_gate:-unexpected_preflight}" || true
    /usr/bin/printf 'BLOCKED gate=%s\n' "${failure_gate:-unexpected_preflight}" >&2
  fi
  exit "$rc"
}

trap rollback ERR INT TERM

result_path_is_safe || fail_precondition result_path
result_path_ready=1
write_result STARTED handoff_started || fail_precondition result_write

[[ "$EXPECTED_MANUAL_PID" =~ ^[1-9][0-9]*$ ]] || fail_precondition manual_pid
[[ "$EXPECTED_PLIST_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail_precondition reverse_plist_sha256
fixed_target_path_is_safe || fail_precondition reverse_plist_path
backup_root_is_safe || fail_precondition rollback_backup_path
[[ -f "$TARGET" && ! -L "$TARGET" ]] || fail_precondition reverse_plist_target
[[ "$(/usr/bin/basename -- "$TARGET")" == "$LABEL.plist" ]] || fail_precondition reverse_plist_label_path
[[ "$(/usr/bin/stat -f '%Lp' "$TARGET" 2>/dev/null || true)" == 600 ]] || fail_precondition reverse_plist_mode
/usr/bin/plutil -lint "$TARGET" >/dev/null || fail_precondition reverse_plist_plutil
[[ "$(sha256_file "$TARGET")" == "$EXPECTED_PLIST_SHA256" ]] || fail_precondition reverse_plist_sha256_mismatch
launchctl_output >/dev/null || fail_precondition launchagent_loaded
[[ -f "$PREVIOUS_PLIST" || -f "$ABSENT_MARKER" ]] || fail_precondition rollback_state
[[ ! -e "$PREVIOUS_PLIST" || ! -e "$ABSENT_MARKER" ]] || fail_precondition rollback_state_conflict
if [[ -f "$PREVIOUS_PLIST" ]]; then
  [[ ! -L "$PREVIOUS_PLIST" && "$(/usr/bin/stat -f '%Lp' "$PREVIOUS_PLIST" 2>/dev/null || true)" == 600 ]] || fail_precondition rollback_backup
  /usr/bin/plutil -lint "$PREVIOUS_PLIST" >/dev/null || fail_precondition rollback_backup_plutil
else
  [[ ! -L "$ABSENT_MARKER" && "$(/usr/bin/stat -f '%Lp' "$ABSENT_MARKER" 2>/dev/null || true)" == 600 ]] || fail_precondition absent_marker
  [[ "$(/usr/bin/sed -n '1,2p' "$ABSENT_MARKER" 2>/dev/null)" == $'state=target_absent\nlabel='"$LABEL" ]] || fail_precondition absent_marker_contents
fi
manual_identity_for_pid "$EXPECTED_MANUAL_PID" || fail_precondition manual_tunnel_identity
seoul_tunnel_health || fail_precondition seoul_tunnel_health

handoff_attempted=1
stop_manual
/bin/launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1
launchd_pid="$(wait_for_launchd_tunnel)"

write_result REVERSE_TUNNEL_HANDOFF_OK handoff_complete "$EXPECTED_MANUAL_PID" "$launchd_pid" loaded
trap - ERR INT TERM
/usr/bin/printf 'REVERSE_TUNNEL_HANDOFF_OK label=%s launchd_pid=%s manual_pid_stopped=%s\n' \
  "$LABEL" "$launchd_pid" "$EXPECTED_MANUAL_PID"
