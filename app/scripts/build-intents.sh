#!/usr/bin/env bash
# Builds the App Intents extension (native/intents/BimaxIntents.swift) into
# intents/BimaxIntents.appex, which electron-builder embeds at Contents/PlugIns/.
#
# Record 57, WP-9 step 3. The gate for it (scripts/check-app-actions.mjs) was written FIRST, on
# purpose: the documented failure for a non-Swift host app is that the intents compile and the
# metadata is never copied into the bundle, so macOS discovers nothing and the build stays green.
#
# Two things this has to get right, and both have bitten this repository before:
#
#   1. The Xcode LICENSE GATE. Every Xcode update resets it, and until someone runs
#      `sudo xcodebuild -license` every `xcrun` through /Applications/Xcode.app refuses. The voice
#      helper already solved this by falling back to the Command Line Tools toolchain, which has
#      its own swiftc and no such gate. Same fallback here — with one wrinkle: the App Intents
#      METADATA PROCESSOR ships only with Xcode, not with the Command Line Tools. It is a plain
#      binary and is NOT license-gated, so it is invoked directly by path rather than through xcrun.
#
#   2. Metadata.appintents is the deliverable, not the binary. A .appex whose Swift compiled
#      perfectly and whose metadata is missing is invisible to macOS. This script fails if the
#      processor produced nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"
if [ "$(uname)" != "Darwin" ]; then
  echo "app intents: skipped (macOS only)"
  exit 0
fi

