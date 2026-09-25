#!/usr/bin/env bash
# The notch helper's on-screen check: a click beside the notch always reaches the window under it (resting and open),
# hover opens it and leaving closes it. MOVES THE CURSOR — run it deliberately, not in CI. See
# scripts/notch/clickthrough-check.swift. Builds the helper first.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build-notch.sh "$(uname -m)"
out="$(mktemp -d)/clickthrough-check"
compile() { xcrun swiftc -O -target "$(uname -m)-apple-macos13.0" scripts/notch/clickthrough-check.swift -o "$out"; }
compile 2>/dev/null || DEVELOPER_DIR=/Library/Developer/CommandLineTools compile
"$out" "$(pwd)/notch/bimax-notch"
