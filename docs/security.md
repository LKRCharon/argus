# Security & privacy

Argus runs right next to an AI developer's most sensitive files. It sends no
analytics or developer-operated telemetry. Network features are opt-in and use
only endpoints the owner configures: Telegram for notifications and Agentlink
for encrypted traffic between paired devices.

## Local detection and optional transcript forwarding

Local agent detection calls `stat()` on transcript files to read modification
times. When the optional Agentlink bridge is running, its transcript watcher
also reads new transcript records and sends normalized events over the paired,
encrypted device channel. It does not upload them to an Argus analytics service.

## No telemetry, no tracking, no analytics

Telegram is opt-in and sends selected notification content to
`api.telegram.org`. Agentlink connects to the relay URL configured by the owner;
device-channel payloads are end-to-end encrypted and the relay does not receive
their plaintext. Neither path sends analytics to the Argus developer.

## XPC caller verification is enforced

The root helper accepts connections only from our own signed app / CLI / hook, pinned by Team ID and identifier. Even another process under the same account cannot reach the helper.

## Developer ID signed + Apple notarized

Team `GBQ3DN529X`, hardened runtime. Passes Gatekeeper cleanly — no quarantine-strip tricks.

## Tokens stay local

Telegram tokens are stored only in `0600` files on your machine.

## Mesh is a typed, fail-closed boundary

The optional Agentlink Mesh layer does not forward a peer's `cwd`, command, or
natural-language prompt to a local shell or agent. The target resolves an
opaque resource ID from its own configuration and applies group membership,
requester, target, expiry, Ed25519 grant, owner approval, and one-shot replay
checks before invoking a typed executor. Hard delete, `sudo`, secret reads,
deployment, and arbitrary shell are denied in the first release; quarantine is
the reversible destructive substitute. See [docs/mesh.md](mesh.md) for the
configuration and audit model.

## Sleep is always restored on exit or crash

Three layers: synchronous restore on quit, a SIGTERM handler, and a 20-second helper watchdog.

## One permission path

Privilege comes only from `SMAppService`, approved once on first launch. No `sudoers` edits, no system-file changes.
