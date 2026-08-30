# KMac infrastructure readiness

This runbook prepares the KMac development host without restarting Argus,
AgentLink, SSH, or any LaunchAgent. Normal Mesh traffic still uses the paired
outbound AgentLink connection. Reverse SSH is a separately authorized
break-glass path.

## Stage-one bootstrap

Run from the reviewed Argus checkout:

```bash
./agentlink/deploy/kmac-bootstrap.sh "$PWD"
./agentlink/deploy/kmac-readiness.sh "$PWD"
```

The bootstrap is idempotent and makes only these user-owned changes:

- installs `~/.local/bin/codex` from `deploy/codex-launcher.sh`;
- appends a marked block to `~/.zshenv` for `~/.local/bin` and
  `/opt/homebrew/bin` in non-interactive zsh;
- appends the dedicated SSH host `github-argus-clash`, which reaches
  `ssh.github.com:443` through the local HTTP CONNECT proxy on
  `127.0.0.1:46640`;
- changes only this repository's `origin` URL and fetch refspec, then fetches
  all remote heads with pruning;
- stages, but does not install or load, the reverse-tunnel LaunchAgent.

Original files and absence markers are kept under
`~/.argus-backups/argus-infra-stage1-20260830`. The bootstrap prints SHA-256
readback for each source, backup, and installed file. It never changes global
Git configuration.

