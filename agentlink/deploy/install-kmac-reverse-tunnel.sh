#!/bin/bash
# Passive LaunchAgent handoff. Existing reverse SSH processes are untouched.
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
readonly HOME_DIR="${HOME:-}"
readonly SOURCE="${ARGUS_REVERSE_PLIST_SOURCE:-$SCRIPT_DIR/com.kairong.agentlink-seoul-reverse-tunnel.plist}"
readonly TARGET="${ARGUS_REVERSE_PLIST_TARGET:-$HOME_DIR/Library/LaunchAgents/com.kairong.agentlink-seoul-reverse-tunnel.plist}"
readonly LABEL="com.kairong.agentlink-seoul-reverse-tunnel"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly BASE="${AGENTLINK_INSTALL_ROOT:-$HOME_DIR/Library/Application Support/AgentLink}"
readonly BACKUP_ROOT="${ARGUS_REVERSE_BACKUP_ROOT:-$HOME_DIR/.argus-backups/argus-infra-stage2-20260830}"
readonly PREVIOUS_PLIST="$BACKUP_ROOT/reverse-tunnel-plist.before"
readonly ABSENT_MARKER="$BACKUP_ROOT/reverse-tunnel-plist.absent"

path_argument_is_persistent() {
  local value="$1"
  [[ "${#value}" -le 4096 && "$value" == /* && "$value" != "/tmp" && "$value" != "/private/tmp" \
    && "$value" != /tmp/* && "$value" != /private/tmp/* \
    && "$value" != *$'\n'* && "$value" != *$'\r'* \
    && "$value" != *"/../"* && "$value" != */.. ]]
}

