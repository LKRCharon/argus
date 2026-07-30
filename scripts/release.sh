#!/usr/bin/env bash
# Build, package, publish a GitHub release, and patch the Homebrew cask.
# Argus (argus). Developer ID signed + notarized + stapled (ADR-0020 §③).
# Ported from the LidAwake-era _archive script.
#
# Usage:
#   scripts/release.sh                      # version from Resources/App-Info.plist
#   REPO=owner/name scripts/release.sh      # override the release host repo
#
# Requirements:
#   - gh authenticated (gh auth status)
#   - Swift toolchain (swiftc)
#   - HEAD is the commit you intend to release (gh release create tags HEAD)
#   - For a user-facing release, the brand icon is wired (Resources/AppIcon.icns)
#
# This does NOT git-tag separately; `gh release create vX` creates the tag at
# the default branch HEAD. Ensure HEAD is pushed first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="${REPO:-LKRCharon/argus}"
CASK="${CASK:-$ROOT/tap/Casks/argus.rb}"
NOTARY_PROFILE="${NOTARY_PROFILE:-argus-notary}"  # xcrun notarytool store-credentials

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/Resources/App-Info.plist")"
APP="$ROOT/build/Argus.app"
ZIP="$ROOT/build/Argus-$VERSION.zip"
TAG="v$VERSION"

echo "==> Releasing Argus $VERSION ($TAG) to $REPO"

echo "==> Building"
"$ROOT/scripts/build.sh"

echo "==> Verifying signature"
if [[ "${ARGUS_SKIP_NOTARIZE:-0}" == "1" ]]; then
  codesign --verify --strict "$APP"   # --deep rejects ad-hoc nested binaries
else
  codesign --verify --deep --strict "$APP"
fi

echo "==> Zipping for notarization (ditto)"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

# ARGUS_SKIP_NOTARIZE=1 publishes an ad-hoc build without notarization or
# stapling — for maintainers without a Developer ID certificate. Gatekeeper
# will warn on first launch; the release notes must say so.
if [[ "${ARGUS_SKIP_NOTARIZE:-0}" == "1" ]]; then
  echo "==> Skipping notarization (ARGUS_SKIP_NOTARIZE=1) — ad-hoc release"
else
  echo "==> Notarizing (notarytool submit --wait, profile: $NOTARY_PROFILE)"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

  echo "==> Stapling the ticket to the app + Gatekeeper assessment"
  xcrun stapler staple "$APP"
  spctl -a -vvv -t install "$APP"

  echo "==> Re-zipping the stapled app for distribution"
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
fi

SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
echo "==> sha256: $SHA"

echo "==> GitHub release $TAG"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$ZIP" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$ZIP" --repo "$REPO" \
    --title "Argus $VERSION" \
    --notes "See CHANGELOG.md. Menu-bar app: keep macOS awake while agents work; sleep safely when conditions degrade."
fi

echo "==> Patching cask $CASK (version + sha256)"
# Replaces the whole sha256 line whether it is currently `:no_check` or quoted.
/usr/bin/sed -i '' \
  -e "s/version \"[^\"]*\"/version \"$VERSION\"/" \
  -e "s/^  sha256 .*/  sha256 \"$SHA\"/" \
  "$CASK"

# Release gate (P3): the sed above must have produced a real digest. If the
# substitution silently no-op'd, or someone hand-publishes a cask still carrying
# the placeholder, `:no_check` skips Homebrew's integrity check entirely — abort
# rather than ship a cask we can't trust.
if grep -q 'sha256 :no_check' "$CASK"; then
  echo "ERROR: cask sha256 still :no_check after patch — aborting release" >&2
  exit 1
fi
# Double safety: confirm the patched cask carries exactly the digest we computed.
if ! grep -q "sha256 \"$SHA\"" "$CASK"; then
  echo "ERROR: cask sha256 does not match computed digest ($SHA) after patch — aborting release" >&2
  exit 1
fi

echo "==> Done."
echo "    Release: https://github.com/$REPO/releases/tag/$TAG"
echo "    Next (manual): copy $CASK into the LKRCharon/homebrew-tap repo under Casks/,"
echo "    commit + push, then verify on a clean account:"
echo "      brew install --cask LKRCharon/tap/argus"
