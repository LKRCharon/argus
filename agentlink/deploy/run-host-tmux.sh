#!/usr/bin/env bash
# Start the already-paired Host in a user-owned tmux session.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOST_NAME="${1:?usage: run-host-tmux.sh <host-name> [tmux-session]}"
SESSION="${2:-argus-host}"

case "$HOST_NAME" in
  *[!A-Za-z0-9._-]* | "") echo "host name may only use A-Z, a-z, 0-9, ., _, -" >&2; exit 2 ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi

tmux new-session -d -s "$SESSION" "exec env ARGUS_HOST_NAME=$HOST_NAME \"$ROOT/deploy/argus-host.sh\" watch"
echo "Argus Host started in tmux session: $SESSION"
echo "Attach with: tmux attach -t $SESSION"
