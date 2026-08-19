# Argus Host (no sudo)

This deployment is for a headless Linux machine running Codex locally. It is
not a public app-server: the host makes one outbound encrypted connection to a
relay, while its Codex app-server stays on its stdio transport (no listening
port at all).

On zjuL40 the release root is `/data3/lkr/argus-host/current`.

```bash
# First pairing: this tmux session prints the short pairing code, then turns
# into the normal watch bridge as soon as the phone accepts it.
/data3/lkr/argus-host/current/deploy/pair-host-tmux.sh zjuL40
tmux attach -t argus-pair

# Later starts after pairing:
/data3/lkr/argus-host/current/deploy/run-host-tmux.sh zjuL40
tmux attach -t argus-host
```

When Mesh is enabled, the same process serves the target-owner approval page
on `127.0.0.1:8791`. Reach it only through SSH forwarding and open `/host`.

A present Mesh configuration is strict by default. Unless it explicitly sets
`legacyControl: true`, the Host does not start transcript watchers or the Qoder
hook server, does not forward local Codex/Qoder events, and rejects all legacy
Agent bridge commands. Mesh discovery, status, durable jobs, cancellation, and
target-local approval continue on their own ordered control queue.

On headless Linux, `argus-host.sh` uses the stdlib Python WebSocket bridge when
`python3` is available. Bun still owns channel encryption and every Mesh policy
decision; the child only moves already-serialized relay JSON over TLS. Set
`AGENTLINK_WS_TRANSPORT=native` to opt back into the runtime WebSocket client.
The bridge uses standard 1 KiB continuation frames so low-MTU WSS paths do not
silently lose larger encrypted GPU and task responses.

`tmux` is used because the remote user manager has no linger permission; a
user-level systemd unit would stop after the last login session without an
administrator enabling linger. All runtime state stays in
`/data3/lkr/argus-host/state`, outside versioned releases.

The launcher first uses a bundled Bun runtime when one is present. On zjuL40,
where no sudo package install is available, it instead uses the existing
`python3` + `cryptography` environment through `deploy/argus-host.py`. Both
paths use the same Android pairing format and state files.
