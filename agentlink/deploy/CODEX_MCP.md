# Codex MCP gateway on Seoul

The gateway is a local STDIO MCP server. It talks only to the Seoul control
API on loopback and owns no device identity, channel key, grant, approval, or
runner executable path.

Install workspace dependencies and confirm the control service is healthy:

```bash
cd /home/ubuntu/argus-control/current
bun install --frozen-lockfile
curl -fsS http://127.0.0.1:8790/health
```

Add the server to the Codex host running on Seoul:

```bash
codex mcp add argus_mesh \
  --env ARGUS_CONTROL_URL=http://127.0.0.1:8790 \
  -- /home/ubuntu/.bun/bin/bun run \
  /home/ubuntu/argus-control/current/packages/daemon/src/control/mcp.ts
```

Or add the equivalent project-scoped configuration to `.codex/config.toml`:

```toml
[mcp_servers.argus_mesh]
command = "/home/ubuntu/.bun/bin/bun"
args = [
  "run",
  "/home/ubuntu/argus-control/current/packages/daemon/src/control/mcp.ts",
]
cwd = "/home/ubuntu/argus-control/current"
env = { ARGUS_CONTROL_URL = "http://127.0.0.1:8790" }
default_tools_approval_mode = "writes"
startup_timeout_sec = 10
tool_timeout_sec = 30
enabled = true
```

Restart the Codex client after adding the server, then use `/mcp` or
`codex mcp list` to confirm these tools:

- `mesh_list_devices`
- `mesh_submit_job`
- `mesh_get_job`
- `mesh_cancel_job`

`mesh_submit_job` does not bypass the Mesh boundary. An `inspect` request stays
read-only. A `run` request is an unsigned proposal until the target owner opens
`http://127.0.0.1:8791/host` through SSH and selects `允许一次`. The target then
signs the exact one-shot capability locally.

Codex CLI, the IDE extension, and the ChatGPT desktop app share MCP
configuration on the same Codex host. The current configuration fields and
approval modes are documented in the
[official OpenAI MCP guide](https://developers.openai.com/codex/mcp/).
