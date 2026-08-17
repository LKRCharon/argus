# Argus Mesh

Argus Mesh is the first typed cross-device task boundary for `agentlink`. It
lets paired Argus daemons exchange bounded tasks over the existing encrypted
channel without turning a peer's natural-language request into a shell command.

The initial release is intentionally small:

- `inspect` is read-only and returns a bounded local resource preview.
- `quarantine` moves a resource to a local recovery directory and writes a
  manifest; it is not hard deletion.
- `stage`, `run`, and `apply-patch` are protocol vocabulary for the next typed
  executors. The v0 executor returns a safe failure for them.
- `deploy`, `delete`, `sudo`, `secret-read`, and `arbitrary-shell` are denied by
  policy and by the executor. A valid transport key cannot override this.

## Trust model

Pairing authenticates the encrypted transport. It is not authorization.
Authorization additionally requires:

1. The requester and target are members of the configured group.
2. The requester is in the local `requesters` allowlist, when one is set.
3. The target resolves the resource ID from its local configuration. Remote
   paths, working directories, and command strings are ignored.
4. Mutating tasks carry an owner-signed Ed25519 capability grant bound to the
   exact group, task, target, resource, operation, scope, expiry, and nonce.
5. `quarantine` and other high-risk typed operations require a separate owner
   approval signature.
6. A successful decision is one-shot. Reusing the task ID or grant nonce is a
   replay and is denied.

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

The grant and approval contain public signatures, not the owner's private key.
Treat them as authorization records and do not leave them in a shared writable
directory.

## Device compatibility and boundaries

The wire additions are JSON/Zod schemas and are additive to the existing
`BusinessPayload` discriminator. Bun/Node daemons on macOS, Linux, and Windows
use the same typed messages and native path checks. Existing Android clients
remain protocol-compatible because they can carry the encrypted channel and
ignore unknown business kinds; the initial Android UI does not yet expose Mesh
grant/approval controls.

The relay remains zero-knowledge for Mesh payloads. Codex/Qoder may propose a
task through a future adapter, but the daemon—not the model and not the
relay—owns group membership, signatures, path resolution, execution, and
rollback. Adding a real GPU runner should introduce a new typed executor with
its own sandbox and resource limits; it should not re-enable arbitrary shell.
