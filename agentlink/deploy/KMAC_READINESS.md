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
- appends a separate marked block to `~/.zprofile`; macOS login shells run
  `path_helper` after `.zshenv`, so both files are needed for
  `ssh ... /bin/zsh -lc` to resolve `~/.local/bin/codex`;
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

GitHub authentication readiness is provided by the owner-configured
`kmac-github-status-v1` named status runner. It invokes the exact
`/opt/homebrew/bin/gh auth status --hostname github.com` operation and rejects
all caller arguments, stdin, host/repository selection, and environment input.
The child environment is an allowlist containing only the intended `HOME`, a
fixed `PATH`, and `GH_PROMPT_DISABLED`; `GH_TOKEN`, `GITHUB_TOKEN`, enterprise
variants, `GH_CONFIG_DIR`, and other override variables are removed before
`gh` starts. The runner parses its own output and emits only the typed status,
login, source, check time, and bounded error code.
Git fetch and push always use the repository's GitHub SSH-over-Clash alias.
GitHub API and PR work default to the Windows commander. The readiness path
never accepts or forwards a process token.

The readiness command also emits one `READINESS_PROBES=<json>` record from
`deploy/kmac-readiness-probes.ts`. Its GitHub object includes the safe runner
result and compatibility transport fields only. The runner status is one of
`authenticated`, `unauthenticated`, `unavailable`, or `error`; the shell
readiness output distinguishes those states without exposing diagnostics.
Command output, token values, private keys, Authorization headers, paths, and
environment values never enter the result.

The repository-specific Git transport must read back as:

```text
origin = git@github-argus-clash:LKRCharon/argus.git
fetch  = +refs/heads/*:refs/remotes/origin/*
```

`kmac-readiness.sh` also verifies that `git ls-remote` and the fetched
`origin/main` resolve to the same object.

## Reverse-tunnel health

Control endpoint discovery checks use `GET /api/discovery`, a bounded
read-only response containing peer/resource readiness and task counts. The
loopback web console continues to use `GET /api/overview`; its task rows are
metadata-only.

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
remoteCodexControl, workspaceRevision, lastSuccess, lastErrorStage, checkedAt
```

It accepts no arguments or stdin. It reads the durable task journal with a
structured parser, checks the fixed watcher LaunchAgent and local relay
forward, resolves Codex through the stable launcher, and reduces failures to
the existing deadline-stage enum. It does not emit paths, commands, stderr,
environment variables, or credential state. `workspaceRevision` comes from
the immutable release manifest; a development checkout falls back to its Git
HEAD.

The same resource is also bound to `kmac-github-status-v1`. Its public result
is the strict `status`, `login`, `source`, `checkedAt`, and optional `errorCode`
envelope. Mesh discovery publishes the runner name and resource status only;
the executable, fixed arguments, environment, and raw process streams remain
target-local.

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
  --codex-launcher "$HOME/.local/bin/codex" \
  --github-status-script "$release_dir/deploy/kmac-github-status.ts" \
  --github-home "$HOME" \
  --enable-remote-codex-control
```

The preparer binds `workspace:kmac-m4` to both `kmac-status-v1` and
`kmac-github-status-v1`. Both use `purpose: "status"`, local approval
disabled, dynamic arguments and stdin disabled, and only the
`read-only-status` capability. The final flag is an explicit candidate-only
opt-in; omitting it preserves `remoteCodexControl: false`. No new task runner
or shell surface is created.

## Phase-three release workflow

Phase three makes release activation an explicit, auditable sequence. Run it
from the reviewed checkout with canonical absolute paths. The base must be the
persistent AgentLink root; temporary roots are available only to the exported
test API and are rejected by the CLI.

```bash
cd agentlink
reviewed_commit="$(git rev-parse HEAD)"
candidate="$HOME/Library/Application Support/AgentLink/releases/<release-id>"
active="$HOME/Library/Application Support/AgentLink/releases/<active-release>"

bun run release:workflow -- prepare \
  --candidate "$candidate" --git-root "$PWD" \
  --reviewed-commit "$reviewed_commit" --executor hardened-kmac --json

bun run release:workflow -- preflight \
  --candidate "$candidate" --active "$active" --git-root "$PWD" \
  --reviewed-commit "$reviewed_commit" --json
```

`prepare` archives the exact reviewed commit, writes the functional SHA-256
manifest, verifies the complete tree, and makes the candidate non-writable
before recording its operation ID. `preflight` is read-only: it creates no
directories, lock, operation state, audit record, link, or Mesh/config file.
Both commands reject path aliases, traversal, symlink escapes, dirty
functional files, stale Git HEAD, and a candidate whose manifest does not
match the reviewed artifact.

