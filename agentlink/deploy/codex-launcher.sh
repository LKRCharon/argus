#!/bin/sh
set -eu

# Keep non-interactive callers on the signed binaries shipped with Codex.
if [ -x /Applications/ChatGPT.app/Contents/Resources/codex ]; then
  exec /Applications/ChatGPT.app/Contents/Resources/codex "$@"
fi

plugin_codex="${HOME:?}/.codex/plugins/.plugin-appserver/codex"
if [ -x "$plugin_codex" ]; then
  exec "$plugin_codex" "$@"
fi

echo "codex launcher: no signed app-bundled Codex binary is available" >&2
exit 127
