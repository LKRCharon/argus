# AGENTS.md — Argus

Menu-bar keep-awake app for macOS plus its phone companion. Three repos, one
product; read the section for whichever one you are touching.

| Repo | Path | Stack |
|---|---|---|
| Argus (this repo) | `~/proj/eclam` | Swift / AppKit, no SwiftUI, no SPM manifest — `scripts/build.sh` drives swiftc directly |
| Android client | `~/proj/Argus/android` | Kotlin / Compose, Gradle (`./gradlew`) |
| agentlink | `~/Documents/Qoder/2026-07-26/chat-1/agentlink` | TypeScript / Bun workspaces (daemon + wire + relay + PWA) |

Stack is Swift, Kotlin and TypeScript. Do not introduce another language —
including throwaway scripts for editing source. Batch edits belong in the
editing tool, not in a generated `.py` helper: those helpers cost more than they
save (shell quoting eats CJK strings, heredocs mangle quotes, slice-based
deletions cut the wrong range).

---

## Argus (macOS)

### Build, deploy, verify

```bash
ECLAM_SIGN_ID=- ./scripts/build.sh          # -> build/Argus.app
./scripts/test.sh                            # standalone test programs, no XCTest
./scripts/check-i18n.sh                      # key parity + format specifiers across 5 locales
```

The user runs this app for real. After every change:

```bash
pkill -f "Applications/Argus"; sleep 1
rm -rf /Applications/Argus.app && cp -R build/Argus.app /Applications/Argus.app
open /Applications/Argus.app
sleep 12 && pmset -g assertions | grep -i argus   # keep-awake must survive
```

`--open-settings <0..6>` opens a settings pane at launch; grep the log for
`Unable to simultaneously satisfy` to catch constraint conflicts. Zero conflicts
does not mean the layout is right — screenshot it.

### Non-negotiables

- **keep-awake is production behaviour.** The chain is `AgentDetector` →
  `store.update(activeAgents:)` → `scheduleConverge()` → `SafetyPolicy
  .decideKeepAwake` → `ActivityAssertion` (`ProcessInfo.beginActivity`). Never
  gate detector startup behind helper registration, and never let a stale helper
  report write `safetyRelease`.
- **The privileged helper is deprecated** but its code stays: the CLI's timed
  hold and the hook's `pingActivity` still need it. keep-awake itself no longer
  goes through it.
- **Naming**: `ElectronicClam` / `eclam` / `jadhvank` are gone. Exceptions that
  must stay: the XPC protocol name `ElectronicClamHelperProtocol` and the
  `ECLAM_SIGN_ID` build variable.
- Menu bar icon: SF Symbol `link` (asleep) / `link.circle.fill` (awake). No
  sponsorship or donation entry points.

### AppKit specifics that bit us

- `NSTabView` sizes a pane from its **frame**, not constraints. A pane root
  created with `translatesAutoresizingMaskIntoConstraints = false` renders as a
  blank tab. Use `NSView(frame:)` + `autoresizingMask = [.width, .height]`.
- A scroll view's `documentView` must be flipped, or content stacks from the
  bottom and leaves a gap on top.
- A vertical `NSStackView` with `.leading` alignment does not stretch its rows;
  pin `widthAnchor` on anything that draws its own area (tables, charts, cards).
- Never nest scroll views — panes with their own table use `installFixedPage`.
- **Liquid Glass belongs to the functional layer only.** HIG: "Don't use Liquid
  Glass in the content layer." Settings cards use `.contentBackground`.
- Settings windows use `NSToolbar` with `.preference` style (not a sidebar, not
  a hand-rolled segmented control), window title tracks the visible pane, and
  the last pane is restored on reopen.

### i18n

`NSL(key, fallback)` / `NSLf(key, fallback, args…)`. Every new key goes into all
five `.lproj` files in the same change; `check-i18n.sh` must stay green (it also
catches keys referenced in code but missing from `en.lproj`). `relocalize()`
rebuilds every pane — a new pane must be added there too.

### Editing hazards

Deleting a block by start/end markers has already destroyed
`applicationDidFinishLaunching` once: the end marker matched a later copy, the
build still succeeded (optional protocol method), and keep-awake silently died
for ~12 minutes. Prefer unique-context replacements, and after any structural
delete verify the symbol still exists (`grep -c "func applicationDidFinishLaunching"`).

zsh: three consecutive exclamation marks trigger history expansion and hang the
shell at `dquote>`.

---

## Android client

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew assembleDebug
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Installing over USB pops a confirmation on the phone (vivo); a rejected dialog
reports `INSTALL_FAILED_ABORTED: User rejected permissions` — and a failed build
followed by an install can silently leave the *old* APK on the device. Always
confirm the build succeeded before reading install output.

### Design language

Control-center idiom, defined in `ui/theme/Theme.kt` as an `ArgusPalette` token
set with light and dark values: dot-grid canvas, one big rounded sheet as the
working surface, pill-shaped controls only, a single accent colour, status
colours reserved for status. Never hard-code colours in screens.

- Agent switcher lives in the **top bar** (between the status capsule and the
  scan button), icon-only by default with a chevron to reveal names.
