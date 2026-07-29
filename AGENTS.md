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

## Why the two agents are driven differently

The phone reaches Codex and Qoder through completely different mechanisms. This
is forced by their architectures, not a matter of taste — both were established
by probing the real binaries (2026-07-29).

| | Codex | Qoder |
|---|---|---|
| Core service | `app-server` — **owns** the sessions, `--listen ws://IP:PORT` exposes them | `qoder-ide-server` — the **IDE** serves, the CLI connects to it (`getIdeServerHost` → 127.0.0.1) |
| Session ownership | The server holds threads; any client can `thread/resume` one | The IDE process owns them |
| Protocol | 141 JSON-RPC client methods; `app-server generate-json-schema --out DIR` dumps them | No session protocol; the IDE server only shares editor context |
| Phone route | Speak app-server directly (list / resume / turn / approvals) | Keystroke injection — the only way in |
| Mid-turn control | `turn/steer`, `turn/interrupt` | Not possible; injection cannot reach a running turn |

Both CLIs advertise near-identical commands (`remote-control`, `--teleport`,
`--remote-session`, `--remote`), which makes them look equivalent. They are not.
Qoder's CLI is a Gemini CLI fork (`GEMINI_CLI`, `gemini-ide-server`,
`geminiignore` all appear in the binary) and inherits Gemini's IDE-companion
model: the editor feeds context to the CLI, it does not host shareable sessions.

### Codex app-server specifics

- **`thread/list` needs `sourceKinds`.** Omitted, it returns only "interactive
  sources" and answers with zero rows on a machine full of sessions. Pass
  `["cli", "vscode", "exec", "appServer"]`.
- **The Codex desktop app tags its threads `vscode`, not `appServer`.** The app
  (`/Applications/ChatGPT.app`, bundle id `com.openai.codex`) is a VS Code shell:
  app-server's userAgent carries `vscode/1.106.3` even for a hand-rolled probe,
  and the app ships a `codex_vscode_copilot` originator for the real extension.
  Accurate data — do not filter it out as noise.
- Originator is two-layered: `Codex Desktop` towards the ChatGPT backend,
  `vscode` towards the local app-server, switched by
  `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`.
- The app bundles its own binary at `Contents/Resources/codex` (0.146.0-alpha),
  usually newer than an npm-installed CLI. Prefer it.
- `codex remote-control start` is **not** the way in: it demands a standalone
  install at `~/.codex/packages/standalone/current/codex`, and the feature is
  gated server-side (`isEligible` / `reason` come back over a heartbeat, so most
  accounts see `remoteControl/status/changed: disabled`). `app-server --listen`
  needs neither, which is why Argus drives that instead.
- Approvals arrive as server→client **requests** (`item/*/requestApproval`), so
  they must be answered by id. This is the only approval path that actually
  reaches the phone.

### Qoder session namespaces

`qodercli --list-sessions` shows CLI sessions only; IDE sessions never appear and
there is no filter argument that reveals them (checked — unlike Codex, where the
missing `sourceKinds` was the whole problem). So `--resume` cannot reach the
conversation on screen, and a phone message would otherwise answer in its own
separate session.

**Qoder does speak ACP** — `qodercli --acp` is real but undocumented (absent from
`--help`). It advertises `sessionCapabilities: {list, resume, fork, close,
delete, additionalDirectories}`, image input, prompt queueing and genuine
`session/request_permission` calls. Tempting, but tested: `session/list` returns
only sessions the CLI created itself — the live IDE session is still absent. ACP
resumes *its own* pool, so it does not replace keystroke injection. It is however
a better foundation than `qodercli -p` for phone-started sessions, since it
carries real approvals.

Read `packages/daemon/test/fixtures/` before reverse-engineering either agent:
`fake-codex-appserver.ts` and `fake-qoder-acp.ts` have been in the repo since the
project started and document both protocols' message shapes. They are also where
the `turn/completed` payload shape (`params.turn.id`, *not* `params.turnId`) is
pinned down — reading the wrong field leaves turns started outside the daemon
unsteerable and uninterruptible.

---

# Hard-won lessons

Each of these cost real debugging time or shipped a broken behaviour. They are
not general programming advice — every line is something this codebase got wrong.

## Cross-repo contracts

