# Windows Seoul MCP proxy

This is the Windows-side configuration for the long-lived local MCP proxy. The
proxy speaks local stdio to Codex and starts one SSH child for the Seoul MCP
server. It does not expose the SSH child, the control API, or any credentials
to the local MCP status tool.

## Prerequisites

The Bun executable currently available on Windows is:

```text
C:\Users\Lenovo\AppData\Local\Microsoft\WinGet\Links\bun.exe
```

The paths in the examples below are examples. Replace the `agentlink` checkout
path and the local JSON path for the machine in use. Copy
`argus-seoul-mcp-proxy.windows.example.json` to a local file such as
`C:\path\to\agentlink\deploy\argus-seoul-mcp-proxy.windows.json`; keep that
JSON untracked. It is a local configuration file, not a release artifact, and
must not contain plaintext secrets.

The example uses the hardened SSH argv below. The `-o` option and its value are
separate argv entries, so no shell quoting or command-string parsing is
involved:

```text
-T
-o BatchMode=yes
-o ClearAllForwardings=yes
-o ConnectTimeout=10
-o ConnectionAttempts=3
-o ServerAliveInterval=15
-o ServerAliveCountMax=3
-o TCPKeepAlive=yes
-o ControlMaster=no
-o ControlPath=none
-o LogLevel=ERROR
seoul
env
ARGUS_CONTROL_URL=http://127.0.0.1:8790
/home/ubuntu/.bun/bin/bun
run
/home/ubuntu/argus-control/current/packages/daemon/src/control/mcp.ts
```

## Start locally

From the `agentlink` checkout, use the local Bun path and the untracked JSON
file:

```powershell
Set-Location C:\path\to\agentlink
& "C:\Users\Lenovo\AppData\Local\Microsoft\WinGet\Links\bun.exe" run mcp:proxy -- --config "C:\path\to\agentlink\deploy\argus-seoul-mcp-proxy.windows.json"
```

The proxy owns the SSH child. Closing the local Codex stdio connection stops
the proxy and closes the child; an upstream SSH disconnect only marks the
upstream unavailable and leaves the local server connected.

## Codex configuration

The exact Codex TOML argv form invokes the local proxy and points it at the
untracked JSON configuration:

```toml
[mcp_servers.argus_seoul_proxy]
command = "C:\\Users\\Lenovo\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe"
args = [
  "run",
  "C:\\path\\to\\agentlink\\packages\\daemon\\src\\control\\mcp-proxy.ts",
  "--config",
  "C:\\path\\to\\agentlink\\deploy\\argus-seoul-mcp-proxy.windows.json",
]
startup_timeout_sec = 10
tool_timeout_sec = 130
enabled = true
```

The active Codex desktop is not reloaded or restarted by this implementation
task. Prepare the TOML and the untracked JSON now, then let the next planned
Codex restart load them.

## Runtime behavior

- Before the first valid upstream catalog is ready, tool calls fail
  immediately. Calls made while SSH is disconnected also fail immediately.
- Calls are never queued and are never replayed after reconnect. An in-flight
  SDK call settles as an upstream failure when its transport is lost.
- The last valid catalog remains visible while disconnected. A complete,
  valid replacement catalog becomes visible only after validation succeeds.
- After local initialization, each effective add, remove, or schema change
  emits one `notifications/tools/list_changed` notification. Object key-order
  changes that leave the catalog semantically unchanged emit none.
- Reconnect backoff is bounded from 250 ms to 30 seconds with jitter. The
  retry delay grows exponentially and is capped at the maximum.

The bounded `__argus_mcp_proxy_status` tool returns only these fields:
`state`, `generation`, `attempt`, `lastSuccessfulConnectionTime`,
`lastFailureCode`, `lastFailureStage`, and `reconnectScheduled`. It does not
return SSH argv, command paths, environment values, credentials, or raw
stderr.

## Rollout and rollback

1. Copy the example JSON to the local untracked path and check that its argv
   contains the hardened options and no secret values.
2. Confirm the local Bun and checkout paths in the example TOML are correct.
   Do not reload or restart the active Codex desktop during this task.
3. At the next planned Codex restart, enable the proxy entry and leave the
   direct SSH MCP entry disabled. Use the canary checklist below.
4. To roll back at a later planned restart, disable or remove the proxy entry,
   restore the prior direct SSH entry, and stop any manually running proxy.
   Leave the untracked JSON out of commits and releases.

## Manual post-restart canary

This checklist is documentation only and is not being executed in this task.
After a planned Codex restart:

- Open Codex MCP status and confirm `argus_seoul_proxy` is connected.
- Call `__argus_mcp_proxy_status` and check the bounded fields; confirm that
  no argv, path, environment value, credential, or raw stderr appears.
- List the Seoul tools and call one known read-only tool with a non-sensitive
  request.
- Temporarily make the SSH upstream unavailable, confirm the catalog remains
  visible and a new call fails without waiting for a replay.
- Restore SSH, confirm one effective catalog update notification and that the
  status generation advances after reconnect.
- Close the local Codex connection and confirm the proxy process and its SSH
  child exit; do not use `process.exit` or force-kill an unrelated process.
