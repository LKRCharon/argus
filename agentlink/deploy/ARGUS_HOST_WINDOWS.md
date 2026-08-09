# Argus Host on Windows

This launcher turns a Windows machine into an encrypted Agentlink host for the
Android companion. It does not expose Codex or the daemon to the network: the
host makes an outbound relay connection, and the relay only carries encrypted
frames.

## Prerequisites

- Windows 10 or later with PowerShell 5.1 or PowerShell 7.
- Bun. `winget install --id Oven-sh.Bun --exact` is sufficient.
- A native Codex CLI executable for Codex session controls. A Microsoft Store
  app resource is not usable as a child process. Install the official CLI with
  `npm install -g @openai/codex`, or set `CODEX_BIN` to the native `codex.exe`.
- The Android Argus companion.

The launcher persists identity and paired-device keys in
`%LOCALAPPDATA%\Argus\agentlink`, outside the repository.

## Local Windows-to-Android test

Use an isolated local relay only for a USB/ADB test. It is plain `ws://`, so do
not expose it on a LAN or the public internet.

Terminal A, from `agentlink/`:

```powershell
bun run packages/relay/src/index.ts
```

Terminal B, from `agentlink/`:

```powershell
$env:AGENTLINK_RELAY = "ws://127.0.0.1:8787/ws"
$env:CODEX_BIN = "C:\path\to\codex.exe"
.\deploy\argus-host.ps1 pair --watch
```

Before opening the Android companion, bind its loopback port to Windows:

```powershell
adb reverse tcp:8787 tcp:8787
```

In the companion's Remote Sync settings, use `ws://127.0.0.1:8787/ws`, then
enter the pairing code printed by the host. A successful pairing immediately
starts `watch`; the phone should show the Windows device name and connection
status.

## Remote use

For normal use, the launcher connects to the Argus production relay at
`wss://relay.limen.codes/ws`. Set `AGENTLINK_RELAY` before running the launcher
only when you need to override it with another `ws://` or `wss://` endpoint.
Never publish the local Codex app-server port. Pairing keys and business
payloads are end-to-end encrypted, but the relay hostname and availability are
still observable.

## Later starts

Once paired, run:

```powershell
.\deploy\argus-host.ps1 watch
```

Set `AGENTLINK_DEVICE_NAME` when the hostname is not meaningful on the phone.
