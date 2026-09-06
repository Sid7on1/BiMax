#!/usr/bin/env bash
# Install a locally-signed Bimax DMG onto a Mac that is NOT the build machine.
#
# WHY THIS IS NEEDED
# The DMG is signed with a self-signed identity ("Bimax Local Code Signing"), not an Apple
# Developer ID, and it is not notarized. Two different checks get confused here:
#
#   codesign --verify   asks "is the seal intact and does it satisfy its Designated Requirement?"
#                       It reads the certificate embedded IN the signature and never consults the
#                       keychain — so it PASSES on any Mac. Measured on the shipped bundle.
#   spctl / Gatekeeper  asks "does this chain to an Apple-trusted anchor?" It does NOT, and never
#                       will without a $99/yr Developer ID plus notarization. Measured: `rejected`.
#
# Gatekeeper only evaluates files carrying `com.apple.quarantine`, which is stamped on by whatever
# transferred the DMG (AirDrop, a browser download, Mail). Removing that attribute takes Gatekeeper
# out of the path; the still-valid signature is what the OS then enforces. That is the whole fix.
#
# On macOS 15+ the old right-click -> Open bypass is gone, so this script is the reliable route.
#
# USAGE (on the target Mac):
#   bash install-on-target-mac.sh /path/to/Bimax-INSTALLED-2026-09-03.dmg
#
# Requires an administrator password only for the copy into /Applications.
# BIMAX_INSTALL_DIR overrides the destination — set it to a writable directory to exercise this
# script end-to-end without touching /Applications or prompting for a password. The verification
# steps below are identical either way, which is the point: an installer nobody can run in a test
# is an installer whose failure is only ever discovered on the demo machine.
set -euo pipefail

DMG="${1:-}"
APP_NAME="Bimax.app"
INSTALL_DIR="${BIMAX_INSTALL_DIR:-/Applications}"
DEST="${INSTALL_DIR}/${APP_NAME}"

# Only escalate when the destination actually needs it.
if [ -w "$INSTALL_DIR" ]; then SUDO=""; else SUDO="sudo"; fi

if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "usage: bash $(basename "$0") /path/to/Bimax.dmg" >&2
  exit 2
fi
[ "$(uname -s)" = Darwin ] || { echo "error: macOS only" >&2; exit 1; }

echo "==> mounting $(basename "$DMG")"
# -nobrowse keeps it out of Finder; the mountpoint is parsed from hdiutil's own plist rather than
# guessed from the volume name, which differs between builds.
MOUNT="$(mktemp -d /tmp/bimax-install.XXXXXX)"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null
cleanup() { hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true; }
trap cleanup EXIT

SRC="${MOUNT}/${APP_NAME}"
[ -d "$SRC" ] || { echo "error: ${APP_NAME} not found in the DMG" >&2; exit 1; }

mkdir -p "$INSTALL_DIR"
echo "==> copying to ${DEST}"
if [ -e "$DEST" ]; then
  echo "    (replacing the existing install)"
  $SUDO rm -rf "$DEST"
fi
# -R preserves the bundle; ditto would also copy the quarantine xattr, which we strip next anyway.
$SUDO cp -R "$SRC" "$DEST"

echo "==> stripping quarantine (this is the step Gatekeeper cares about)"
$SUDO xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "==> verifying the signature survived the copy"
if ! codesign --verify --deep --strict "$DEST" 2>/dev/null; then
  echo "FAIL: the signature does not verify after copying. Do not launch this build." >&2
  codesign --verify --deep --strict --verbose=2 "$DEST" 2>&1 | tail -5 >&2
  exit 1
fi
echo "    signature: valid on disk, satisfies its Designated Requirement"

echo "==> verifying the bundled engine is present and executable"
ENGINE="${DEST}/Contents/Resources/engine/bimax-engine"
[ -x "$ENGINE" ] || { echo "FAIL: engine missing or not executable at ${ENGINE}" >&2; exit 1; }
codesign --verify "$ENGINE" 2>/dev/null || { echo "FAIL: engine signature invalid" >&2; exit 1; }
echo "    engine: $(stat -f %z "$ENGINE") bytes, signed"

# Gatekeeper is EXPECTED to say "rejected" here — that is the unnotarized signature, not a defect,
# and it no longer gates launch because the quarantine attribute is gone. Reported so the operator
# sees it and is not alarmed when they run spctl themselves.
echo "==> Gatekeeper assessment (expected: rejected — see the header comment)"
spctl -a -t exec -vv "$DEST" 2>&1 | sed 's/^/    /' || true

echo
echo "Installed. Launch with:  open -a Bimax"
echo "If macOS still refuses, open System Settings > Privacy & Security and click 'Open Anyway'."
