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

`tmux` is used because the remote user manager has no linger permission; a
user-level systemd unit would stop after the last login session without an
administrator enabling linger. All runtime state stays in
`/data3/lkr/argus-host/state`, outside versioned releases.

The launcher first uses a bundled Bun runtime when one is present. On zjuL40,
where no sudo package install is available, it instead uses the existing
`python3` + `cryptography` environment through `deploy/argus-host.py`. Both
paths use the same Android pairing format and state files.
