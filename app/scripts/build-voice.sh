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
compile() { xcrun swiftc -O -swift-version 5 -parse-as-library -target "$ARCH-apple-macos13.0" native/voice/main.swift -o voice/bimax-voice.tmp; }
# Every Xcode update resets the license agreement, and until someone runs `sudo xcodebuild -license`
# EVERY xcrun through /Applications/Xcode.app refuses — which stops this whole local build at a step
# that has nothing to do with Xcode. The Command Line Tools carry their own swiftc and no such gate,
# and they build this file identically, so fall back to them instead of asking for a password.
if ! compile 2>/tmp/bimax-voice-build.log; then
  if [ -x /Library/Developer/CommandLineTools/usr/bin/swiftc ]; then
    echo "voice helper: Xcode toolchain refused ($(head -1 /tmp/bimax-voice-build.log)); using Command Line Tools"
    DEVELOPER_DIR=/Library/Developer/CommandLineTools compile
  else
    cat /tmp/bimax-voice-build.log >&2
    exit 1
  fi
fi
mv voice/bimax-voice.tmp voice/bimax-voice
echo "voice helper → voice/bimax-voice ($ARCH)"