- Tool names in the activity feed stay verbatim — no Chinese relabeling. Only
  the argument side is distilled (command / path / query, never the raw blob).
- Long tool chatter folds into a counted `{…} N activities` card; the default
  view shows conclusions, details expand on demand.

### Protocol parity with agentlink

`RelayClient.kt` + `crypto/` must mirror `packages/wire/src/{pairing,crypto,code}.ts`
exactly. Two traps already paid for:

- `transcriptHash` is fed **already-stringified** hellos on the TS side, so the
  value is JSON-serialised twice. Single serialisation makes confirm tags never
  match and pairing always fails with "key confirmation failed".
- `org.json` serialises nested `Map`s via `toString()` (`{v=1, kind=hello}`),
  which the daemon rejects. Deep-convert to `JSONObject`/`JSONArray` before
  sending, and escape control characters (RFC 8259) — multi-line input otherwise
  produces illegal JSON that the daemon drops in silence.

### Compose lifecycle

Use `viewModel()`, not `remember { ViewModel() }` (config changes otherwise wipe
state and leak the old WebSocket). Register activity results through
`activityResultRegistry` when the object is created after `RESUMED` —
`registerForActivityResult` throws there. Connection intent must be explicit
(`userWantsConnection`), or an auto-reconnect effect keyed on
`status == disconnected` undoes every manual disconnect.

---

## agentlink (daemon)

```bash
bun test && bun run typecheck
AGENTLINK_RELAY=wss://relay.limen.codes/ws bun run packages/daemon/src/index.ts watch
```

`AGENTLINK_RELAY` selects the relay (default is localhost, which just fails).
The relay channel holds two members: a stale `watch` process still occupying the
slot makes the next one die with "通道已满" — check `pgrep -f daemon/src/index.ts`
first. Argus spawns the daemon itself; `AgentlinkBridge.preflightError()` probes
for bun and the checkout before spawning.

### Transcript watching

Session events come from polling agent transcripts, never from an API:

| Agent | Path | Notes |
|---|---|---|
| Qoder | `~/.qoder/projects/*/transcript/*.jsonl` | thinking blocks, `tool_use`, user-role `tool_result`, top-level `cwd` |
| Codex | `~/.codex/sessions/*/*/*/rollout-*.jsonl` | `response_item/reasoning`, `custom_tool_call(+output)`, `turn_context.cwd` |

Verify format assumptions against real files before trusting them. Two bugs came
from not doing that: codex turn-done keyed off `turn_ended`, which does not exist
in the format (it is `task_complete` / `turn_aborted`), and both normalizers
dropped thinking, user prompts and tool results — the bulk of what a user wants
to see. Watchers seek to EOF on first scan, so only new events stream; consume
only up to the last newline or a half-written line is lost forever.

The user role carries injected content nobody typed (`# Response annotations:`,
`<system-reminder>`, command output). Filter it or the phone shows text the user
never wrote.

### Qoder hooks

Hook types are `command | runtime | http | prompt | agent`. A `PermissionRequest`
hook must answer with:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow|deny|ask"}}
```

`{"decision":"accept"}` is silently ignored — that is why phone approvals never
reached the IDE. Non-permission events should return `{}`; a bridge observes, it
does not rubber-stamp local decisions. Qoder's Electron main process reads
`~/.qoder/settings.json` at launch, so hook changes need an IDE restart. `-p`
headless runs auto-approve, so they never exercise this path.

Never build a probe that auto-approves permission requests: that hands the agent
a bypass around the user's own confirmation dialog. Observe with `{}` instead.

---

# Known issues

Not fixed, deliberately deferred — do not "discover" these again from scratch.

- **Menu header text and the Keep Mac Awake checkmark can disagree with the
  real keep-awake state** (observed 2026-07-28 while exercising the manual
  toggle). `enabledHeader()` and `toggle.state` are derived from
  `store.manualToggle` / `store.shouldKeepAwake`, while the assertion is owned
  by `ActivityAssertion` after `convergeNow()` — the three can drift apart
  mid-transition, and `manualOverrideOff` (not persisted) makes the header claim
  a state the assertion does not hold. `argus status` is the source of truth
  while debugging. A clean relaunch clears it.
- The phone-approval path is wired but **unexercised**: this machine runs Qoder
  with full permissions, so the IDE never emits `PermissionRequest` at all. A
  hook that never fires is not evidence of a broken hook. Verifying it means
  first switching Qoder back to a mode that asks. What *was* verified: an
  unreachable hook does not block the IDE, so leaving the config registered is
  harmless.
- Codex approvals never reach the phone: the hook path is Qoder-only, and Codex
  has no HTTP hooks — it needs the app-server route.

---

## Working agreements

- No emoji anywhere — code, comments, commit messages, replies.
- Report outcomes honestly: if a step could not be verified (needs a real phone,
  an IDE restart, a 5-minute expiry window), say so instead of implying it was
  tested.
- Handoff and status documents stay out of git (`/HANDOFF-*.md` is ignored) and
  get deleted once the work they describe is done.
- The user's machine is the test bed. Deployments replace a running app and
  daemons keep running in the background — clean up processes you started.
