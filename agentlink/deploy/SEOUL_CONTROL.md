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

To let Codex call this control plane through four bounded MCP tools, follow
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

## Target-owner approval

Seoul submits `run` as an unsigned proposal. The target daemon validates the
group, requester, resource, runner ID, arguments, and timeout, then holds the
task in its private approval inbox. It signs a one-shot grant and approval only
after the target owner clicks `允许一次` on the target-local page.

The page binds to loopback on port 8791. Forward it over SSH:

```bash
ssh -N -L 8791:127.0.0.1:8791 zjuL40
```

Then open `http://127.0.0.1:8791/host`. The approval inbox is stored under
`AGENTLINK_HOME` with mode 0600. It contains typed task metadata, not identity
keys, channel keys, owner signatures, environment variables, or executable
paths. Cross-origin decisions are rejected.

## Mac mini tunnel

Use a dedicated SSH account on Seoul. The Mac mini can keep one outbound SSH
connection with both a local relay forward and a Seoul-side SSH reverse port:

```bash
ssh -NT \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:28787:127.0.0.1:8787 \
  -R 127.0.0.1:22022:127.0.0.1:22 \
  macmini-tunnel@seoul
```

Bind the Mac mini daemon to `ws://127.0.0.1:28787/ws`. On Seoul, use
`ssh -p 22022 127.0.0.1` for bootstrap and bounded `rsync` transfers. The
SSH account must have no shell, no agent forwarding, no X11 forwarding, and a
single `permitlisten` port.