These must be changed in lockstep or the phone silently drops data.

**Channel message kinds.** Adding or renaming a kind means editing three places:
`serve.ts` (send/receive), `RelayClient.kt` (`when` branch *and* a sender), and
this list. A kind that only one side knows about is a bug, not a feature flag.

- daemon → phone: `agent-event`, `input-ack`, `permission-request`,
  `session-list`, `codex-thread-list`, `codex-resumed`, `codex-event`,
  `codex-error`, `cloud-session-url`
- phone → daemon: `user-input`, `permission-response`, `list-sessions`,
  `new-session`, `remote-control`, `cloud-session`, `codex-threads`,
  `codex-resume`, `codex-input`, `codex-interrupt`

**`agent-event.event` type enum — the phone renders nothing else:**
`text{text}`, `user-text{text}`, `thinking{text}`, `tool-call{name, summary}`,
`tool-result{name, summary}`, `turn-done{reason}`, `error{message}`.
Every producer (transcript normaliser, ACP mapping, any future agent) must emit
exactly these. Inventing synonyms (`agent-text`, `tool-use`) made an entire
feature look implemented while the phone discarded every reply. Error text lives
in `message`, not `text`.

**Session id per agent:**
- Qoder IDE task: transcript basename minus `.jsonl`
- Qoder ACP: the uuid from `session/new`
- Codex: **the app-server threadId, i.e. the trailing uuid of
  `rollout-<timestamp>-<threadId>.jsonl`** — never the whole basename. Using the
  basename gave every Codex session two ids: two cards on the phone, and the one
  with the content could not accept input because `thread/resume` rejects it.

**requestId prefixes route approvals:** `hook-` / `acp-` / `codex-`. A new
approval source needs a new prefix. `optionId` is passed through untouched by the
phone — hook and Codex use `allow`/`deny`, ACP uses its native
`proceed_once`/`proceed_always`/`cancel`.

**Codex turn state:** daemon's `activeTurns` cleanup set and the phone's
"mark done" set must match: `turn/completed`, `turn/aborted`, `turn/failed`.
A turn interrupted on the desktop ends as `aborted`, and a stale id wedges every
later message into a steer that cannot succeed.

---

## macOS (Swift/AppKit)

- `scripts/build.sh` passes no `-swift-version`, so Swift 6.3 compiles in **Swift 5
  mode with data-race diagnostics off**. Compiling clean says nothing about
  concurrency safety.
- Before touching `self.process`, check `proc === self.process`. On a quick
  stop→start the old process exits *after* the new one is stored; clearing
  unconditionally orphans the new daemon and spawns a third.
- The `asyncAfter` SIGKILL fallback in `stop()` needs its own identity check — it
  does not go through `terminationHandler`, so fixing one does not fix the other.
- `FileHandle.readabilityHandler` must be set to nil on EOF (empty data), or the
  handler and everything it captured survive every daemon restart.
- `NSPasteboard.general` is "one thread at a time" (Apple's Thread Safety
  Summary). The injection queue and any UI copy button must not touch it
  concurrently.
- macOS 14 activation is **cooperative**: `activate()` is a request the system may
  refuse. Verify `frontmostApplication` before posting CGEvents, or the keystrokes
  land in whatever app is actually in front — pasting a prompt into a terminal and
  pressing Return.
- Convergence logic that does not need the helper must run **before**
  `guard case .enabled = store.registration`. On a machine without an approved
  helper, everything after that guard never executes — which is how
  `manualOverrideOff` could never clear itself.
- `registerIfNeeded` blocks up to ~16s on its `.enabled` path (2×3s XPC probe +
  10s re-register loop). Never call helper setup from the launch main thread.
- `Process.launchPath` / `launch()` are deprecated (macOS 27). Use
  `executableURL` + `run()`.

## Android (Kotlin/Compose)

- Encrypted storage goes through `KeyVault` (AndroidKeyStore AES-256-GCM),
  because Google deprecated every `security-crypto` API in 1.1.0 — its final
  release — with the guidance "use Android Keystore directly". Tink is not needed
  for one seal/open primitive. The old dependency stays only for the one-time
  migration in `IdentityStore`; do not build anything new on it.
