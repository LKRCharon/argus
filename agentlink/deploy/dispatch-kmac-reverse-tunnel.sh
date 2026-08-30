#!/bin/bash
# Start the destructive reverse-tunnel handoff outside the caller's SSH
# session. The dispatcher accepts no command or positional arguments.
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
readonly HOME_DIR="${HOME:-}"
readonly BASE="${AGENTLINK_INSTALL_ROOT:-${HOME_DIR}/Library/Application Support/AgentLink}"
readonly HANDOFF_ROOT="$BASE/activation/handoff"
readonly RESULT_DIR="$HANDOFF_ROOT/results"
readonly WORKER="$SCRIPT_DIR/run-kmac-reverse-tunnel-handoff.sh"
readonly HANDOFF="$SCRIPT_DIR/handoff-kmac-reverse-tunnel.sh"
readonly EXPECTED_WORKER_COMMAND="/bin/bash $WORKER"
readonly EXPECTED_PID="${ARGUS_EXPECTED_MANUAL_SSH_PID:-}"
readonly EXPECTED_PLIST_SHA256="${ARGUS_EXPECTED_REVERSE_PLIST_SHA256:-}"
readonly NEVER_TERMINATE_PID="97171"
readonly BACKUP_ROOT="${ARGUS_REVERSE_BACKUP_ROOT:-${HOME_DIR}/.argus-backups/argus-infra-stage2-20260830}"

DISPATCH_ID=""
RESULT_PATH=""
child_pid=""
result_ready=0
failure_reason=""

blocked() {
  /usr/bin/printf 'BLOCKED gate=%s\n' "$1" >&2
  exit 65
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

fixed_file_is_ready() {
  local file="$1" parent
  [[ -f "$file" && ! -L "$file" && -x "$file" ]] || return 1
  parent="$(/usr/bin/dirname -- "$file")"
  [[ "$(canonical_dir "$parent")" == "$SCRIPT_DIR" ]]
}

write_result() {
  local state="$1" detail="${2:-}" pid="${3:-}" temporary now current_status
  [[ "$result_ready" == 1 ]] || return 1
  case "$state" in
    STARTED|BLOCKED) ;;
    *) return 1 ;;
  esac
  if [[ -e "$RESULT_PATH" || -L "$RESULT_PATH" ]]; then
    [[ -f "$RESULT_PATH" && ! -L "$RESULT_PATH" ]] || return 1
    current_status="$(/usr/bin/head -c 128 "$RESULT_PATH" 2>/dev/null | /usr/bin/sed -n '1p')" || return 1
    [[ "$current_status" == status=STARTED ]] || return 1
  fi
  [[ -z "$detail" || "$detail" =~ ^[A-Za-z0-9_.=-]{1,96}$ ]] || detail=unspecified
  [[ -z "$pid" || "$pid" =~ ^[0-9]+$ ]] || pid=unknown
  now="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  temporary="$RESULT_PATH.tmp.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  {
    /usr/bin/printf 'status=%s\n' "$state"
    /usr/bin/printf 'dispatch_id=%s\n' "$DISPATCH_ID"
    /usr/bin/printf 'updated_at=%s\n' "$now"
    [[ -z "$detail" ]] || /usr/bin/printf 'detail=%s\n' "$detail"
    [[ -z "$pid" ]] || /usr/bin/printf 'child_pid=%s\n' "$pid"
  } > "$temporary" || return 1
  /bin/chmod 0600 "$temporary" || return 1
  /bin/mv -f "$temporary" "$RESULT_PATH"
}

child_command() {
  /bin/ps -p "$1" -o command= 2>/dev/null \
    | /usr/bin/sed -e 's/^[[:space:]]*//' | /usr/bin/head -c 4096
}