Production activation uses the existing hardened adapter unchanged. It requires
the explicit live and candidate Mesh hashes, the fixed runtime, repository,
candidate config, and `--require-remote-codex-control`:

```bash
bun run release:workflow -- activate \
  --candidate "$candidate" --active "$active" --git-root "$PWD" \
  --reviewed-commit "$reviewed_commit" --operation-id <operation-id> \
  --executor hardened-kmac \
  --runtime-bun "$HOME/Library/Application Support/AgentLink/runtime/bun-1.3.14/bin/bun" \
  --candidate-config "$HOME/Library/Application Support/AgentLink/prepared/<stage>/mesh.json" \
  --expected-live-mesh-sha256 <live-hash> \
  --expected-candidate-mesh-sha256 <candidate-hash> \
  --repository-root "$PWD" --require-remote-codex-control --json
```

The command records durable operation state before the switch and a hash-chain
audit record before reporting `active`. It serializes activation with a
non-reclaimable lock; malformed or stale lock metadata blocks. `status` and
`audit` are read-only bounded JSON queries. `rollback` verifies the exact prior
release captured by the operation and atomically restores the `current` link;
it reports `rolled-back` only after the prior tree, directory identity, link,
state, and audit postconditions all pass. A hardened adapter failure performs
its existing internal rollback. The workflow intentionally blocks a separate
hardened rollback because no live Mesh backup may be inferred or overwritten;
filesystem rollback is exposed only through the temporary-root test API.

