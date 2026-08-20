# MarkSec delegation gateway

The delegation gateway accepts structured work requests from another Codex,
runs Codex against a disposable MarkSec snapshot, and returns a bounded
acceptance report. It never turns request fields into an executable, shell
fragment, working directory, environment variable, verification command, or
deployment command.

## Security boundary

- The public URL contains a random 32-byte path secret and also requires a
  separate 32-byte Bearer token.
- A token grants named project IDs and modes only. The token digest, rather
  than the plaintext token, is stored in the owner config.
- MarkSec is copied into a private per-job workspace. The live source tree is
  not mounted writable and is never used as Codex's working directory.
- Codex command execution has network disabled and can see only minimal system
  paths plus the disposable workspace. It cannot read SSH keys, other repos,
  the Argus state directory, or its own authentication file.
- Verification commands are fixed in the owner policy and run in a second
  bubblewrap sandbox. Callers cannot supply commands or arguments.
- `publish` only creates an approval-required result. No production write,
  service restart, DNS change, or Git push is performed until a separate,
  fixed owner-side publisher is configured.

The initial Seoul policy enables only `inspect` and `change`. Keep `publish`
disabled until that fixed publisher exists and binds an approval to exact
source and patch hashes.

## Seoul files

Keep policy, tokens, job state, Codex authentication, workspaces, and source in
separate roots:

```text
/var/lib/argus-delegation/config.json
/var/lib/argus-delegation/jobs.json
/var/lib/argus-delegation/codex-home/{auth.json,config.toml}
/var/lib/argus-delegation/work/marksec
/var/cache/argus-delegation/current
/home/ubuntu/proj/MarkSec
```

Use [`delegation.example.json`](delegation.example.json) as the policy template
and [`codex-delegation-config.toml`](codex-delegation-config.toml) as the
dedicated Codex policy. All state/config files must be mode 0600 and their
parent directories mode 0700. Do not reuse a normal interactive Codex home;
copy only `auth.json` into this dedicated directory and never print it.

Set these values through a root-owned environment file, not
the committed systemd unit:

```bash
AGENTLINK_DELEGATION_CONFIG=/var/lib/argus-delegation/config.json
AGENTLINK_DELEGATION_JOURNAL=/var/lib/argus-delegation/jobs.json
ARGUS_DELEGATION_CODEX_HOME=/var/lib/argus-delegation/codex-home
ARGUS_DELEGATION_PUBLIC_PATH=/d/<64-lowercase-hex-characters>
ARGUS_DELEGATION_PUBLIC_ORIGIN=https://relay.limen.codes
```

The dedicated service runs as `argus-delegate` on `127.0.0.1:8792`, separate
from the Mesh console on 8790. Its systemd namespace exposes only the release
tree, the fixed Codex binary, a read-only MarkSec source, and its private
writable state root. Expose only the secret path on the existing TLS virtual
host; never proxy `/api/`, `/delegate`, or the root console publicly:

```nginx
limit_req_zone $binary_remote_addr zone=argus_delegation:10m rate=120r/m;

location ^~ /d/ {
    limit_req zone=argus_delegation burst=30 nodelay;
    limit_except GET POST { deny all; }
    proxy_pass http://127.0.0.1:8792;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Idempotency-Key $http_idempotency_key;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 32k;
    proxy_connect_timeout 3s;
    proxy_read_timeout 45s;
    proxy_send_timeout 45s;
    proxy_request_buffering on;
    proxy_buffering on;
    access_log off;
    error_log /var/log/nginx/argus-delegation-error.log crit;
}
```

The application still compares the complete configured path. Nginx forwarding
`/d/` is not an authentication decision.

Install [`argus-delegation.service`](argus-delegation.service) rather than
adding these privileges to `argus-control.service`. The separate system user
cannot write the live source tree, and systemd kills the whole worker cgroup on
restart. Pin the Codex package version and record the resolved executable's
SHA-256 during installation.

[`argus-delegation-snapshot.service`](argus-delegation-snapshot.service)
runs as root with fixed source/cache arguments. It excludes credentials,
datasets, runtime state, dependencies, and build outputs; rejects links and
special files; hashes the file manifest; seals files root-owned and read-only;
then atomically switches `/var/cache/argus-delegation/current`. The unprivileged
gateway can read that mirror but cannot see `/home/ubuntu/proj/MarkSec` at all.
The accompanying timer refreshes it every five minutes and retains three
complete snapshots.

## External API

Submit one job with a stable idempotency key:

```http
POST /d/<path-secret>/jobs
Authorization: Bearer <principal-token>
Idempotency-Key: <stable-request-id>
Content-Type: application/json

{
  "projectId": "marksec",
  "mode": "change",
  "goal": "修复 MarkSec 首页的链接并给出验收证据",
  "acceptance": ["目标链接返回预期页面"],
  "baseRevision": "current",
  "domain": "marksec.limen.codes"
}
```

Poll or cancel only jobs owned by the same token:

```http
GET  /d/<path-secret>/jobs/<job-id>
GET  /d/<path-secret>/jobs/<job-id>/patch
POST /d/<path-secret>/jobs/<job-id>/cancel
```

Authentication failures are intentionally indistinguishable. Reusing an
idempotency key with different content is rejected. Job responses contain
relative changed paths, bounded check summaries, hashes, and the acceptance
report; they never contain credentials, raw environment values, or arbitrary
process output.

## Owner console

Forward the loopback service and open the delegation page:

```bash
ssh -N -L 8792:127.0.0.1:8792 seoul
```

Open `http://127.0.0.1:8792/delegate`. The page shows queue and runner health,
reports, changed files, approvals, and token revocation. New token plaintext is
shown once and is not recoverable from the stored config.
