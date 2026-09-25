#!/usr/bin/env bash
# Compiles God's Land's notch helper (native/notch/main.swift + the vendored DynamicNotchKit, MIT) into
# notch/bimax-notch, which electron-builder packages as an extraResource. docs/product-reset/gods-land/03_PLAN.md.
#
# Same toolchain rule as build-voice.sh: prefer Xcode, and fall back to the Command Line Tools when Xcode refuses
# (an unaccepted licence after every Xcode update). The vendored sources were changed so the Command Line Tools can
# build them — they lack Xcode's SwiftUI macro plugins (see native/notch/Vendor/DynamicNotchKit/BIMAX_CHANGES.md).
# Targets macOS 13, like the app. After compiling it runs the helper's --selftest (parser and geometry) and fails the
# build if that fails.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-arm64}"
if [ "$(uname)" != "Darwin" ]; then
  echo "notch helper: skipped (macOS only)"
  exit 0
fi
mkdir -p notch
sources=(native/notch/main.swift)
while IFS= read -r file; do sources+=("$file"); done < <(find native/notch/Vendor -name '*.swift' | sort)
compile() { xcrun swiftc -O -swift-version 5 -parse-as-library -target "$ARCH-apple-macos13.0" "${sources[@]}" -o notch/bimax-notch.tmp; }
if ! compile 2>/tmp/bimax-notch-build.log; then
  if [ -x /Library/Developer/CommandLineTools/usr/bin/swiftc ]; then
    echo "notch helper: Xcode toolchain refused ($(head -1 /tmp/bimax-notch-build.log)); using Command Line Tools"
    DEVELOPER_DIR=/Library/Developer/CommandLineTools compile
  else
    cat /tmp/bimax-notch-build.log >&2
    exit 1
  fi
fi
if [ "$ARCH" = "$(uname -m)" ]; then
  notch/bimax-notch.tmp --selftest >/dev/null || { echo "notch helper: --selftest failed" >&2; exit 1; }
fi
mv notch/bimax-notch.tmp notch/bimax-notch
echo "notch helper → notch/bimax-notch ($ARCH)"
