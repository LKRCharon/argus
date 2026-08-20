# Argus Android app

The APK contains two launchable modes:

- **Argus** pairs with a user-operated Argus Host through a self-hosted
  Agentlink relay.
- **手机 Agent** is a standalone file agent. It calls a configured
  Responses-compatible HTTPS endpoint directly from Android and does not start
  or require an Argus Host connection.

The source tree contains no API key, analytics credential, hosted relay
endpoint, or release-signing material.

## Build

Use JDK 17 and an Android SDK with API 35 installed:

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
./gradlew assembleDebug
```

Install a locally built debug APK without clearing pairing data:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug builds use the `com.kairong.argus.debug` application ID, so they can be
installed beside the signed release app without replacing its identity or
pairings. To avoid duplicate launcher clutter on a development phone, the debug
APK exposes only the green **手机 Agent** launcher; `MainActivity` remains
available to Argus pairing deep links and direct development launches.

Run device-only Keystore tests with `scripts/test-device.sh`. Do not use
`connectedDebugAndroidTest`: Android Gradle Plugin uninstalls the app afterwards
and would erase its identity and pairings.

## Standalone phone Agent

Open **手机 Agent**, then:

1. In LimenAPI settings, keep `https://api.limen.codes` and
   `gpt-5.6-luna`, and enter the API key once.
2. Tap **授权** once and enable all-files access for the app in Android
   Settings.
3. Ask the Agent to list, read, write, or extract files anywhere under the
   primary shared-storage root, `/storage/emulated/0`.

The history button opens a newest-first, read-only list of the JSONL
conversations. Selecting a row renders user and assistant messages, tool paths,
approval outcomes, tool results, and recorded errors without modifying the log.

The API key is sealed with Android Keystore before it is persisted. Prompts and
file content returned by read tools are sent to the configured model endpoint;
file operations themselves run inside the app. Writing and ZIP extraction need
an explicit confirmation in the UI.

Relative paths resolve from `/storage/emulated/0`. Absolute paths are accepted
only when their canonical path remains under that root; traversal and symbolic
link escapes are rejected. Android system partitions, other apps' private
storage, and platform-restricted parts of `Android/data` remain unavailable
without root.

Every conversation is stored as JSONL in the fixed directory
`/storage/emulated/0/Documents/PhoneAgent/conversations`. Records include user
and assistant messages, complete tool calls, approval decisions, tool results,
and errors. The configured API key is redacted and is never written to these
files. Agent tools cannot overwrite the conversation or extraction-transaction
directories.

`MANAGE_EXTERNAL_STORAGE` is intended for sideloaded/private builds of this
file-management Agent. Google Play restricts this permission to eligible core
file-management use cases and may reject a general-purpose distribution that
does not satisfy its all-files-access policy.

## Relay configuration

Deploy your own relay using [`../agentlink/deploy/`](../agentlink/deploy/), then
enter its `wss://` address in the app Settings page or include it in an Argus
pairing QR link. A public build deliberately starts with no default endpoint.

For a private local build only, provide an endpoint outside version control:

```bash
ARGUS_RELAY_URL=wss://relay.example/ws ./gradlew assembleDebug
```

Never publish a build configured with a private relay address unless that address
is intended to be public. Local SDK paths, build output, signing keys, and
credential files are ignored by Git.