# ABSOLUTE, deliberately. The metadata processor matches the source paths recorded inside the
# swiftconstvalues file against --source-file-list by string, so a relative path at compile time and
# an absolute one in the list produce "Unable to find matching source file" and export nothing.
SRCDIR="$(cd .. && pwd)/native/intents"
# Every .swift in the directory, sorted so the build is reproducible. Adding an entity or an intent
# is a new file, never an edit to this script.
SOURCES=()
while IFS= read -r f; do SOURCES+=("$f"); done < <(find "$SRCDIR" -name '*.swift' | sort)
[ ${#SOURCES[@]} -gt 0 ] || { echo "app intents: FAILED — no sources in $SRCDIR" >&2; exit 1; }
MODULE="BimaxIntents"
BUNDLE_ID="ai.bimax.app.intents"
# macOS 13 is the app's floor and is also where App Intents arrived, so the extension's floor
# matches the app's exactly — no build where one loads and the other does not.
DEPLOY="13.0"
TARGET="$ARCH-apple-macos$DEPLOY"

OUT="intents/$MODULE.appex"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

# ── toolchain ────────────────────────────────────────────────────────────────────────────────
# Prefer Xcode; fall back to the Command Line Tools when the license gate refuses, exactly as
# build-voice.sh does. Resolve the SDK from whichever toolchain we end up using.
DEVDIR="$(xcode-select -p 2>/dev/null || echo /Library/Developer/CommandLineTools)"
if ! DEVELOPER_DIR="$DEVDIR" xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1; then
  echo "app intents: Xcode toolchain refused (license not accepted); using Command Line Tools"
  DEVDIR=/Library/Developer/CommandLineTools
fi
SDK="$(DEVELOPER_DIR="$DEVDIR" xcrun --sdk macosx --show-sdk-path)"
PROTOCOLS="$(cd scripts && pwd)/appintents-protocols.json"
SWIFTC="$DEVDIR/usr/bin/swiftc"
[ -x "$SWIFTC" ] || SWIFTC="$(DEVELOPER_DIR="$DEVDIR" xcrun -f swiftc)"

# ── compile ──────────────────────────────────────────────────────────────────────────────────
# -emit-const-values-path produces the swiftconstvalues file the metadata processor reads to find
# the AppIntent conformances. Without it the processor exports NOTHING and the extension ships
# exposing no actions — precisely the silent failure this whole work package exists to prevent.
#
# -wmo is REQUIRED for it. Measured: without whole-module optimization swiftc accepts
# -emit-const-values-path, exits 0, and writes no file at all — the flag is silently ignored. The
# metadata processor then fails on the missing input, which is the only reason this was caught.
CONSTVALUES="$WORK/$MODULE.swiftconstvalues"
"$SWIFTC" \
  -O -wmo -swift-version 5 -parse-as-library \
  -target "$TARGET" -sdk "$SDK" \
  -module-name "$MODULE" \
  -emit-const-values-path "$CONSTVALUES" \
  -Xfrontend -const-gather-protocols-file -Xfrontend "$PROTOCOLS" \
  -framework AppIntents -framework AppKit \
  -o "$OUT/Contents/MacOS/$MODULE" \
  "${SOURCES[@]}"

# ── Info.plist ───────────────────────────────────────────────────────────────────────────────
# NSExtensionPointIdentifier is what makes macOS treat this bundle as an App Intents extension.
# Without it the .appex is embedded, signed, shipped — and never loaded.
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$MODULE</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Bimax Intents</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>$DEPLOY</string>
  <!-- EXAppExtensionAttributes is what marks this as an ExtensionKit extension. App Intents
       extensions use the ExtensionKit shape, not the older NSExtension one; with the wrong key
       the bundle is embedded, signed and shipped, and never loaded. -->
  <key>EXAppExtensionAttributes</key>
  <dict>
    <key>EXExtensionPointIdentifier</key><string>com.apple.appintents-extension</string>
  </dict>
</dict>
</plist>
PLIST

# ── App Intents metadata ─────────────────────────────────────────────────────────────────────
# Ships with Xcode only, and is not license-gated, so it is called by path. This is the step whose
# absence makes every intent invisible while the build stays green.
PROCESSOR="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/appintentsmetadataprocessor"
if [ ! -x "$PROCESSOR" ]; then
  echo "app intents: FAILED — appintentsmetadataprocessor not found at $PROCESSOR" >&2
  echo "  It ships with Xcode. Without it the extension cannot expose a single action, so this" >&2
  echo "  build is not shippable and is refused rather than packaged silently." >&2
  exit 1
fi
printf '%s\n' "${SOURCES[@]}" > "$WORK/sources.txt"
printf '%s\n' "$CONSTVALUES" > "$WORK/constvalues.txt"

"$PROCESSOR" \
  --output "$OUT/Contents/Resources" \
  --toolchain-dir "$DEVDIR/Toolchains/XcodeDefault.xctoolchain" \
  --module-name "$MODULE" \
  --sdk-root "$SDK" \
  --xcode-version "$(DEVELOPER_DIR="$DEVDIR" xcodebuild -version 2>/dev/null | tail -1 | awk '{print $3}' || echo 16A242d)" \
  --platform-family macOS \
  --deployment-target "$DEPLOY" \
  --target-triple "$TARGET" \
  --source-file-list "$WORK/sources.txt" \
  --swift-const-vals-list "$WORK/constvalues.txt" \
  --force

# ── prove the deliverable exists ─────────────────────────────────────────────────────────────
META="$OUT/Contents/Resources/Metadata.appintents"
if [ ! -d "$META" ]; then
  echo "app intents: FAILED — no Metadata.appintents was produced." >&2
  echo "  The Swift compiled, so this build would otherwise be green and expose nothing." >&2
  exit 1
fi
# The payload is extract.actionsdata, NOT a .json — a directory listing alone proves nothing,
# because the processor happily writes an EMPTY bundle when the const values are missing. Assert on
# the intent identifiers actually inside it.
NAMED="$(python3 -c "
import json,sys
found=set()
def walk(o):
    if isinstance(o,dict):
        if isinstance(o.get('identifier'),str): found.add(o['identifier'])
        for v in o.values(): walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(json.load(open('$META/extract.actionsdata')))
print(' '.join(sorted(i for i in found if 'Bimax' in i)))
" 2>/dev/null)"
for REQUIRED in StartBimaxTask FindBimaxChanges BimaxThreadQuery BimaxChangeQuery; do
  case " $NAMED " in
    *" $REQUIRED "*) ;;
    *) echo "app intents: FAILED — $REQUIRED is missing from the exported metadata." >&2
       echo "  Exported: ${NAMED:-<nothing>}" >&2
       echo "  An entity or intent that does not export is invisible to Siri, Shortcuts and" >&2
       echo "  Spotlight, and nothing else in the build would notice." >&2
       exit 1 ;;
  esac
done
if [ -z "$NAMED" ]; then
  echo "app intents: FAILED — metadata was written but names no intent." >&2
  echo "  The Swift compiled and linked, so this build would otherwise be green and expose nothing." >&2
  echo "  Usually the const-values file was empty: -emit-const-values-path needs -wmo." >&2
  ls -la "$META" >&2
  exit 1
fi

echo "app intents → $OUT ($ARCH)"
echo "  intents: $NAMED"
