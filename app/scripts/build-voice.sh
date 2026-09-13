#!/usr/bin/env bash
# Compiles the on-device dictation helper (native/voice/main.swift) into voice/bimax-voice, which electron-builder
# packages as an extraResource. It targets macOS 13 so it launches anywhere the app does, and reports that
# dictation is unavailable before macOS 26 (SpeechAnalyzer) instead of failing to load.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-arm64}"
if [ "$(uname)" != "Darwin" ]; then
  echo "voice helper: skipped (macOS only)"
  exit 0
fi
mkdir -p voice
xcrun swiftc -O -swift-version 5 -parse-as-library -target "$ARCH-apple-macos13.0" native/voice/main.swift -o voice/bimax-voice.tmp
mv voice/bimax-voice.tmp voice/bimax-voice
echo "voice helper → voice/bimax-voice ($ARCH)"
