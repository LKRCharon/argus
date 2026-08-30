#!/bin/bash
# Detached one-shot worker. Its argv is fixed by the dispatcher.
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
readonly HANDOFF="$SCRIPT_DIR/handoff-kmac-reverse-tunnel.sh"
readonly HOME_DIR="${HOME:-}"
readonly BASE="${AGENTLINK_INSTALL_ROOT:-${HOME_DIR}/Library/Application Support/AgentLink}"
readonly HANDOFF_ROOT="$BASE/activation/handoff"
readonly RESULT_PATH="${ARGUS_HANDOFF_RESULT_PATH:-}"
readonly WORKER_BLOCK_REASON="worker_handoff_preflight"

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
  [[ "$(CDPATH= cd -P -- "$parent" && pwd -P)" == "$SCRIPT_DIR" ]]
}

result_path_is_safe() {
  local base_canonical handoff_canonical result_parent result_parent_canonical name
  path_argument_is_persistent "$BASE" || return 1
  path_argument_is_persistent "$RESULT_PATH" || return 1
  [[ "${#RESULT_PATH}" -le 4096 ]] || return 1
  [[ "$RESULT_PATH" != *"/../"* && "$RESULT_PATH" != */.. ]] || return 1
  [[ -n "$HOME_DIR" && -d "$BASE" && -d "$HANDOFF_ROOT" ]] || return 1
  base_canonical="$(canonical_dir "$BASE")" || return 1
  [[ "$base_canonical" != /tmp && "$base_canonical" != /private/tmp \
    && "$base_canonical" != /tmp/* && "$base_canonical" != /private/tmp/* ]] || return 1
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

write_blocked_result() {
  local current_status dispatch_id now temporary
  result_path_is_safe || return 1
  current_status="$(/usr/bin/head -c 128 "$RESULT_PATH" 2>/dev/null | /usr/bin/sed -n '1p')" || return 1
  case "$current_status" in
    status=STARTED) ;;
    status=BLOCKED|status=REVERSE_TUNNEL_HANDOFF_OK|status=ROLLED_BACK) return 0 ;;
    *) return 1 ;;
  esac
  dispatch_id="$(/usr/bin/basename -- "$RESULT_PATH" .result)"
  now="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  temporary="$RESULT_PATH.tmp.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  {
    /usr/bin/printf 'status=BLOCKED\n'
    /usr/bin/printf 'dispatch_id=%s\n' "$dispatch_id"
    /usr/bin/printf 'updated_at=%s\n' "$now"
    /usr/bin/printf 'detail=%s\n' "$WORKER_BLOCK_REASON"
    /usr/bin/printf 'child_pid=%s\n' "$$"
  } > "$temporary" || return 1
  /bin/chmod 0600 "$temporary" || return 1
  /bin/mv -f "$temporary" "$RESULT_PATH"
}

block_worker() {
  write_blocked_result || true
  exit 65
}

[[ "$#" -eq 0 ]] || exit 64
fixed_file_is_ready "$HANDOFF" || block_worker
/bin/sleep 3
fixed_file_is_ready "$HANDOFF" || block_worker
exec /bin/bash "$HANDOFF" || block_worker
