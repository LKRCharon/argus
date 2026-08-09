# AGENTS.md — Argus Android client

Full guidance for all Argus components lives in the repository root:
[`../AGENTS.md`](../AGENTS.md) — read it before changing anything here.

Quick reference for this repo:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew assembleDebug
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- Stack is Kotlin + Compose. Do not add another language, not even for
  throwaway edit scripts.
- Colours come from the `ArgusPalette` token set in `ui/theme/Theme.kt` (light +
  dark); never hard-code them in screens.
- `data/RelayClient.kt` and `crypto/` must mirror agentlink's
  `packages/wire/src/{pairing,crypto,code}.ts` exactly — read the protocol
  parity notes in the main AGENTS.md before touching the handshake.
- Confirm `assembleDebug` succeeded before trusting `adb install` output: a
  failed build plus a successful install means the old APK is still on the phone.