child_is_expected() {
  local command
  [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$child_pid" != "$EXPECTED_PID" ]] || return 1
  [[ "$child_pid" != "$NEVER_TERMINATE_PID" ]] || return 1
  /bin/kill -0 "$child_pid" 2>/dev/null || return 1
  command="$(child_command "$child_pid")"
  [[ "${#command}" -le 4096 && "$command" == "$EXPECTED_WORKER_COMMAND" ]]
}

terminate_verified_child() {
  local attempt
  if child_is_expected; then
    /bin/kill -TERM "$child_pid" 2>/dev/null || true
    for ((attempt = 1; attempt <= 5; attempt += 1)); do
      child_is_expected || return 0
      /bin/sleep 0.2
    done
    child_is_expected && /bin/kill -KILL "$child_pid" 2>/dev/null || true
  fi
}

dispatcher_failure() {
  local rc="${1:-$?}" reason
  trap - ERR INT TERM
  set +e
  [[ "$rc" =~ ^[1-9][0-9]*$ ]] || rc=70
  reason="${failure_reason:-early_start_failure}"
  terminate_verified_child
  if (( result_ready )); then
    write_result BLOCKED "$reason" "$child_pid" || true
  fi
  /usr/bin/printf 'BLOCKED gate=%s\n' "$reason" >&2
  exit "$rc"
}

wait_for_worker_start() {
  local attempt
  for ((attempt = 1; attempt <= 10; attempt += 1)); do
    if child_is_expected; then
      return 0
    fi
    /bin/sleep 0.2
  done
  return 1
}

[[ "$#" -eq 0 ]] || blocked arguments_not_allowed
[[ -n "$HOME_DIR" ]] || blocked home
[[ "$EXPECTED_PID" =~ ^[1-9][0-9]*$ ]] || blocked manual_pid
[[ "$EXPECTED_PLIST_SHA256" =~ ^[a-f0-9]{64}$ ]] || blocked reverse_plist_sha256
path_argument_is_persistent "$BASE" || blocked base_path
path_argument_is_persistent "$HANDOFF_ROOT" || blocked result_path
path_argument_is_persistent "$RESULT_DIR" || blocked result_path
path_argument_is_persistent "$BACKUP_ROOT" || blocked rollback_backup_path
[[ "$BACKUP_ROOT" == "$HOME_DIR/.argus-backups/argus-infra-stage2-20260830" \
  || "$BACKUP_ROOT" == "$BASE/activation/handoff/backups" ]] || blocked rollback_backup_path
fixed_file_is_ready "$WORKER" || blocked worker_unavailable
fixed_file_is_ready "$HANDOFF" || blocked handoff_unavailable
[[ ! -L "$BASE/activation" && ! -L "$HANDOFF_ROOT" && ! -L "$RESULT_DIR" ]] || blocked result_path

/bin/mkdir -p "$RESULT_DIR" || blocked result_directory
base_canonical="$(canonical_dir "$BASE" 2>/dev/null || true)"
handoff_canonical="$(canonical_dir "$HANDOFF_ROOT" 2>/dev/null || true)"
result_canonical="$(canonical_dir "$RESULT_DIR" 2>/dev/null || true)"
[[ -n "$base_canonical" && "$base_canonical" != /tmp && "$base_canonical" != /private/tmp \
  && "$base_canonical" != /tmp/* && "$base_canonical" != /private/tmp/* ]] || blocked base_path
[[ "$handoff_canonical" == "$base_canonical/activation/handoff" ]] || blocked handoff_path
[[ "$result_canonical" == "$handoff_canonical/results" ]] || blocked result_path
/bin/chmod 0700 "$RESULT_DIR"
[[ "$(/usr/bin/stat -f '%Lp' "$RESULT_DIR" 2>/dev/null || true)" == 700 ]] || blocked result_directory_mode

DISPATCH_ID="handoff-$(/bin/date -u '+%Y%m%dT%H%M%SZ')-$$"
[[ "$DISPATCH_ID" =~ ^handoff-[A-Za-z0-9._-]{1,80}$ ]] || blocked dispatch_id
RESULT_PATH="$RESULT_DIR/$DISPATCH_ID.result"
[[ ! -e "$RESULT_PATH" && ! -L "$RESULT_PATH" ]] || blocked result_exists
[[ "${#RESULT_PATH}" -le 4096 ]] || blocked result_path_length

# From this point on every failure has a durable terminal result.
result_ready=1
trap dispatcher_failure ERR
trap 'dispatcher_failure 130' INT
trap 'dispatcher_failure 143' TERM
write_result STARTED dispatched

# Keep the child independent of the SSH session and discard all inherited
# environment except the audited, fixed handoff inputs.
/usr/bin/nohup /usr/bin/env -i \
  BASH_ENV=/dev/null \
  HOME="$HOME_DIR" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  AGENTLINK_INSTALL_ROOT="$BASE" \
  ARGUS_REVERSE_BACKUP_ROOT="$BACKUP_ROOT" \
  ARGUS_EXPECTED_MANUAL_SSH_PID="$EXPECTED_PID" \
  ARGUS_EXPECTED_REVERSE_PLIST_SHA256="$EXPECTED_PLIST_SHA256" \
  ARGUS_HANDOFF_RESULT_PATH="$RESULT_PATH" \
  /bin/bash "$WORKER" </dev/null >/dev/null 2>&1 &
child_pid="$!"
[[ "$child_pid" =~ ^[0-9]+$ ]] || { failure_reason=child_pid; dispatcher_failure 70; }

failure_reason=startup_proof_failed
wait_for_worker_start || dispatcher_failure 70
failure_reason=worker_exited_before_dispatch
child_is_expected || dispatcher_failure 70

trap - ERR INT TERM
/usr/bin/printf 'DISPATCHED dispatch_id=%s result_path=%s child_pid=%s\n' \
  "$DISPATCH_ID" "$RESULT_PATH" "$child_pid"
