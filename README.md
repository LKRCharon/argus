<div align="center">

<img src="docs/assets/argus-icon.png" width="120" alt="Argus" />

# Argus

**Keep your Mac awake while coding agents work — sleep safely when they stop.**

[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-black?logo=apple)](https://www.apple.com/macos/)
[![Language](https://img.shields.io/badge/Swift-AppKit%20%2B%20SwiftUI-orange?logo=swift)](https://swift.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Status](https://img.shields.io/badge/status-v0.7.3-yellow)](CHANGELOG.md)

<!-- i18n-langbar -->
**English** · [한국어](README.ko.md) · [中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md)

</div>

---

## What it does

Argus sits in your menu bar and prevents macOS from sleeping — but only when there is real work happening. It watches coding agent transcripts for fresh output, holds the Mac awake while they produce, and releases the hold when they go idle. Safety guards step in if temperature or battery gets dangerous.

No cloud, no telemetry, no reading your code or conversations — only file timestamps.

## Features

- **Agent-aware detection.** Watches transcript timestamps (not contents) for Claude Code, Codex, Cursor, opencode, Antigravity, and any custom agents you add via `~/.config/argus/traces.d/*.json`.
- **Strict and Lax modes.** Strict releases the hold when the agent stops writing; Lax holds as long as the process is alive.
- **Safety guards.** Auto-sleeps on low battery, high temperature, or a max-duration cap. Desktop mode (AC + lid open + external display) skips the cap.
- **Remote-activity awareness.** Won't sleep while you have an SSH, screen sharing, or Tailscale session.
- **Codex quota monitor.** Reads your plan usage from local transcripts and shows it in the Monitor window.
- **Telegram notifications (opt-in).** Pings your bot when the Mac sleeps or wakes.
- **CLI.** `argus on/off/status/watch/session/debug/repair/help` — drive it without the GUI.
- **Android companion.** Pair via QR code, monitor agent status and control sessions from your phone.
- **Mesh task boundary.** Pair trusted devices into explicit groups, discover named resources/runners, and route typed, auditable tasks to another machine; v0 supports bounded inspect, named local runners, and reversible quarantine, never remote arbitrary shell or hard delete. See [`docs/mesh.md`](docs/mesh.md).
- **Privacy-first.** Reads file clocks only. No analytics, no tracking, no network calls except your own Telegram bot and optional relay.

## Install

```bash
brew install --cask LKRCharon/tap/argus
open /Applications/Argus.app
```

Then enable **Argus Helper** in **System Settings > General > Login Items & Extensions**.

Or build from source:

```bash
ARGUS_SIGN_ID=- ./scripts/build.sh
open build/Argus.app
```

The Android companion APK is available in [Releases](https://github.com/LKRCharon/argus/releases).

Its source lives in [`android/`](android/). The public build contains no relay
endpoint: deploy your own relay, then enter its `wss://` address in the app
Settings page or scan a pairing QR link that provides it. See
[`android/README.md`](android/README.md) for build and device-test instructions.

The phone companion requires a self-hosted relay server. See `agentlink/deploy/` for a ready-made systemd + nginx + Let's Encrypt setup — any VPS with a domain will do. Once deployed, enter your relay's `wss://` address in **Settings > Remote Sync**. The daemon source lives in the `agentlink/` directory of this repo and starts automatically when configured.

For cross-device task coordination, configure one local `mesh.json` per target
machine and run the `agentlink watch` bridge. The Mesh boundary is opt-in and
fails closed when its group, resource, signing, or audit configuration is
invalid. See [`docs/mesh.md`](docs/mesh.md) for the first-release workflow.

## Usage

**Click** the menu bar icon to open the menu.

| Item | What it does |
|---|---|
| Status header | Current state at a glance |
| **Keep Mac Awake** (Cmd+K) | Toggle manual keep-awake |
| **Watch Agents** | Enable/disable agent detection per agent |
| **Monitor...** | Open the dashboard (thermal, agents, Codex quota, remote) |
| **Blank screen — keep working** | Sleep displays but keep agents running |
| **Settings...** (Cmd+,) | Full settings |
| **Quit** (Cmd+Q) | Quit (restores sleep first) |

The icon has three states: outline shell (asleep), filled + bolt (you toggled it on), filled + remote (automatic hold).

### CLI

```
argus on [--for <dur>] [--forever]
argus off
argus status [--json]
argus repair
argus keep --while <pid>
argus watch <agent> [--grace s] [--check-interval s] [--max min] [--json]
argus session start <name> / stop <name> / list [--json]
argus monitor
argus debug [agents] [--json]
argus help
```

## Security

- Reads file clocks, not file contents.
- No telemetry, no tracking.
- XPC caller verification enforced.
- Sleep always restored on exit or crash.
- See [docs/security.md](docs/security.md) for details.

## Tech stack

- Swift + AppKit + SwiftUI (menu bar `LSUIElement` app)
- IOKit SPI for sleep control (`IOPMSetSystemPowerSetting`)
- `SMAppService` privileged helper over `NSXPCConnection`
- Direct `swiftc` build, no SPM, no external dependencies
- arm64 only, macOS 13+ (Ventura)

## Origins

Argus began as a fork of [jadhvank/eclam](https://github.com/jadhvank/eclam) (Electronic Clam) and has since been rebranded and extended.

## License

[MIT](LICENSE).