The Codex launcher prefers the signed binary in
`/Applications/ChatGPT.app/Contents/Resources/codex`, then the signed plugin
app-server binary. It deliberately has no PATH fallback, which prevents a
later package-manager shim from changing the watcher binary. This remains a
normal Codex CLI entry point; see the
[official Codex CLI documentation](https://developers.openai.com/codex/cli/).

GitHub CLI readiness is checked only with `gh api --silent user`. A
Keychain-invisible session reports `GH_KEYCHAIN_CONTEXT=UNAVAILABLE_NO_CREDENTIAL_ACTION`.
Do not compensate by exporting a token, reading credential files, or running a
new login flow.

The repository-specific Git transport must read back as:

```text
origin = git@github-argus-clash:LKRCharon/argus.git
fetch  = +refs/heads/*:refs/remotes/origin/*
```

`kmac-readiness.sh` also verifies that `git ls-remote` and the fetched
`origin/main` resolve to the same object.

## Reverse-tunnel health

The fixed readiness probe checks three layers without changing any process:

1. KMac SSH is listening and returns an SSH banner on `127.0.0.1:22`.
2. The existing KMac `ssh -R 127.0.0.1:22022:127.0.0.1:22 seoul` process is
   alive and Seoul owns the loopback listener.
3. Reading Seoul's `127.0.0.1:22022` returns the KMac SSH banner end to end.

The current `ssh -fNT` process is not persistent. Stage one copies the reviewed
LaunchAgent to:

```text
~/Library/Application Support/AgentLink/prepared/
  argus-infra-stage1-20260830/
  com.kairong.agentlink-seoul-reverse-tunnel.plist
```

It is intentionally not copied to `~/Library/LaunchAgents` and is not loaded.
Replacing the live forward with launchd ownership would contend for Seoul port
`22022`; perform that handoff only in a separate commander-approved window.
Never unload, kill, or replace the working process as part of stage one.

Seoul stores no private key for the second hop. A Windows ProxyCommand reaches
the loopback listener through Seoul, and Windows authenticates to KMac across
that byte stream with its own key.

## Workspace status and watcher candidate

Current main already validates the typed workspace status. The fixed
`deploy/kmac-workspace-status.ts` runner emits only:

```text
connectionStatus, watcherAvailable, codexAppServerAvailable, activeJobs,
workspaceRevision, lastSuccess, lastErrorStage, checkedAt
```

It accepts no arguments or stdin. It reads the durable task journal with a
structured parser, checks the fixed watcher LaunchAgent and local relay
forward, resolves Codex through the stable launcher, and reduces failures to
the existing deadline-stage enum. It does not emit paths, commands, stderr,
environment variables, or credential state. `workspaceRevision` comes from
the immutable release manifest; a development checkout falls back to its Git
HEAD.

Prepare an immutable watcher release from a clean reviewed commit. The
functional manifest is generated in the Git checkout and copied into the
archive because release directories intentionally contain no `.git` data:

```bash
agentlink_base="$HOME/Library/Application Support/AgentLink"
release_id="$(/bin/date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short=8 HEAD)"
release_dir="$agentlink_base/releases/$release_id"

/bin/mkdir -p "$release_dir"
git archive HEAD:agentlink | /usr/bin/tar -x -C "$release_dir"
(cd agentlink && bun run release:manifest write --root .)
/bin/cp agentlink/.argus-functional-manifest.json "$release_dir/"
(cd "$release_dir" && bun install --frozen-lockfile)
(cd "$release_dir" && bun run release:manifest verify --release .)
```

Then prepare a separate `0600` Mesh candidate. This command refuses an output
path equal to the live input path:

```bash
prepared="$agentlink_base/prepared/argus-infra-stage1-20260830"
/bin/mkdir -p "$prepared"

bun run agentlink/deploy/prepare-kmac-mesh-config.ts -- \
  --input "$agentlink_base/state/mesh.json" \
  --output "$prepared/mesh.json" \
  --runtime-bun "$agentlink_base/runtime/bun-1.3.14/bin/bun" \
  --status-script "$release_dir/deploy/kmac-workspace-status.ts" \
  --state-dir "$agentlink_base/state" \
  --codex-launcher "$HOME/.local/bin/codex"
```

The preparer binds `workspace:kmac-m4` to `kmac-status-v1` with
`purpose: "status"`, local approval disabled, dynamic arguments and stdin
disabled, and only the `read-only-status` capability. Existing policy is
preserved; no new task runner or shell surface is created.

Stage one stops here. Do not replace `state/mesh.json`, switch `current`, run
`launchctl kickstart`, or stop the old watcher. Activation must switch the
reviewed release and its matching candidate config together, verify relay
reconnection and status discovery, and roll both back together on failure.

## Stage-two activation

After the correction is reviewed and pushed, build a release from that exact
commit, install its frozen dependencies, and prepare a new mode-`0600` config.
The activation script is deliberately parameterized so the release and config
cannot be inferred from a mutable `current` path:

```bash
export ARGUS_REPO_ROOT="$PWD"
export ARGUS_REVIEWED_COMMIT="$(git rev-parse HEAD)"
export ARGUS_CANDIDATE_RELEASE="$HOME/Library/Application Support/AgentLink/releases/<release-id>"
export ARGUS_CANDIDATE_CONFIG="$HOME/Library/Application Support/AgentLink/prepared/stage2-20260830/mesh.json"
./agentlink/deploy/activate-kmac-watcher.sh
```

It fails closed unless `current` is the reviewed old release, the live config
has SHA-256
`b44c335294c4df0aaff0e8c1b8be418859fddf364f0f0ebe8befb1766339943f`, the
checkout is clean at `ARGUS_REVIEWED_COMMIT`, the candidate manifest and config
validate against the candidate code, and the old watcher is actually running.
It backs up the live config with a hash, atomically swaps the symlink and
config, restarts only `com.kairong.agentlink-watch`, and asks Seoul's fixed
read-only controller endpoint to prove a newer `lastSeen`, online peer,
`kmac-status-v1` binding, and ready workspace status. A post-switch failure
restores both artifacts atomically, restarts the old watcher, and prints
`ROLLED_BACK`; a gate failure before mutation prints `BLOCKED`.

The reverse tunnel is a separate passive handoff. Install and load the reviewed
plist with:

```bash
./agentlink/deploy/install-kmac-reverse-tunnel.sh
```

This backs up an existing plist, installs mode `0600`, validates it with
`plutil`, and loads only the dedicated label. It never signals or replaces an
existing manual reverse SSH process; while port `22022` is occupied, launchd's
child may retry. Recheck the unchanged manual PID and Seoul loopback SSH banner
after loading.
