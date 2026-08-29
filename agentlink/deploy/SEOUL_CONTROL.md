# Seoul Mesh Console

The Seoul controller is a local-only HTTP service. It keeps one encrypted
controller channel per paired peer and never exposes peer private keys to the
browser.

## Build and run

```bash
bun run build:app
AGENTLINK_HOME=/home/ubuntu/argus-control/state \
AGENTLINK_RELAY=ws://127.0.0.1:8787/ws \
ARGUS_CONTROL_DIST=/home/ubuntu/argus-control/current/packages/app/dist \
bun run control
```

Open it through an SSH local forward:

```bash
ssh -N -L 8790:127.0.0.1:8790 seoul
```

Then open `http://127.0.0.1:8790/mesh`.

To let Codex call this control plane through bounded Mesh and remote Codex MCP
tools, follow
[`CODEX_MCP.md`](CODEX_MCP.md).

Pairing is initiated on a host and accepted on Seoul with the controller
state directory. `join` only stores the peer; the long-running control service
then reconnects to every stored peer:

```bash
AGENTLINK_HOME=/home/ubuntu/argus-control/state \
AGENTLINK_RELAY=ws://127.0.0.1:8787/ws \
bun run packages/daemon/src/index.ts join PAIRING-CODE
```

Keep the controller state directory private. It contains Seoul's identity and
paired channel keys, but not target private keys.

The installed service is `argus-control.service`, bound only to
`127.0.0.1:8790`. The deployed L40 release keeps its identity and Mesh config
outside versioned code:

```text
/data3/lkr/argus-host/current
/data3/lkr/argus-host/state/mesh.json
```

The daemon rejects non-loopback bind addresses and Host headers as well as
cross-origin state changes. Keep using SSH forwarding instead of exposing the
HTTP port on a LAN interface.

The first Seoul/L40 group uses a local `gpu:l40` resource and a fixed
`gpu:status` runner backed by `/usr/bin/nvidia-smi`; the runner does not accept
an executable, cwd, environment, or shell command from the controller.
For a GPU resource with `statusRunnerId`, the controller requests only the
structured GPU metrics roughly once per minute. The `/mesh` console also has a
manual `刷新 GPU` action; raw `nvidia-smi` output is parsed on the host and is
not sent across the encrypted channel.

Task runners and status probes are different local capabilities. Set each
runner's `purpose` to `task` or `status`; a `status` runner is never advertised
as runnable work. Request-provided arguments are rejected unless that exact
task runner opts into `allowDynamicArgs`; stdin is separately gated by
`allowInput`. Both default to false.

For `workspace:kmac-m4`, configure a dedicated fixed status runner such as
`kmac-status-v1` with `purpose: "status"`, `approvalRequired: false`, no dynamic
arguments or stdin, and only the `read-only-status` workspace capability. Its
JSON result contains only connection state, watcher/Codex app-server
availability, active job count, workspace revision, last success/error stage,
and check time. Executable paths, fixed arguments, environment, and arbitrary
commands remain target-local and are not published by discovery.

Resource discovery publishes `allowedGroupIds`, `defaultGroupId` only when a
single trusted group is available, `allowedOperations`, and safe runner metadata.
The control API returns structured `GROUP_REQUIRED` and `GROUP_NOT_ALLOWED`
errors instead of guessing a group. Missing or contradictory resource group
metadata returns `GROUP_METADATA_UNAVAILABLE` or `GROUP_METADATA_INVALID` and
stops submission.

## Target-owner approval

Seoul submits `run` as an unsigned proposal. The target daemon validates the
group, requester, resource, runner ID, arguments, and timeout, then holds the
task in its private approval inbox. It signs a one-shot grant and approval only
after the target owner clicks `允许一次` on the target-local page.
Runners advertising `task-scoped-workspace` additionally require a verified
base artifact and cannot execute in an existing checkout.

The page binds to loopback on port 8791. Forward it over SSH:

```bash
ssh -N -L 8791:127.0.0.1:8791 zjuL40
```

Then open `http://127.0.0.1:8791/host`. The approval inbox is stored under
`AGENTLINK_HOME` with mode 0600. It contains typed task metadata, not identity
keys, channel keys, owner signatures, environment variables, or executable
paths. Cross-origin decisions are rejected.

## Durable jobs and artifacts

Every submitted job should carry an `idempotencyKey`. Seoul persists its binding
to the complete typed request and returns the same `taskId`, status, `createdAt`,
and polling interval for an identical retry. Corrupt or full replay journals stop
new submissions rather than evicting an old binding.

Coding inputs use a structured content-addressed manifest, not an archive. The
KMac target validates canonical relative POSIX paths, regular-file type, mode,
size, per-file hash, decoded total, duplicates, and overall SHA-256, then creates
a new task-scoped directory below `artifactRoot`. The runner never receives the
existing checkout as its writable workspace. Result delivery is a changed/deleted
manifest bound to both `taskId` and `baseArtifactId`; Seoul and the MCP gateway
verify it again before returning it to the commander.

Remote Codex thread creation is a durable asynchronous operation. The start API
returns HTTP 202 with `operationId`; clients poll `/api/codex/operations/:id`.
The journal records queued/sent/acknowledged/running/terminal transitions,
idempotency, exact timeout stage, retryability, and final `sessionId`, but never
the raw prompt. List/read/send deadlines propagate through controller, relay,
peer, watcher, and app-server rather than being cut off by a fixed 15-second
outer timeout.

## KMac connectivity

The supported KMac path is its outbound, paired AgentLink connection to the
relay. Seoul port `22022` is currently not listening and must be reported as
disabled in health checks. Normal task input and result retrieval do not depend
on reverse SSH, SCP, rsync, or a shared checkout.

Do not modify `sshd`, firewall rules, accounts, or keys to enable `22022` as part
of Mesh operation. A separate bootstrap tunnel can be considered only after
explicit authorization and its own security review; it is not a fallback for a
failed AgentLink peer.
