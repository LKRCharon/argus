#!/bin/bash
# Install only the command-line Android API 35 build surface. Licenses stay interactive.
set -euo pipefail

MODE="${1:-bootstrap}"
if [[ "$MODE" != bootstrap && "$MODE" != --check ]]; then
  echo "usage: $0 [--check]" >&2
  exit 64
fi

SDK_ROOT="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export JAVA_HOME
MIN_FREE_KIB=$((12 * 1024 * 1024))
PACKAGES=(
  "platform-tools"
  "platforms;android-35"
  "build-tools;35.0.0"
)

if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "JDK17_MISSING path=$JAVA_HOME" >&2
  exit 66
fi
java_version="$($JAVA_HOME/bin/java -version 2>&1 | /usr/bin/head -1)"
if [[ "$java_version" != *'"17.'* ]]; then
  echo "JDK17_REQUIRED detected=$java_version" >&2
  exit 66
fi

available_kib="$(/bin/df -Pk "$HOME" | /usr/bin/awk 'NR == 2 {print $4}')"
if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < MIN_FREE_KIB )); then
  echo "ANDROID_DISK_GATE_FAILED available_kib=${available_kib:-unknown} required_kib=$MIN_FREE_KIB" >&2
  exit 75
fi
echo "ANDROID_DISK_GATE_OK available_kib=$available_kib required_kib=$MIN_FREE_KIB"

find_sdkmanager() {
  local candidate
  for candidate in \
    "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" \
    /opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager \
    /opt/homebrew/bin/sdkmanager; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

sdkmanager="$(find_sdkmanager || true)"
if [[ -z "$sdkmanager" && "$MODE" == bootstrap ]]; then
  if [[ ! -x /opt/homebrew/bin/brew ]]; then
    echo "ANDROID_COMMANDLINETOOLS_MISSING_AND_HOMEBREW_UNAVAILABLE" >&2
    exit 69
  fi
  # This cask installs only Google's command-line tools generic artifact. It
  # does not run sdkmanager --licenses or install any licensed SDK package.
  HOMEBREW_NO_AUTO_UPDATE=1 /opt/homebrew/bin/brew install --cask android-commandlinetools
  sdkmanager="$(find_sdkmanager || true)"
fi
if [[ -z "$sdkmanager" ]]; then
  echo "ANDROID_COMMANDLINETOOLS_MISSING"
  exit 69
fi
echo "ANDROID_COMMANDLINETOOLS_READY path=$sdkmanager"

if [[ ! -s "$SDK_ROOT/licenses/android-sdk-license" ]]; then
  echo "NEED_ANDROID_LICENSE sdk_root=$SDK_ROOT"
  exit 20
fi

sdk_complete() {
  [[ -f "$SDK_ROOT/platforms/android-35/android.jar" \
    && -x "$SDK_ROOT/platform-tools/adb" \
    && -x "$SDK_ROOT/build-tools/35.0.0/aapt2" ]]
}

if sdk_complete; then
  echo "ANDROID_API35_READY sdk_root=$SDK_ROOT"
  exit 0
fi
if [[ "$MODE" == --check ]]; then
  echo "ANDROID_API35_PACKAGES_MISSING sdk_root=$SDK_ROOT"
  exit 21
fi

/bin/mkdir -p "$SDK_ROOT"
sdk_log="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/argus-sdkmanager.XXXXXX")"
trap '/bin/rm -f "$sdk_log"' EXIT
if ! "$sdkmanager" --sdk_root="$SDK_ROOT" --install "${PACKAGES[@]}" </dev/null >"$sdk_log" 2>&1; then
  if /usr/bin/grep -Eqi 'license.*not accepted|licenses have not been accepted' "$sdk_log"; then
    echo "NEED_ANDROID_LICENSE sdk_root=$SDK_ROOT"
    exit 20
  fi
  echo "ANDROID_SDK_INSTALL_FAILED"
  exit 70
fi

if ! sdk_complete; then
  echo "ANDROID_API35_VERIFY_FAILED" >&2
  exit 70
fi
echo "ANDROID_API35_READY sdk_root=$SDK_ROOT"
