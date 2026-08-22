#!/usr/bin/env bash
# Stage Desktop-owned native components. Kept separate from engine consumption so a Desktop build
# never needs Terminal engine source; Phase 4 moves this native tree into the Desktop repository.
set -euo pipefail
cd "$(dirname "$0")/.."
DESKTOP_ROOT="$PWD"
REPO="$(git -C "$DESKTOP_ROOT" rev-parse --show-toplevel)"
target="${1:-darwin-$(uname -m)}"
case "$target" in
  darwin-arm64) arch=arm64; provider_target=bun-darwin-arm64 ;;
  darwin-x64) arch=x64; provider_target=bun-darwin-x64 ;;
  *) echo "error: target must be darwin-arm64 or darwin-x64" >&2; exit 1 ;;
esac

rm -rf native-service
echo "Bimax-Cu Service → native-service/BimaxCuService.xpc …"
( cd "$REPO" && "$DESKTOP_ROOT/scripts/computer-use/stage-bimax-cu-service.sh" darwin "$arch" "$DESKTOP_ROOT/native-service" )
[ -x native-service/BimaxCuService.xpc/Contents/MacOS/bimax-cu-service ] || { echo "error: XPC service was not staged" >&2; exit 1; }
[ -x native-service/bimax-cu-bridge ] || { echo "error: signed CU bridge was not staged" >&2; exit 1; }
echo "Desktop helper → native-service/bimax-desktop-helper …"
( cd "$DESKTOP_ROOT" && bun scripts/computer-use/stage-desktop-helper.ts darwin "$arch" native-service/bimax-desktop-helper )
[ -x native-service/bimax-desktop-helper ] || { echo "error: desktop helper was not staged" >&2; exit 1; }
echo "Live target preview → native-service/bimax-live-pip …"
( cd "$REPO" && "$DESKTOP_ROOT/scripts/computer-use/stage-live-pip.sh" darwin "$arch" )
[ -x native-service/bimax-live-pip ] || { echo "error: live target preview was not staged" >&2; exit 1; }
echo "Mac capability provider → native-service/bimax-mac-capability …"
( cd "$DESKTOP_ROOT" && bun build --compile --target="$provider_target" src/capabilities/mac/provider.entry.ts --outfile native-service/bimax-mac-capability )
[ -x native-service/bimax-mac-capability ] || { echo "error: mac capability provider was not staged" >&2; exit 1; }
