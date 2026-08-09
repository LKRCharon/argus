# Argus Android companion

The Android client pairs with a user-operated Argus Host through a self-hosted
Agentlink relay. It contains no hosted relay endpoint, analytics credential, or
release-signing material.

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

Run device-only Keystore tests with `scripts/test-device.sh`. Do not use
`connectedDebugAndroidTest`: Android Gradle Plugin uninstalls the app afterwards
and would erase its identity and pairings.

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