- Writing encrypted data: `.tmp` then `renameTo`. `EncryptedFile` refused to
  overwrite, which is what forced the old delete-then-write dance, and an
  interrupted write left a truncated file that fails to decrypt and gets deleted
  — losing everything.
- Changing this layer requires the instrumented tests
  (`./gradlew connectedDebugAndroidTest`): `AndroidKeyStore` has no JVM
  implementation, so a unit test only proves it compiles, and a mistake here
  silently costs the user their identity and pairings.
- `EncryptedSharedPreferences.create` throws on a restored device — the Keystore
  key does not travel with a backup. Guard it and keep `allowBackup="false"`, or
  the app crash-loops after a phone migration.
- Debounced disk writes that reset on every event never fire during a burst,
  which is exactly when the data matters. Always pair a debounce with a maximum
  delay.
- `clientSeq` / `relayClient` are read and written by the main thread, IO
  coroutines and the OkHttp reader. Do not extend the reconnect logic without
  making that access single-threaded.
- Kotlin 2.0.20+ enables strong skipping, which compares unstable params by
  `===`. Returning a fresh `List` with identical contents from a hot path (e.g.
  `buildFeed`) defeats it and recomposes everything downstream.
- `LazyColumn` without stable keys: the 500-event cap shifts indices, and
  `remember`ed expand state migrates to a different card.
- `RelayClient.send*` returns silently when `chan == null`. Messages sent during a
  reconnect vanish while the echo bubble spins forever.
- Overlays render inside `MainSheet` only, so setting `overlay` while the detail
  screen is open does nothing visible until the user navigates back.

## relay

- Buffered frames must record **which side** queued them. Draining the buffer to
  whoever joins next hands a reconnecting client its own backlog, and since
  delivery empties the buffer, the real recipient never sees it.
- Neither object identity nor IP identifies a side: a reconnect is a new object,
  and both peers are 127.0.0.1 in tests / share an address behind one NAT. Assign
  a free slot on join and release it on close.
- `join-chan` needs the same rate limit as `join-pair`, and the sweep must delete
  empty channels — otherwise any client can mint unbounded permanent `Chan`
  objects with random tokens.

## agentlink (TypeScript/Bun)

- Every async producer must send through the one serialising chain. Sealing is
  async, so parallel sends deliver streamed text out of order — the chain
  originally covered only the transcript path.
- Caching a client instance across a socket close means every later call fails
  forever. Re-run `start()` (it is a no-op while connected) instead of returning
  the cached object.
- `readFileSync` then slicing reads the *whole* file first. 313 transcripts /
  460MB were read synchronously on every list refresh; `openSync` + `readSync` of
  the first 256KB plus an mtime-keyed title cache took it from ~100ms to ~5ms.
- ACP: each session is a live child process. Cap the pool, drop entries when the
  agent exits, and kill them all in `stop()`.
- ACP: a session whose agent has died must be refused explicitly. Falling through
  to keystroke injection runs the prompt in whatever conversation the IDE has
  open, and reports success.
- An `initialize` timeout leaves a live process behind a permanently rejected
  `ready` promise. Kill the process on failure so the caller can retry.

---

# Known issues

Not fixed, deliberately deferred — do not "discover" these again from scratch.

- **Menu header text and the Keep Mac Awake checkmark can disagree with the
  real keep-awake state** (observed 2026-07-28 while exercising the manual
  toggle). Half of this is now fixed: the `manualOverrideOff` auto-clear ran
  after the helper guard, so on a machine without an approved helper it never
  cleared at all. What remains is presentational — `enabledHeader()` and
  `toggle.state` derive from store fields while the assertion is owned by
  `ActivityAssertion`, so the three can still read differently mid-transition,
  and `manualOverrideOff` is not persisted across a relaunch. `argus status` is
  the source of truth while debugging.
- The phone-approval path is wired but **unexercised**: this machine runs Qoder
  with full permissions, so the IDE never emits `PermissionRequest` at all. A
  hook that never fires is not evidence of a broken hook. Verifying it means
  first switching Qoder back to a mode that asks. What *was* verified: an
  unreachable hook does not block the IDE, so leaving the config registered is
  harmless.
- Qoder cannot be steered or interrupted mid-turn from the phone. Injection puts
  text in the input box; it cannot reach a turn that is already running. Codex
  can, via `turn/steer` / `turn/interrupt`.

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
