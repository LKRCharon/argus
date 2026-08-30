#!/bin/bash
# Passive LaunchAgent handoff. Existing reverse SSH processes are untouched.
set -Eeuo pipefail

readonly SOURCE="${ARGUS_REVERSE_PLIST_SOURCE:-$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)/com.kairong.agentlink-seoul-reverse-tunnel.plist}"
readonly TARGET="${ARGUS_REVERSE_PLIST_TARGET:-$HOME/Library/LaunchAgents/com.kairong.agentlink-seoul-reverse-tunnel.plist}"
readonly LABEL="com.kairong.agentlink-seoul-reverse-tunnel"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly BACKUP_ROOT="${ARGUS_REVERSE_BACKUP_ROOT:-$HOME/.argus-backups/argus-infra-stage2-20260830}"

[[ -f "$SOURCE" ]] || { printf 'BLOCKED source_missing\n' >&2; exit 65; }
/usr/bin/plutil -lint "$SOURCE" >/dev/null
/bin/mkdir -p "$(/usr/bin/dirname "$TARGET")" "$BACKUP_ROOT"
/bin/chmod 0700 "$BACKUP_ROOT"
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  backup="$BACKUP_ROOT/reverse-tunnel-plist.before"
  if [[ ! -e "$backup" ]]; then /bin/cp -p "$TARGET" "$backup"; fi
fi
temporary="$TARGET.stage2.$$"
/bin/cp -p "$SOURCE" "$temporary"
/bin/chmod 0600 "$temporary"
/bin/mv -f "$temporary" "$TARGET"
/usr/bin/plutil -lint "$TARGET" >/dev/null
/bin/launchctl bootstrap "$DOMAIN" "$TARGET" >/dev/null 2>&1 || {
  /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { printf 'BLOCKED launchagent_load_failed\n' >&2; exit 66; }
}
/bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { printf 'BLOCKED launchagent_not_loaded\n' >&2; exit 66; }
printf 'PASSIVE_REVERSE_TUNNEL_LOADED label=%s plist_sha256=%s existing_manual_pid_untouched=yes\n' \
  "$LABEL" "$(/usr/bin/shasum -a 256 "$TARGET" | /usr/bin/awk '{print $1}')"
