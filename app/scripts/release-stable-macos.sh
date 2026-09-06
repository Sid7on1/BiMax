#!/usr/bin/env bash
set -euo pipefail

# Credential-gated stable path. It intentionally cannot fall back to ad-hoc signing or a manual
# alpha: every missing fact exits before a distributable is produced.
arch="${1:-}"
case "$arch" in arm64|x64) ;; *) echo "usage: $0 arm64|x64" >&2; exit 2 ;; esac

for name in CSC_LINK CSC_KEY_PASSWORD APPLE_NOTARY_KEY_PATH APPLE_NOTARY_KEY_ID APPLE_NOTARY_ISSUER_ID; do
  [ -n "${!name:-}" ] || { echo "missing stable-release credential: $name" >&2; exit 1; }
done
[ -f "$APPLE_NOTARY_KEY_PATH" ] || { echo "notary API key does not exist: $APPLE_NOTARY_KEY_PATH" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

npm run build
BIMAX_RELEASE_BUILD=1 bash scripts/prepare-engine.sh "darwin-$arch"
# Computer Use staging removed 2026-09-04 — see build-local-mac.sh for the reasoning. Nothing in
# electron-builder.yml ships what prepare-native.sh produced.

# --dir creates the signed app first, allowing the notarization ticket to be stapled to the actual
# app before the DMG is assembled. electron-builder imports/signs using CSC_LINK.
npx electron-builder --mac --"$arch" --dir
if [ "$arch" = arm64 ]; then app_bundle="$root/release/mac-arm64/Bimax.app"; else app_bundle="$root/release/mac/Bimax.app"; fi
[ -d "$app_bundle" ] || { echo "signed app missing: $app_bundle" >&2; exit 1; }

# Every nested executable the code-only app actually ships. The five Computer Use binaries and
# the XPC service that used to be listed here have not been packaged since the 2026-09-02 reset,
# so this loop failed on "missing owned nested executable" before it could check anything real.
owned=(
  "$app_bundle/Contents/MacOS/Bimax"
  "$app_bundle/Contents/Resources/engine/bimax-engine"
)
team=""
for item in "${owned[@]}"; do
  [ -e "$item" ] || { echo "missing owned nested executable: $item" >&2; exit 1; }
  details="$(codesign --display --verbose=4 "$item" 2>&1)"
  authority="$(sed -n 's/^Authority=//p' <<<"$details" | head -n 1)"
  nested_team="$(sed -n 's/^TeamIdentifier=//p' <<<"$details" | head -n 1)"
  [[ "$authority" == Developer\ ID\ Application:* ]] || { echo "not Developer ID signed: $item" >&2; exit 1; }
  [ -n "$nested_team" ] && [ "$nested_team" != "not set" ] || { echo "missing TeamIdentifier: $item" >&2; exit 1; }
  if [ -z "$team" ]; then team="$nested_team"; elif [ "$team" != "$nested_team" ]; then echo "nested signing team mismatch: $item" >&2; exit 1; fi
done
codesign --verify --deep --strict --verbose=2 "$app_bundle"

notary_args=(--key "$APPLE_NOTARY_KEY_PATH" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
zip="$root/release/Bimax-$arch-notary.zip"
ditto -c -k --keepParent "$app_bundle" "$zip"
xcrun notarytool submit "$zip" "${notary_args[@]}" --wait
xcrun stapler staple "$app_bundle"
xcrun stapler validate "$app_bundle"
spctl --assess --verbose=4 --type execute "$app_bundle"

# Build the DMG only from the already-notarized app, then notarize/staple the outer container too.
npx electron-builder --mac dmg --"$arch" --prepackaged "$app_bundle"
dmg="$(find "$root/release" -maxdepth 1 -type f -name "Bimax-*.dmg" -print | sort | tail -n 1)"
[ -f "$dmg" ] || { echo "DMG missing after packaging" >&2; exit 1; }
xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --verbose=4 --type install "$dmg"
echo "stable release qualified locally: $dmg (team $team)"
