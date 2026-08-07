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

# Prefer an explicit service configuration, then a normal user PATH lookup.
if [[ -z "${CODEX_BIN:-}" ]] && command -v codex >/dev/null 2>&1; then
  export CODEX_BIN="$(command -v codex)"
fi

if [[ -x "$BUN" ]]; then
  exec "$BUN" run "$ROOT/packages/daemon/src/index.ts" "$@"
fi

# zjuL40 has Python + cryptography but no system Node/Bun.  The fallback has
# the same encrypted pairing and relay protocol, so installation stays entirely
# user-owned rather than requiring a package manager or sudo.
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Argus Host needs either $BUN or python3 on PATH" >&2
  exit 1
fi
exec "$PYTHON_BIN" "$ROOT/deploy/argus-host.py" "$@"
