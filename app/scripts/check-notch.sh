#!/usr/bin/env bash
# The notch helper's on-screen checks (docs/product-reset/gods-land/03_PLAN.md):
#   clickthrough-check — a click beside the notch always reaches the window under it; hover opens, leaving closes;
#   shelf-check        — a real drag of a file onto the notch is kept; the card drags back out as the same file.
# THEY MOVE THE CURSOR AND DRAG. Run them deliberately, hands off the mouse and trackpad (about 40 s) — a person using
# the Mac at the same time moves the same cursor and makes the result meaningless. Never in CI. Needs Accessibility
# for the terminal (to post events). Builds the helper first.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build-notch.sh "$(uname -m)"
dir="$(mktemp -d)"
for check in clickthrough-check shelf-check; do
  compile() { xcrun swiftc -O -target "$(uname -m)-apple-macos13.0" "scripts/notch/$check.swift" -o "$dir/$check"; }
  compile 2>/dev/null || DEVELOPER_DIR=/Library/Developer/CommandLineTools compile
done
echo "Hands off the mouse and trackpad: the checks start in 5 seconds and take about 40."
sleep 5
status=0
for check in clickthrough-check shelf-check; do
  echo "== $check"
  "$dir/$check" "$(pwd)/notch/bimax-notch" || status=1
done
exit $status
