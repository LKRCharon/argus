# Codex MCP gateway on Seoul

The gateway is a local STDIO MCP server. It talks only to the Seoul control
API on loopback and owns no device identity, channel key, grant, approval, or
runner executable path.

`ARGUS_CONTROL_URL` is restricted to `localhost`, `127.0.0.1`, or `::1`; the
gateway refuses remote HTTP endpoints even when an environment variable tries
to configure one.

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
tool_timeout_sec = 130
enabled = true
```

Restart the Codex client after adding the server, then use `/mcp` or
`codex mcp list` to confirm these tools:

- `mesh_list_devices`
- `mesh_list_jobs`
- `mesh_submit_job`
- `mesh_get_job`
- `mesh_get_result_artifact`
- `mesh_cancel_job`
- `remote_codex_list_threads`
- `remote_codex_read_thread`
- `remote_codex_start_thread`
- `remote_codex_get_operation`
- `remote_codex_list_operations`
- `remote_codex_send_message`
- `remote_codex_interrupt`
- `remote_codex_get_events`
- `remote_codex_list_approvals`
- `remote_codex_respond_approval`

`mesh_submit_job` does not bypass the Mesh boundary. An `inspect` request stays
read-only. A `run` request is an unsigned proposal until the target owner opens
`http://127.0.0.1:8791/host` through SSH and selects `允许一次`. The target then
signs the exact one-shot capability locally. Always provide an
`idempotencyKey`; retrying the same typed request returns the same stable
`taskId`, while changing its input returns `IDEMPOTENCY_CONFLICT`.

`mesh_list_devices` returns each resource's `allowedGroupIds`, optional
`defaultGroupId`, `allowedOperations`, safe runner schemas/capabilities, and
bounded GPU or workspace status. `groupId` may be omitted only when discovery
shows one trusted group. `mesh_list_jobs` accepts target/resource/group/status,
`createdAfter`, `limit <= 100`, and `cursor`; it never returns prompts, secrets,
or environments.

Submission fails closed when group metadata is missing or inconsistent. A
runner advertising `task-scoped-workspace` requires a content-addressed base
artifact; it cannot run against the target's existing checkout.

For a coding job, `mesh_submit_job` accepts a structured `baseArtifact` whose
files are canonical relative POSIX paths with mode, size, SHA-256, and base64
content. The target creates a new task-scoped workspace and returns
`resultArtifactId`; use `mesh_get_result_artifact` with the stable `taskId` to
fetch a verified changed/deleted manifest. Apply it only after independently
checking its task binding, paths, per-file and overall hashes. This path does not
use tar, SSH, SCP, or rsync.

`remote_codex_start_thread` is asynchronous. It persists the request without the
raw prompt and normally returns `operationId` in under two seconds. Pass an
`idempotencyKey`, then poll `remote_codex_get_operation` until `completed`,
`failed`, or `timed_out`; a completed operation includes the final `sessionId`.
Operation states are `queued`, `sent`, `acknowledged`, `running`, `completed`,
`failed`, and `timed_out`. Timeout errors identify `controller`, `relay`, `peer`,
`watcher`, or `app-server` and include `retryable`. The 130-second MCP timeout is
intentional: synchronous list/read/send calls can carry a deadline up to 120
seconds and must not be cut off by an older 15-second outer timeout.

`remote_codex_get_events` uses a cursor scoped to the requested `targetNodeId`;
each peer has its own contiguous sequence. `hasMore` means another retained
forward page can be fetched. `cursorGap` means the caller's cursor predates the
retained peer buffer, and `cursorGapEvents` is the exact number of peer sequence
positions that aged out. `truncatedEvents` adds those aged-out positions to any
retained matching rows omitted by the page limit. With a `sessionId` filter,
the gap count still describes the target peer stream, while page-limit counts
describe matching retained rows. The MCP gateway combines its own bounded page
with upstream metadata: upstream `hasMore: false`, `truncated: false`, or
`truncatedEvents: 0` cannot hide events omitted locally, and a local page cursor
always points to the last event actually returned.

Codex CLI, the IDE extension, and the ChatGPT desktop app share MCP
configuration on the same Codex host. The current configuration fields and
approval modes are documented in the
[official OpenAI MCP guide](https://developers.openai.com/codex/mcp/).
