#!/usr/bin/env bash
# User-space launcher for a headless Argus Host.
#
# The release is self-contained below /data3/lkr/argus-host on zjuL40:
# source, Bun runtime, peer identity, and logs all stay out of system paths.
set -euo pipefail

# Resolve `current` to its release directory before choosing a state path.
# `pwd` in Bash is logical by default, so without -P a launcher invoked via
# /data3/lkr/argus-host/current incorrectly stored state in that release.
ROOT="$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)"
BUN="$ROOT/runtime/bun"

# Releases live under <host-root>/releases/<version>, while identity and peer
# keys must survive an atomic `current` symlink switch. Local development keeps
# state in the checkout unless the caller supplies an explicit directory.
if [[ "$(basename "$(dirname "$ROOT")")" == "releases" ]]; then
  DEFAULT_STATE_DIR="$(dirname "$(dirname "$ROOT")")/state"
else
  DEFAULT_STATE_DIR="$ROOT/state"
fi

export AGENTLINK_HOME="${AGENTLINK_HOME:-$DEFAULT_STATE_DIR}"
export AGENTLINK_RELAY="${AGENTLINK_RELAY:-wss://relay.limen.codes/ws}"
export AGENTLINK_DEVICE_NAME="${ARGUS_HOST_NAME:-${AGENTLINK_DEVICE_NAME:-$(hostname)}}"
export AGENTLINK_DEVICE_PLATFORM="${AGENTLINK_DEVICE_PLATFORM:-linux}"
export ARGUS_HOST_APPROVAL_DIST="${ARGUS_HOST_APPROVAL_DIST:-$ROOT/packages/app/dist}"

# Prefer an explicit service configuration, then a normal user PATH lookup.
if [[ -z "${CODEX_BIN:-}" ]] && command -v codex >/dev/null 2>&1; then
  export CODEX_BIN="$(command -v codex)"
fi

# Bun's native WebSocket client can be receive-only on some headless Linux
# networks. Use the stdlib Python bridge when available; the Bun process still
# owns encryption, Mesh policy, approvals, runners, and all persistent state.
if [[ -z "${PYTHON_BIN:-}" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi
if [[ -n "$PYTHON_BIN" ]]; then
  export PYTHON_BIN
  export AGENTLINK_WS_TRANSPORT="${AGENTLINK_WS_TRANSPORT:-python}"
fi

if [[ -x "$BUN" ]]; then
  exec "$BUN" run "$ROOT/packages/daemon/src/index.ts" "$@"
fi

# zjuL40 has Python + cryptography but no system Node/Bun.  The fallback has
# the same encrypted pairing and relay protocol, so installation stays entirely
# user-owned rather than requiring a package manager or sudo.
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Argus Host needs either $BUN or python3 on PATH" >&2
  exit 1
fi
exec "$PYTHON_BIN" "$ROOT/deploy/argus-host.py" "$@"
