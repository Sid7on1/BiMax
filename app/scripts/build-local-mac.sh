#!/usr/bin/env bash
# Build a LOCAL, runnable Bimax.app on this machine.
#
# `npm run dist:mac` targets a release: it refuses a local engine and produces a hardened bundle for
# notarization. Neither is right for a build you intend to run here, and two failures on 2026-08-15
# proved it — both silent until launch.
#
#   1. HARDENED RUNTIME + A SELF-SIGNED CERT CANNOT RUN.
#      electron-builder.yml assumes "keyless local builds remain unsigned". Once the self-signed
#      "Bimax Local Code Signing" identity exists in the keychain that stops being true:
#      auto-discovery signs with it AND applies `hardenedRuntime: true`. Hardened runtime enforces
#      library validation, which requires every loaded library to share the process's Team ID — and
#      a self-signed cert has none. The app dies in dyld before any of its own code runs:
#        Library not loaded: @rpath/Electron Framework.framework/Electron Framework
#        ... (non-platform) have different Team IDs
#      Hardening only exists to enable notarization, which a self-signed build can never obtain, so
#      it is turned off here rather than defeated with disable-library-validation — that entitlement
#      would weaken the real Developer ID release too.
#
#   2. THE OUTPUT DIRECTORY MUST NOT BE INSIDE ICLOUD.
#      This repo lives under a synced Desktop. The file provider stamps `com.apple.FinderInfo` and
#      `com.apple.fileprovider.fpfs#P` onto bundle DIRECTORIES as it syncs, and `codesign` rejects
#      them outright ("resource fork, Finder information, or similar detritus not allowed"). It
#      re-applies them faster than a pre-signing sweep can strip them, so the only reliable fix is
#      to build somewhere unsynced. scripts/after-pack.cjs still clears what it can.
#
# Release builds are unaffected: they use dist:mac, a Developer ID identity, and stay hardened.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"
OUT="${BIMAX_LOCAL_BUILD_DIR:-/private/tmp/bimax-build/release}"

case "$ARCH" in arm64) target=darwin-arm64 ;; x64) target=darwin-x64 ;; *) echo "usage: $0 [arm64|x64]" >&2; exit 1 ;; esac
case "$OUT" in "$PWD"/*|"$HOME"/Desktop/*|"$HOME"/Documents/*) echo "error: output dir is inside the synced tree: $OUT" >&2; exit 1 ;; esac

echo "→ renderer + main"
npx electron-vite build

echo "→ engine"
#
# THE ENGINE IS THIS REPO'S OWN SOURCE, BUILT HERE.
#
# It used to be a versioned binary input: an earlier script compiled ../src/index.ts inline, that was
# replaced by consuming a published `bun --compile` artifact, and the path of last resort downloaded
# the release engine.lock.json pinned. That lock pinned v1.1.0 of Sid7on1/bimax-releases, which was
# never published — and because GitHub answers 404 for "asset missing" and "no permission" alike, the
# failure read as an auth problem and sent people hunting for a token they did not need.
#
# There is no binary and no download any more. prepare-engine.sh bundles ../src/index.ts to
# app/engine/index.js (23 MB, ~0.3s) and Electron's own Node runs it in a utilityProcess. The bundle
# is architecture-independent, so `target` no longer selects anything here.
bash scripts/prepare-engine.sh "$target"

# Run the artifact this build is about to ship, and refuse to package one that cannot answer. Reading
# a script to check what it says is not the same as executing what it produced — that gap is how a
# sidecar stub that exited 1 got shipped in v1.1.0 with every gate green.
npx electron scripts/verify-engine.js

# Computer Use staging removed 2026-09-04. Bimax has shipped code-only since the 2026-09-02 reset,
# and electron-builder.yml declares no `mac.extraFiles`, so the four binaries prepare-native.sh
# built (BimaxCuService.xpc, bimax-cu-bridge, bimax-desktop-helper, bimax-mac-capability) were
# compiled and then never packaged. The script also `rm -rf`s native-service/ BEFORE compiling, so a
# CU build failure destroyed the staged directory on the release path — a failure mode the product
# no longer has any reason to carry. scripts/prepare-native.sh remains on disk, unreferenced.

echo "→ voice helper"
bash scripts/build-voice.sh "$ARCH"

# The App Intents extension (WP-9 step 3). electron-builder.yml embeds it at Contents/PlugIns via
# `extraFiles`; without this step that path does not exist and the packaging gate below fails —
# which is the intended order. Every action macOS, Siri and Shortcuts can see comes from here.
echo "→ app intents extension"
bash scripts/build-intents.sh "$ARCH"

echo "→ package app directory (unhardened, outside iCloud)"
[ ! -e "$OUT" ] || { echo "error: refusing to overwrite existing local build output: $OUT" >&2; exit 1; }
npx electron-builder --mac "--$ARCH" --dir \
  -c.directories.output="$OUT" \
  -c.mac.hardenedRuntime=false \
  -c.mac.identity=null

APP="$OUT/mac-$ARCH/Bimax.app"
echo "→ local nested signing (stable local identity when available; no hardened runtime)"
node scripts/sign-local-mac.mjs "$APP"
echo "→ verify"
codesign --verify --deep --strict "$APP"
node ../scripts/verify-desktop-package.mjs "$APP" "$ARCH"
# Does the BUILT bundle actually expose the actions Bimax claims? The bimax:// scheme, the App
# Intents extension's metadata, and the engine — all checked against the artifact, never the source.
node scripts/check-app-actions.mjs --app "$APP"
echo "Built → $APP"
