#!/usr/bin/env bash
# Start a pairing session that automatically becomes the Host bridge once the
# Android device confirms the pairing code.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOST_NAME="${1:?usage: pair-host-tmux.sh <host-name> [tmux-session]}"
SESSION="${2:-argus-pair}"

case "$HOST_NAME" in
  *[!A-Za-z0-9._-]* | "") echo "host name may only use A-Z, a-z, 0-9, ., _, -" >&2; exit 2 ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi

tmux new-session -d -s "$SESSION" "exec env ARGUS_HOST_NAME=$HOST_NAME \"$ROOT/deploy/argus-host.sh\" pair --watch --json"
echo "Pairing session started: $SESSION"
echo "Read the code with: tmux attach -t $SESSION"
