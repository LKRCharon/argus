# Argus Mesh

Argus Mesh is the first typed cross-device task boundary for `agentlink`. It
lets paired Argus daemons exchange bounded tasks over the existing encrypted
channel without turning a peer's natural-language request into a shell command.

The initial release is intentionally small:

- `inspect` is read-only and returns a bounded local resource preview.
- `mesh resources` / `mesh-resource-list-request` exposes stable resource IDs,
  trusted-group bindings, allowed operations, and safe runner metadata. It never
  exposes executable paths, fixed arguments, local working directories, or
  environment variables.
- `quarantine` moves a resource to a local recovery directory and writes a
  manifest; it is not hard deletion. The resource is removed from the active
  Mesh catalog until the owner restores it locally.
- `run` invokes a target-owned named runner with an owner-configured executable,
  fixed arguments, fixed environment, bounded input/output, and a local working
  directory. It returns a concise `resultSummary`; stderr is omitted unless the
  owner explicitly enables bounded `exposeDebugOutput`.
- Source delivery uses structured, content-addressed base and result manifests.
  `stage` and `apply-patch` remain denied executor vocabulary; a requester never
  sends tar archives, checkout paths, or arbitrary patch commands.
- `deploy`, `delete`, `sudo`, `secret-read`, and `arbitrary-shell` are denied by
  policy and by the executor. A valid transport key cannot override this.

## Trust model

Pairing authenticates the encrypted transport. It is not authorization.
Authorization additionally requires:

1. The requester and target are members of the configured group.
2. The requester ID is the authenticated transport peer. A local `requesters`
   allowlist can reject that peer, but cannot let it claim another member's ID.
3. The target resolves the resource ID from its local configuration. Remote
   paths, working directories, and command strings are ignored.
4. Mutating tasks carry an owner-signed Ed25519 capability grant bound to the
   exact group, task, target, resource, operation, scope, expiry, and nonce.
5. `quarantine` and other high-risk typed operations require a separate owner
   approval signature.
6. A successful decision is one-shot. Reusing the task ID or grant nonce is a
   replay and is denied.
7. Artifact manifests bind every regular file's canonical relative POSIX path,
   mode, size, SHA-256, and base64 content into an overall SHA-256. Absolute
   paths, drive paths, `..`, NUL, backslashes, symlinks, duplicate paths, hash
   mismatches, and configured size limits fail closed.

The owner signing key is independent from the pairing key and is stored in
`mesh-signing.json` with mode `0600` on POSIX systems. Decisions are written to
the bounded `mesh-audit.jsonl` file with mode `0600`. If an allowed decision
cannot be audited, it fails closed.

## Configuration

Copy [`agentlink/mesh.example.json`](../agentlink/mesh.example.json) to
`$AGENTLINK_HOME/mesh.json` (normally `~/.agentlink/mesh.json`), replace all
placeholder fingerprints and paths, and on macOS/Linux run:

```bash
chmod 600 ~/.agentlink/mesh.json
```

`AGENTLINK_MESH_CONFIG` can point to another config file. Every `allowedRoots`
and resource `root` must be absolute. Resources must be inside an allowed root;
symlinks are not followed during previews. Keep the quarantine directory
outside the resource tree.

The local node fingerprint is printed by:

```bash
bun run packages/daemon/src/index.ts init
bun run packages/daemon/src/index.ts mesh status
```

`legacyControl` defaults to `false`. When Mesh is enabled, `watch` rejects the
old remote session/input/permission-control messages unless this flag is
explicitly set to `true`. That flag is a compatibility escape for a trusted,
single-owner setup—not a safe multi-user mode.

To expose a GPU or other accelerator, add a `runners` entry. Its `executable`
must already exist on the target and is validated as a non-symlink executable;
the runner's `fixedArgs` and `env` are local owner configuration. The requester
can only send the runner ID, bounded positional args, optional stdin, and a
timeout no longer than the local runner limit. A task wrapper should emit one
JSON object containing `resultSummary`. Full prompts, Codex transcripts, command
streams, and stdout/stderr are not returned. Set `exposeDebugOutput: true` only
when bounded stderr is safe to disclose.

Discovery returns `allowedGroupIds`, an optional `defaultGroupId`,
`allowedOperations`, and runner `title`, `purpose`, `inputSchema`,
`resultSchema`, `approvalRequired`, `maxRuntimeMs`, and
`workspaceCapabilities`. If a resource has exactly one trusted group, a control
client may omit `groupId`; the controller derives it. Ambiguous or disallowed
groups return `GROUP_REQUIRED` or `GROUP_NOT_ALLOWED` instead of guessing.
Missing or internally inconsistent resource group metadata fails closed as
`GROUP_METADATA_UNAVAILABLE` or `GROUP_METADATA_INVALID`.

A status runner has `purpose: "status"`, accepts no dynamic arguments or stdin,
and is never offered as task execution. A workspace status runner returns only
`connectionStatus`, watcher and Codex app-server availability, `activeJobs`,
`workspaceRevision`, `lastSuccess`, `lastErrorStage`, and `checkedAt`.

A task runner that advertises `task-scoped-workspace` must receive a verified
base artifact. It cannot fall back to its configured workdir, so remote coding
jobs never modify the target's existing checkout.

The requester can discover those stable IDs before constructing a task:

```bash
bun run packages/daemon/src/index.ts mesh resources \
  --target TARGET_NODE_FINGERPRINT --json
```

## Minimal workflow

On both machines, pair the daemons and put both fingerprints in the same group.
On the target machine, run the normal watch bridge:

```bash
AGENTLINK_RELAY=wss://your-relay.example/ws \
  bun run packages/daemon/src/index.ts watch
```

The requester can first perform a read-only inspection:

```bash
bun run packages/daemon/src/index.ts mesh request \
  --target PEER_NODE_FINGERPRINT \
  --group group-alpha \
  --resource repo:gpu-project \
  --operation inspect \
  --json
```

For a GPU task, use the `runnerIds` returned by resource discovery. The runner
ID is the only executable selection that crosses the channel; the target's
local config remains the source of truth for the actual binary and limits.

For a reversible high-risk operation, the resource owner signs two separate
artifacts on the target machine:

```bash
bun run packages/daemon/src/index.ts mesh grant \
  --group group-alpha \
  --requester REQUESTER_NODE_FINGERPRINT \
  --resource repo:gpu-project \
  --operation quarantine > grant.json

bun run packages/daemon/src/index.ts mesh approve \
  --grant-file grant.json \
  --summary "reviewed the exact repository and task" > approval.json
```

The requester then sends the exact signed task:

```bash
bun run packages/daemon/src/index.ts mesh request \
  --target TARGET_NODE_FINGERPRINT \
  --grant-file grant.json \
  --approval-file approval.json \
  --json
```

The same grant/approval flow can run a named GPU wrapper:

```bash
bun run packages/daemon/src/index.ts mesh grant \
  --group group-alpha \
  --requester REQUESTER_NODE_FINGERPRINT \
  --resource repo:gpu-project \
  --operation run \
  --scope-json '{"runnerId":"gpu-project-runner-v1","args":["--input","job.json"],"timeoutMs":600000}' > grant.json

bun run packages/daemon/src/index.ts mesh approve \
  --grant-file grant.json \
  --summary "approved the named GPU runner and bounded job" > approval.json
```

## Structured workspace artifacts

A coding job can include `baseArtifact` and bind its content-addressed
`artifactId` in `scope.baseArtifactId`. Limits are 256 regular files, 1 MiB per
file, and 8 MiB decoded content in total. The target validates the complete
manifest before approval, then writes it under a new task-scoped directory below
its local `artifactRoot`. It never overlays or edits the resource's existing
checkout.

After the runner exits, the target scans only that isolated workspace and
creates a result manifest with `changed` files and `deleted` paths. The task
result includes `baseArtifactId`, `resultArtifactId`, the result SHA-256, and
changed/deleted counts. Retrieve the manifest by `taskId`; the controller and MCP
gateway revalidate task binding, canonical paths, per-file size/hash, total
limits, and the overall digest before returning it. The commander must perform
the same checks before applying files locally.

Artifact delivery uses the paired encrypted AgentLink channel. Normal operation
does not use SSH, SCP, rsync, tar extraction, or an existing checkout on the
worker.

The target keeps a `mesh-tasks.json` journal with lifecycle and sanitized result
metadata. Reconnecting with a completed task ID returns the stored result
instead of running it again; reusing the ID with different task fields is a
conflict. The journal fails closed when its 1,000-record replay ledger is full;
the owner must archive state locally before accepting more unique task IDs.
Archive it only after every recorded grant has expired, or rotate the owner's
signing key first, so removing replay records cannot make an old task valid again.

The Seoul controller separately persists task idempotency keys. A repeated key
with the same typed request returns the original stable `taskId`; binding the key
to different input returns `IDEMPOTENCY_CONFLICT`. Corrupt, over-permissive, or
full controller journals stop submissions instead of dropping replay records.

The grant and approval contain public signatures, not the owner's private key.
Treat them as authorization records and do not leave them in a shared writable
directory.

## Device compatibility and boundaries

The wire additions are JSON/Zod schemas and are additive to the existing
`BusinessPayload` discriminator. Bun/Node daemons on macOS, Linux, and Windows
use the same typed messages and native path checks, including artifact request
and response payloads. Android now has typed relay APIs for resource discovery
and task results; the initial Android UI does not yet expose Mesh grant/approval
controls.

The relay remains zero-knowledge for Mesh payloads. Codex/Qoder may propose a
task through a future adapter, but the daemon—not the model and not the
relay—owns group membership, signatures, path resolution, execution, and
rollback. A GPU wrapper should remain a named typed runner with its own input
validation and resource limits; it should not re-enable arbitrary shell.

## Seoul control console

The daemon can also run a Seoul-side controller for several paired peers:

```bash
bun run control
```

The controller binds to `127.0.0.1:8790` and serves `/mesh`. Non-loopback bind
addresses, non-loopback Host headers, and cross-origin mutations are rejected. It
maintains one encrypted channel per stored peer, periodically discovers local
resources, and records sanitized task lifecycle metadata in
`control-tasks.json`. The browser never receives peer long-term keys.

Only `inspect` and named-runner `run` are exposed by the console. A `run` task
arrives as an unsigned proposal; the target creates the exact one-shot grant
and approval only after its owner approves locally. The dashboard never holds
target signing material. Use an SSH local forward to view it remotely:

```bash
ssh -N -L 8790:127.0.0.1:8790 seoul
```

Seoul port `22022` is intentionally not listening and is not part of the Mesh
health contract. Do not configure a reverse SSH listener, change `sshd`, alter a
firewall, or install keys as part of normal source or result delivery. Enabling
such a bootstrap path requires separate explicit authorization; its absence does
not degrade the paired AgentLink path.

The current Seoul deployment is available at `/mesh` through an SSH local
forward. It keeps the HTTP listener private and has been verified against an
online L40 peer with both `inspect` and a fixed, owner-approved `run` runner.
