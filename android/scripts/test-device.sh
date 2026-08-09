#!/usr/bin/env bash
# Run the instrumented tests without losing the app's data.
#
# `./gradlew connectedDebugAndroidTest` uninstalls the app when it finishes, and
# AGP exposes no way to turn that off (issuetracker 37077961). For an app whose
# whole state is a device identity and its pairings, that means every test run
# silently costs a re-pair. Installing both APKs and calling `am instrument`
# directly does the same work and leaves the data alone.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export JAVA_HOME ANDROID_HOME
ADB="$ANDROID_HOME/platform-tools/adb"

if [ -z "$("$ADB" devices | sed -n '2p')" ]; then
  echo "no device connected" >&2
  exit 1
fi

echo "==> building"
./gradlew assembleDebug assembleDebugAndroidTest --console=plain -q

echo "==> installing (keeping existing data)"
"$ADB" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

echo "==> running tests"
# `-w` waits for completion and prints the summary; a non-zero exit needs the
# output scanned, because am instrument reports failures in its text.
OUTPUT=$("$ADB" shell "am instrument -w com.kairong.argus.test/androidx.test.runner.AndroidJUnitRunner" 2>&1 | tr -d '\r')
echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "^OK ("; then
  echo "==> all tests passed; app and its data left in place"
else
  echo "==> tests failed" >&2
  exit 1
fi