[[ -n "$HOME_DIR" ]] || { printf 'BLOCKED home\n' >&2; exit 65; }
path_argument_is_persistent "$SOURCE" || { printf 'BLOCKED source_path\n' >&2; exit 65; }
[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || { printf 'BLOCKED source_missing\n' >&2; exit 65; }
[[ "$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$SOURCE")" && pwd -P)" == "$SCRIPT_DIR" ]] || {
  printf 'BLOCKED source_path\n' >&2
  exit 65
}
[[ "$(/usr/bin/basename -- "$SOURCE")" == "$LABEL.plist" ]] || {
  printf 'BLOCKED source_path\n' >&2
  exit 65
}
/usr/bin/plutil -lint "$SOURCE" >/dev/null
path_argument_is_persistent "$BASE" || { printf 'BLOCKED base_path\n' >&2; exit 65; }
path_argument_is_persistent "$BACKUP_ROOT" || { printf 'BLOCKED backup_path\n' >&2; exit 65; }
path_argument_is_persistent "$TARGET" || { printf 'BLOCKED target_path\n' >&2; exit 65; }
[[ "$(/usr/bin/basename -- "$TARGET")" == "$LABEL.plist" ]] || {
  printf 'BLOCKED target_label_path\n' >&2
  exit 65
}
target_parent="$(/usr/bin/dirname -- "$TARGET")"
expected_target_parent="$HOME_DIR/Library/LaunchAgents"
[[ "$target_parent" == "$expected_target_parent" ]] || {
  printf 'BLOCKED target_parent\n' >&2
  exit 65
}
backup_parent="$(/usr/bin/dirname -- "$BACKUP_ROOT")"
[[ ! -L "$BASE" && ! -L "$BASE/activation" && ! -L "$BASE/activation/handoff" \
  && ! -L "$backup_parent" && ! -L "$BACKUP_ROOT" && ! -L "$target_parent" ]] || {
  printf 'BLOCKED symlink_path\n' >&2
  exit 65
}
base_canonical="$(CDPATH= cd -P -- "$BASE" 2>/dev/null && pwd -P || true)"
[[ -n "$base_canonical" && "$base_canonical" != /tmp && "$base_canonical" != /private/tmp \
  && "$base_canonical" != /tmp/* && "$base_canonical" != /private/tmp/* ]] || {
  printf 'BLOCKED base_path\n' >&2
  exit 65
}
/bin/mkdir -p "$BASE/activation/handoff" || {
  printf 'BLOCKED activation_directory\n' >&2
  exit 65
}
/bin/mkdir -p "$target_parent" || {
  printf 'BLOCKED target_parent\n' >&2
  exit 65
}
[[ -d "$target_parent" && -d "$expected_target_parent" ]] || {
  printf 'BLOCKED target_parent\n' >&2
  exit 65
}
[[ "$(CDPATH= cd -P -- "$target_parent" && pwd -P)" == "$(CDPATH= cd -P -- "$expected_target_parent" && pwd -P)" ]] || {
  printf 'BLOCKED target_parent\n' >&2
  exit 65
}
/bin/mkdir -p "$(/usr/bin/dirname "$TARGET")" "$BACKUP_ROOT" || {
  printf 'BLOCKED backup_directory\n' >&2
  exit 65
}
/bin/chmod 0700 "$BACKUP_ROOT"
[[ "$(/usr/bin/stat -f '%Lp' "$BACKUP_ROOT" 2>/dev/null || true)" == 700 ]] || {
  printf 'BLOCKED backup_directory_mode\n' >&2
  exit 65
}
handoff_canonical="$(CDPATH= cd -P -- "$BASE/activation/handoff" && pwd -P)"
backup_parent="$(/usr/bin/dirname -- "$BACKUP_ROOT")"
backup_parent_canonical="$(CDPATH= cd -P -- "$backup_parent" && pwd -P)"
backup_canonical="$(CDPATH= cd -P -- "$BACKUP_ROOT" && pwd -P)"
backup_allowed=0
if [[ "$backup_parent_canonical" == "$HOME/.argus-backups" \
  && "$backup_canonical" == "$backup_parent_canonical/argus-infra-stage2-20260830" ]] \
  || [[ "$backup_canonical" == "$handoff_canonical/backups" ]]; then
  backup_allowed=1
fi
[[ "$base_canonical" != /tmp && "$base_canonical" != /private/tmp \
  && "$base_canonical" != /tmp/* && "$base_canonical" != /private/tmp/* \
  && "$handoff_canonical" == "$base_canonical/activation/handoff" \
  && "$backup_allowed" == 1 ]] || {
  printf 'BLOCKED backup_path\n' >&2
  exit 65
}
if [[ -e "$PREVIOUS_PLIST" && -e "$ABSENT_MARKER" ]]; then
  printf 'BLOCKED backup_state_conflict\n' >&2
  exit 65
fi
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ -f "$TARGET" && ! -L "$TARGET" ]] || {
    printf 'BLOCKED target_not_regular\n' >&2
    exit 65
  }
  if [[ ! -e "$PREVIOUS_PLIST" && ! -e "$ABSENT_MARKER" ]]; then
    /bin/cp -p "$TARGET" "$PREVIOUS_PLIST"
    /bin/chmod 0600 "$PREVIOUS_PLIST"
  fi
else
  if [[ ! -e "$PREVIOUS_PLIST" && ! -e "$ABSENT_MARKER" ]]; then
    marker_temporary="$ABSENT_MARKER.stage2.$$"
    [[ ! -e "$marker_temporary" && ! -L "$marker_temporary" ]] || {
      printf 'BLOCKED marker_temporary\n' >&2
      exit 65
    }
    /usr/bin/printf 'state=target_absent\nlabel=%s\n' "$LABEL" > "$marker_temporary"
    /bin/chmod 0600 "$marker_temporary"
    /bin/mv -f "$marker_temporary" "$ABSENT_MARKER"
  fi
fi
temporary="$TARGET.stage2.$$"
[[ ! -e "$temporary" && ! -L "$temporary" ]] || {
  printf 'BLOCKED target_temporary\n' >&2
  exit 65
}
/bin/cp -p "$SOURCE" "$temporary"
/bin/chmod 0600 "$temporary"
/bin/mv -f "$temporary" "$TARGET"
/usr/bin/plutil -lint "$TARGET" >/dev/null
/bin/launchctl bootstrap "$DOMAIN" "$TARGET" >/dev/null 2>&1 || {
  /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { printf 'BLOCKED launchagent_load_failed\n' >&2; exit 66; }
}
/bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { printf 'BLOCKED launchagent_not_loaded\n' >&2; exit 66; }
backup_state=none
[[ -e "$PREVIOUS_PLIST" ]] && backup_state=previous_plist
[[ -e "$ABSENT_MARKER" ]] && backup_state=absent_marker
printf 'PASSIVE_REVERSE_TUNNEL_STAGED label=%s plist_sha256=%s backup_state=%s existing_manual_pid_untouched=yes\n' \
  "$LABEL" "$(/usr/bin/shasum -a 256 "$TARGET" | /usr/bin/awk '{print $1}')" "$backup_state"
printf 'PASSIVE_REVERSE_TUNNEL_LOADED_NOT_PROVEN label=%s tunnel_ready=no\n' "$LABEL"
