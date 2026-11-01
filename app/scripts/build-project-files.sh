#!/usr/bin/env bash
# App-only descriptor-relative filesystem helper. No native automation or permission ownership.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-$(uname -m)}"
case "$ARCH" in arm64) ;; x64|x86_64) ARCH=x86_64 ;; *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; esac
mkdir -p project-files
# POSIX Linux builds exercise the same primitive in CI; Mac remains the shipped product.
if [ "$(uname)" = Linux ]; then
  "${CC:-cc}" -O2 -Wall -Wextra -Werror native/project-files/main.c -o "project-files/bimax-project-files.$$.tmp"
  mv "project-files/bimax-project-files.$$.tmp" project-files/bimax-project-files
  exit 0
fi
if [ "$(uname)" != Darwin ]; then echo 'project-files helper requires macOS or POSIX Linux checks' >&2; exit 1; fi
BIMAX_FILES_DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
BIMAX_FILES_SDK="$(DEVELOPER_DIR="$BIMAX_FILES_DEVELOPER_DIR" xcrun --sdk macosx --show-sdk-path)"
BIMAX_FILES_CC="$(DEVELOPER_DIR="$BIMAX_FILES_DEVELOPER_DIR" xcrun --find clang)"
"$BIMAX_FILES_CC" -isysroot "$BIMAX_FILES_SDK" -target "$ARCH-apple-macos13.0" -O2 -Wall -Wextra -Werror \
  native/project-files/main.c -o "project-files/bimax-project-files.$$.tmp"
mv "project-files/bimax-project-files.$$.tmp" project-files/bimax-project-files