The old `deploy/activate-kmac-watcher.sh` entry point remains the production
adapter and is not replaced. New callers should use the workflow for
prepare/preflight/audit/status and invoke its hardened `activate` phase; direct
shell invocation remains compatible for the existing commander migration.

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
export AGENTLINK_INSTALL_ROOT="$HOME/Library/Application Support/AgentLink"
export ARGUS_EXPECTED_OLD_RELEASE="$AGENTLINK_INSTALL_ROOT/releases/<expected-old-release>"
export ARGUS_EXPECTED_LIVE_MESH_SHA256="<lowercase sha256 of live state/mesh.json>"
export ARGUS_CANDIDATE_RELEASE="$HOME/Library/Application Support/AgentLink/releases/<release-id>"
export ARGUS_CANDIDATE_CONFIG="$HOME/Library/Application Support/AgentLink/prepared/stage2-20260830/mesh.json"
export ARGUS_EXPECTED_CANDIDATE_MESH_SHA256="<lowercase sha256 of candidate mesh.json>"
export ARGUS_REQUIRE_REMOTE_CODEX_CONTROL=true
./agentlink/deploy/activate-kmac-watcher.sh
```

All release/config identity parameters above are explicit: no old-release or live-hash
default is hidden in the script. It fails closed unless `current` is the
expected old release, both hashes are lowercase SHA-256 and the candidate hash
matches the complete candidate file before any backup or mutation, the checkout
is clean at `ARGUS_REVIEWED_COMMIT`, and the candidate manifest reports both a
valid tree and exactly that commit. Candidate release/config paths must be
persistent absolute paths whose canonical targets stay inside
`$AGENTLINK_INSTALL_ROOT/releases` and `$AGENTLINK_INSTALL_ROOT/prepared`; the
current link, live config, backup directory, runtime, and controller inputs are
also restricted to their fixed bounded locations or safe values. A temporary
path, parent traversal, symlink escape, or live-config alias is rejected. The
candidate hash is checked again while creating the atomic live-config
replacement. The old watcher must also report the exact `state = running` line.

The script backs up the live config with a hash, atomically swaps the symlink and
config, restarts only `com.kairong.agentlink-watch`, and asks Seoul's fixed
read-only controller endpoint to prove a newer `lastSeen`, online peer,
`kmac-status-v1` binding, ready workspace status, and
`remoteCodexControl: true`. It also requires the explicit
`ARGUS_REQUIRE_REMOTE_CODEX_CONTROL=true` activation input before any mutation.
A post-switch failure
restores both artifacts atomically, restarts the old watcher, and checks only
rollback reconnect health before printing `ROLLED_BACK`; a gate failure before
mutation prints `BLOCKED`.

The control-plane sequence is deliberately ordered:

1. Activate the reviewed watcher release and candidate Mesh config.
2. Run the Argus operation canary and confirm that outbound Mesh status and
   operations are usable as the alternate control plane.
3. Only after that canary succeeds, install/load the passive reverse-tunnel
   plist.
4. Dispatch the destructive SSH handoff last. Never run the handoff script in
   the commander's foreground SSH session.

The reverse tunnel is a separate passive handoff. After the Mesh canary,
install and load the reviewed plist with:

```bash
./agentlink/deploy/install-kmac-reverse-tunnel.sh
```

This creates or reuses the existing stage-two `0700` backup directory at
`~/.argus-backups/argus-infra-stage2-20260830` (an explicitly supplied
`$AGENTLINK_INSTALL_ROOT/activation/handoff/backups` is also accepted). If the
target plist was absent, it writes the one-time
`reverse-tunnel-plist.absent` marker (`state=target_absent`); if it existed, it
keeps the one-time `reverse-tunnel-plist.before` backup. It installs mode
`0600`, validates with `plutil`, and loads only the dedicated label. Its output is explicitly
`PASSIVE_REVERSE_TUNNEL_STAGED` followed by
`PASSIVE_REVERSE_TUNNEL_LOADED_NOT_PROVEN`; loaded does not mean the tunnel is
healthy. It never signals or replaces an existing manual reverse SSH process;
while port `22022` is occupied, launchd's child may retry.

The destructive handoff is implemented as a detached dispatcher and must be
run only in a commander-approved window. First obtain the exact hash of the
installed target plist without printing its contents, then export only these
fixed inputs:

```bash
export ARGUS_EXPECTED_MANUAL_SSH_PID=97171
export ARGUS_EXPECTED_REVERSE_PLIST_SHA256="<lowercase sha256 of ~/Library/LaunchAgents/com.kairong.agentlink-seoul-reverse-tunnel.plist>"
./agentlink/deploy/dispatch-kmac-reverse-tunnel.sh
```

The dispatcher accepts no positional command. It creates a result file under
`$AGENTLINK_INSTALL_ROOT/activation/handoff/results/` with a `0700` parent,
writes the sole initial `status=STARTED` atomically, waits at least three
seconds in an independent one-shot worker, detaches all stdio from SSH, and
prints only a bounded `dispatch_id`, result path, and child PID. The worker
invokes the handoff with fixed argv. Both scripts are checked first as regular,
non-symlink, executable files inside the deploy directory; the dispatcher
proves and rechecks the exact worker command, then disarms its failure traps
before printing `DISPATCHED`. Launch or early-start failure atomically changes
the pending result to `BLOCKED` and only terminates that exact current worker
command, and it explicitly refuses PID `97171`. If the detached worker's fixed handoff preflight fails, including its
second check after the delay, it atomically changes a still-`STARTED` result to
`BLOCKED detail=worker_handoff_preflight`; it does not replace an existing
terminal result. There is no `eval`, shell command string, or inherited
credential environment.

The remaining theoretical races are unavoidable in shell: an exact `ps`/
socket identity check cannot be atomic with a later `kill`, and a status check
cannot be atomic with the following filesystem rename. Immediate revalidation,
including a second candidate-config hash during replacement, canonical bounded
paths, and same-directory atomic replacement narrow those windows, but do not
eliminate them.

The commander must record the printed result path, let the dispatcher return,
then reconnect through the Mesh canary/available control route and poll that
file. Do not invoke `handoff-kmac-reverse-tunnel.sh` in the foreground. The
handoff first checks the exact numeric PID, its fixed `ssh -R
127.0.0.1:22022:127.0.0.1:22 seoul` command/socket identity, and the Seoul
banner. Before `stop_manual`, it also requires the target to be mode `0600`,
`plutil`-valid, to match `ARGUS_EXPECTED_REVERSE_PLIST_SHA256` byte-for-byte,
and to have the exact label loaded. Failure boots out only that LaunchAgent;
rollback restores `reverse-tunnel-plist.before`, or removes the target when
the absent marker is present. A restored previous plist is deliberately kept
unloaded because its former loaded state cannot be proved; the result records
`previous_plist_state=unloaded_not_proven`. Manual SSH restoration and the
Seoul `22022` SSH banner must pass before the final `ROLLED_BACK` state is
written. Any unrecoverable verification failure is `BLOCKED`.

The result file is atomically replaced for each state and contains only bounded
status, dispatch id, timestamps, numeric PIDs, and fixed reason tokens. This
stage-three implementation turn does not run the dispatcher, stop PID `97171`,
or modify the live watcher/tunnel.

The same JSON record contains the read-only Android SDK probe. It checks
`PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and the known per-user SDK
locations. Its aggregate state is one of `ready`, `missing-packages`,
`missing-license`, or `missing-tooling`, with booleans for `adb`, the API 35
platform/build-tools, platform-tools, and the SDK license marker. It never
runs `adb devices`, starts an adb server, accepts licenses, installs packages,
or touches a device. A missing license remains `missing-license`; do not
accept licenses or install platforms, build-tools, emulator images, Studio,
APKs, or phone software as part of readiness.
